"""核身知识库种子脚本 —— 将 TS 侧核身排障知识库迁移至 Python 数据库。

对应 TS: scripts/seed-identity-kb.ts

用法:
    cd apps/server-py
    uv run python scripts/seed_identity_kb.py

幂等：重复运行不会创建重复数据。
"""

import asyncio
import sys
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession

from src.config import settings

# 确保 Windows 终端正确输出中文
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# ── 核身知识库定义 ──────────────────────────────────────────────
IDENTITY_KB_ID = "kb-identity-0001"
IDENTITY_KB_NAME = "核身排障知识库"
IDENTITY_KB_DESC = "身份核身诊断专用知识库，包含错误码排查手册、商户配置指南、SDK集成文档和应急响应预案"

IDENTITY_DOCS: list[dict[str, str]] = [
    {
        "title": "核身错误码排查手册 — FACE_TIMEOUT",
        "content": """错误码 FACE_TIMEOUT 排查手册

错误码名称：FACE_TIMEOUT（人脸采集超时）
所属产品：人脸核身（face_verify）、活体检测（liveness）
常见端类型：H5、小程序、App

一、原因分析
FACE_TIMEOUT 表示人脸采集阶段超过预设时间限制（默认 10 秒）。常见原因包括：
1. 用户网络状况差，摄像头视频流传输延迟过高。
2. 设备摄像头权限未授予或摄像头被其他应用占用。
3. 低端设备处理能力不足，视频帧处理耗时过长。
4. SDK 版本过旧，采集超时配置不合理或存在已知 bug。
5. H5 场景下浏览器兼容性问题，部分浏览器不支持 WebRTC 或 getusermedia 接口。
6. 动作活体检测时用户未按要求完成指定动作（眨眼、张嘴等），导致超时。

二、排查步骤
1. 检查用户设备网络状态：通过 trace 日志确认上行带宽和 RTT。建议 Wi-Fi 环境下重试。
2. 检查摄像头权限：H5 需要 HTTPS 才能使用摄像头；App 需要相册权限声明；小程序需在 app.json 中配置 camera 组件权限。
3. 检查 SDK 版本：确认接入方使用的 SDK 版本是否 >= 3.1.0（该版本优化了超时处理逻辑）。
4. 按端类型拆分：H5 查 WebRTC 兼容性；小程序查 camera 组件权限；App 查原生相机权限。
5. 查询 trace 日志确认具体耗时阶段：请求建立 → 摄像头初始化 → 活体动作 → 视频上传 → 后端检测。定位瓶颈阶段。

三、处理方案
1. 短期：引导用户切换网络环境，关闭其他占用摄像头的应用后重试。
2. 中期：接入方升级 SDK 到 3.1.0+，调整超时配置（如需延长超时时间）。
3. 长期：接入方启用降级方案（如人脸比对模式替代活体模式）以应对复杂网络环境。

四、参考数据
- 正常环境下 FACE_TIMEOUT 发生率应低于 2%。
- 高峰期（晚 8-10 点）超时率可能因网络拥塞升至 5%，属正常波动。
- 如超时率突增超过 10%，优先排查网络侧或 SDK 版本变更。""",
    },
    {
        "title": "核身错误码排查手册 — LIVENESS_FAIL",
        "content": """错误码 LIVENESS_FAIL 排查手册

错误码名称：LIVENESS_FAIL（活体检测失败）
所属产品：活体检测（liveness）
常见端类型：H5、小程序、App

一、原因分析
LIVENESS_FAIL 表示活体检测引擎判定当前采集行为非活体操作。常见原因：
1. 用户使用照片、视频、面具等非活体材料进行攻击。
2. 环境光线过强或过暗，导致动作检测特征提取失败。
3. 摄像头遮挡或模糊，无法正常采集人脸视频。
4. 用户离摄像头过远或过近，人脸占比不符合检测要求。
5. 多人同时出现在采集框中，引擎无法锁定目标人脸。
6. 设备存在虚拟摄像头或录屏软件干扰。

二、排查步骤
1. 确认是否为攻击行为：查询该用户历史失败次数和同设备关联账号数量。如单设备多账号频繁失败，大概率是攻击。
2. 检查环境光线：通过 trace 截图确认画面亮度和人脸清晰度。
3. 检查人脸占比：确认人脸在画面中占比是否在 30%-70% 范围内。
4. 检查是否存在虚拟摄像头：App 端可调用设备检测接口确认摄像头硬件信息。
5. 按动作拆分：确认是单一动作失败还是整个动作序列失败。单一动作失败可能是光线/角度问题；全序列失败可能是攻击或摄像头问题。

三、处理方案
1. 确认攻击行为：对该设备标记风险，建议接入方启用增强活体（多动作组合 + 闪烁光检测）。
2. 光线问题：引导用户到光线均匀的环境，避免逆光和强侧光。
3. 距离问题：提示用户将人脸对准取景框，保持 30-50cm 距离。
4. SDK 建议：升级到支持 3D 结构光活体的 SDK 版本以提升安全性。

四、参考数据
- 正常场景：活体通过率应在 90% 以上。
- 光线良好环境：通过率可达到 95%+。
- 如通过率低于 70%，需排查是否为攻击高峰或 SDK 配置问题。""",
    },
    {
        "title": "核身错误码排查手册 — NETWORK_TIMEOUT",
        "content": """错误码 NETWORK_TIMEOUT 排查手册

错误码名称：NETWORK_TIMEOUT（网络超时）
所属产品：人脸核身（face_verify）、活体检测（liveness）、OCR 识别（ocr）
常见端类型：H5、小程序、App、Web

一、原因分析
NETWORK_TIMEOUT 表示客户端与服务端之间的网络请求超时。常见原因：
1. 用户网络环境差，上行带宽不足或延迟过高。
2. 客户端与接入点之间的链路存在丢包。
3. 服务端过载，请求排队时间过长。
4. 视频/图片上传阶段耗时超过预设超时阈值。
5. DNS 解析异常或 CDN 节点不可达。
6. 移动端弱网环境（电梯、地下室、地铁等）。

二、排查步骤
1. 通过 trace 日志确认 RTT 和丢包率。RTT > 200ms 或丢包率 > 5% 时优先排查网络。
2. 确认客户端使用的网络类型：Wi-Fi / 4G / 5G。4G 弱信号场景超时率显著偏高。
3. 检查服务端在该时段的请求量和响应时间。服务端 P95 延迟 > 3s 需关注。
4. 确认接入点配置：是否使用了最近的 CDN 节点，DNS 解析是否正常。
5. 检查上传文件大小：图片 > 2MB 或视频 > 10MB 时建议先做客户端压缩。

三、处理方案
1. 客户端增加网络探测逻辑：在开始采集前检测网络质量，弱网时提示用户切换网络。
2. 服务端扩容：如超时集中在业务高峰期，需增加接入节点或启用弹性扩容。
3. 图片/视频压缩：客户端上传前将图片压缩至 1MB 以内，视频码率降低至 1Mbps 以下。
4. 超时重试：客户端实现指数退避重试，避免瞬时网络抖动导致失败。

四、参考数据
- 正常环境超时率：< 1%
- 移动弱网环境超时率：5%-15%（属业务正常范围）
- 如 Wi-Fi 环境超时率突增 > 5%，排查 CDN 和服务端。""",
    },
    {
        "title": "核身错误码排查手册 — SDK_VERSION_TOO_OLD",
        "content": """错误码 SDK_VERSION_TOO_OLD 排查手册

错误码名称：SDK_VERSION_TOO_OLD（SDK 版本过旧）
所属产品：核身全系列
常见端类型：H5、小程序、App

一、原因分析
当前接入方使用的核身 SDK 版本低于服务端最低支持版本。常见原因：
1. 接入方长期未更新 SDK，版本发布时间超过 6 个月。
2. 服务端升级了检测算法和接口协议，旧版本 SDK 不兼容。
3. 接入方使用了非官方渠道下载的 SDK 版本。
4. 接入方依赖的 SDK 子模块（如活体检测模块、OCR 模块）版本不一致。

二、影响范围
- 可能导致接口调用失败、功能不可用、安全漏洞。
- 旧版本可能存在已知的崩溃和内存泄漏问题。
- 无法使用最新的安全检测能力（如 3D 活体、多光谱检测）。

三、处理方案
1. 升级到最新稳定版 SDK（当前推荐版本 3.1.8+）。
2. 查看 SDK 升级指南和 Changelog，确认是否有 API 不兼容变更。
3. 升级后按灰度策略逐步放量（10% → 50% → 100%），监控通过率变化。
4. H5 SDK 注意版本号在初始化 URL 参数中指定，小程序 SDK 注意 appId 绑定。

四、版本支持策略
- 当前最低支持版本：3.0.0
- 当前推荐版本：3.1.8
- 2.x 系列：2025-12-31 停止支持
- 1.x 系列：已停止支持""",
    },
    {
        "title": "核身错误码排查手册 — CAMERA_PERMISSION_DENIED",
        "content": """错误码 CAMERA_PERMISSION_DENIED 排查手册

错误码名称：CAMERA_PERMISSION_DENIED（摄像头权限拒绝）
所属产品：人脸核身（face_verify）、活体检测（liveness）
常见端类型：H5、小程序、App

一、原因分析
用户拒绝或未授予摄像头权限，导致无法发起人脸采集。常见原因：
1. 用户首次使用时点击了浏览器的"拒绝"按钮。
2. 浏览器/系统级权限设置中摄像头权限被关闭。
3. H5 页面非 HTTPS，浏览器禁止调用摄像头 API。
4. 小程序未在 app.json 中声明 camera 权限。
5. Android 6.0+ / iOS 14+ 需要动态请求权限，接入方未适配。
6. 企业浏览器的安全策略禁止摄像头访问。
7. 浏览器版本过低不支持 getUserMedia / WebRTC。

二、排查步骤
1. 确认页面协议：H5 必须使用 HTTPS（localhost 除外）。检查是否因 HTTP 降级导致权限不可用。
2. 确认浏览器权限状态：Chrome 地址栏锁图标 → 网站设置 → 摄像头权限。检查是否设置为"阻止"。
3. 确认系统级权限：Windows 隐私设置 → 相机；macOS 系统偏好设置 → 安全性与隐私 → 相机。
4. 小程序：确认 app.json 中已配置"permission":{"scope.camera":{"desc":"用于人脸识别"}}。
5. App：确认 Info.plist（iOS）和 AndroidManifest.xml（Android）中已声明相机权限。
6. 检查浏览器兼容性：IE 不支持 WebRTC；iOS WebView 需 WKWebView。

三、处理方案
1. 产品侧：在进入核身页面时提供权限引导 UI，告知用户"需要摄像头权限才能完成人脸识别"。
2. 技术侧：在调用 getusermedia 前先通过 Permissions API 查询权限状态，如已拒绝则展示引导文案。
3. 降级方案：如用户确实无法授予摄像头权限，可引导使用手动输入身份信息 + 人工审核的备用流程。
4. 监控：对 CAMERA_PERMISSION_DENIED 错误率单独监控，区分"用户主动拒绝"和"浏览器不支持"两种场景。

四、参考数据
- H5 场景权限拒绝率通常在 3-8%，取决于用户对隐私的敏感程度。
- 如权限拒绝率突然升至 20%+，排查是否为 HTTPS 证书问题或域名变更。""",
    },
    {
        "title": "商户核身接入配置指南",
        "content": """商户核身接入配置指南

一、接入流程
1. 注册商户账号并完成企业实名认证。
2. 在控制台创建应用，获取 AppId 和 AppSecret。
3. 配置核身产品：选择需要的产品（人脸核身、活体检测、OCR 识别等）。
4. 下载并集成 SDK：根据端类型选择对应 SDK（H5 / 小程序 / App / Server）。
5. 沙箱测试：在测试环境完成全流程联调，验证通过率和错误处理。
6. 生产发布：提交上线审核，审核通过后切换到生产环境。

二、关键配置项
1. 活体检测策略：静默活体（默认）/ 动作活体 / 光线活体。静默活体用户无感但安全性中等；动作活体安全性高但用户体验差。
2. 超时时间：默认 10 秒，可根据业务场景调整（5-30 秒）。
3. 人脸质量阈值：默认 0.5，值越高对图片质量要求越严格。
4. 安全等级：L1（宽松）/ L2（标准）/ L3（严格）。金融场景建议 L3。
5. 回调地址：核身结果异步通知 URL，需支持 HTTPS POST。
6. 白名单 IP：服务端 API 调用的出口 IP，需在控制台配置。

三、常见配置问题
1. AppId 与 SDK 版本不匹配：确认控制台中 AppId 对应的产品已启用。
2. 回调地址不可达：确认回调 URL 可被公网访问，且未设置 IP 白名单限制。
3. 安全等级过高导致通过率低：新商户建议从 L2 开始，根据业务数据逐步调高。
4. 人脸质量阈值设置过高：建议从默认 0.5 开始，观察通过率后微调。""",
    },
    {
        "title": "商户核身通过率优化指南",
        "content": """商户核身通过率优化指南

一、通过率基线
- 优秀：通过率 >= 92%
- 正常：通过率 85%-92%
- 需关注：通过率 70%-85%
- 严重：通过率 < 70%

二、常见通过率下降原因及排查优先级
优先级 P0（需立即处理）：
1. SDK 版本过旧导致兼容性问题。
2. 服务端异常或接口超时率突增。
3. 证书过期或 HTTPS 配置错误。

优先级 P1（24小时内处理）：
4. 端侧网络环境变化（如新增海外用户导致延迟升高）。
5. 新增端类型或浏览器带来的兼容性问题。
6. 业务量突增导致服务端资源不足。

优先级 P2（纳入迭代优化）：
7. 特定机型或系统版本兼容性差。
8. 用户操作引导不够清晰导致误操作率高。
9. 光线/环境因素影响（季节性变化）。

三、优化建议
1. 按端类型拆分监控：H5 / 小程序 / App 分别建立通过率看板。
2. 按错误码拆分：确认 TOP 5 错误码的占比趋势，优先解决占比最高的。
3. A/B 测试 SDK 版本：灰度发布新版本观察通过率变化，确认提升后全量。
4. 建立商户维度的监控大盘：核心指标包括请求量、通过率、平均耗时、TOP 错误码。
5. 异常告警：通过率环比下降超过 5 个百分点时自动告警。""",
    },
    {
        "title": "H5 核身 SDK 集成指南",
        "content": """H5 核身 SDK 集成指南

一、环境要求
- 页面协议：必须 HTTPS（localhost 除外）
- 浏览器支持：Chrome 70+、Safari 12+、Edge 79+、Firefox 70+
- 不支持：IE 全系列、UC 浏览器极速模式、部分安卓系统 WebView

二、快速接入
1. 在 HTML 中引入 SDK：
<script src="https://cdn.example.com/identity-sdk/3.1.8/h5-sdk.min.js"></script>

2. 初始化参数：
- appId：控制台获取的应用 ID
- env：sandbox（测试）或 production（生产）
- timeout：超时时间（毫秒），默认 10000
- securityLevel：安全等级 L1/L2/L3

3. 调用人脸核身接口：
- userId：用户唯一标识
- userName：用户姓名
- idCard：身份证号
- returnImage：是否返回采集图片

三、常见集成问题
1. 页面非 HTTPS → 浏览器禁止摄像头 → CAMERA_PERMISSION_DENIED
2. 未在控制台添加域名白名单 → 接口调用被拒绝 → DOMAIN_NOT_ALLOWED
3. iframe 内嵌导致权限传递失败 → 建议使用全屏模式或新窗口打开
4. iOS Safari 对 getusermedia 需用户交互触发 → SDK 需在点击事件回调中初始化
5. 跨域问题：CDN 域名需配置 CORS 头，允许页面域名访问

四、性能优化
1. 启用 SDK 预加载：在页面初始化阶段提前加载 wasm 模块。
2. 视频流分辨率自适应：根据网络带宽动态调整采集分辨率。
3. 失败重试：非安全类错误（网络超时、临时故障）自动重试 1 次。""",
    },
    {
        "title": "小程序核身 SDK 集成指南",
        "content": """小程序核身 SDK 集成指南

一、环境要求
- 微信小程序基础库 >= 2.19.0
- 支付宝小程序基础库 >= 2.7.0
- 需在 app.json 中声明 camera 权限

二、快速接入
1. npm 安装：npm install @identity/miniapp-sdk@3.1.8

2. app.json 权限配置：
{
  "permission": {
    "scope.camera": {
      "desc": "用于人脸识别验证身份"
    }
  }
}

3. 页面中调用：
- 引入 SDK：import IdentitySDK from '@identity/miniapp-sdk'
- 初始化：new IdentitySDK({ appId: 'your-app-id' })
- 调用核身：client.faceVerify({ userId: '123' })

三、常见集成问题
1. camera 权限未声明 → 小程序审核被拒或运行时无权限提示。
2. 基础库版本过低 → camera 组件部分属性不支持，导致采集异常。
3. 业务域名未配置 → 接口请求被拦截，需在小程序后台配置 request 合法域名。
4. 分包加载 SDK → 如使用分包，需注意 SDK 所在分包的加载时机。
5. 体验版和正式版 appId 不一致 → 需在控制台分别配置。

四、与 H5 的差异
1. 小程序 camera 组件由框架管理，无需处理 HTTPS 问题。
2. 权限申请由小程序框架自动弹出授权弹窗。
3. 视频帧获取方式不同：H5 用 getusermedia + canvas，小程序用 camera 组件 + CameraContext。
4. 小程序不支持 WebGL 加速，活体检测模型推理速度较 H5 慢 20%-30%。""",
    },
    {
        "title": "核身场景排查 — 批量失败应急响应",
        "content": """核身批量失败应急响应指南

一、批量失败的定义
5 分钟窗口内，以下任一指标触发告警：
- 全局通过率下降超过 10 个百分点
- 单商户通过率下降超过 20 个百分点
- 核心错误码（FACE_TIMEOUT / LIVENESS_FAIL / NETWORK_TIMEOUT）数量突增 3 倍以上

二、应急响应流程
第 1 步（1-3 分钟）：确认影响范围
- 查询受影响商户列表和用户数
- 确认受影响端类型（H5 / 小程序 / App）
- 确认是全局问题还是单商户问题
- 判断是否为服务端自身故障

第 2 步（3-10 分钟）：快速止血
- 服务端故障 → 触发回滚或扩容
- CDN 故障 → 切换备用 CDN 节点
- SDK 版本问题 → 建议商户临时降级到上一个稳定版本
- 证书过期 → 紧急更新证书并通知商户

第 3 步（10-30 分钟）：根因定位
- 按端类型、商户、错误码下钻分析
- 对比故障前后时间段的服务端指标
- 检查是否是外部依赖（CDN、DNS、云服务）故障
- 如为攻击行为，启动反欺诈应急策略

第 4 步（30 分钟+）：恢复与复盘
- 确认通过率恢复到基线水平
- 输出故障报告：时间线、根因、影响范围、改进措施
- 更新监控告警阈值，避免同类问题漏报

三、商户沟通模板
"尊敬的商户，我们监测到贵商户在 [时间段] 核身通过率出现异常下降，初步排查原因为 [X]。建议您 [处理建议]。如有疑问请联系技术支持，我们将持续关注恢复情况。"

四、监控大盘配置
- 全局视角：请求量趋势、通过率趋势、平均耗时趋势、TOP 5 错误码分布
- 商户视角：单商户通过率、请求量、错误分布、对比基线（7 日均值）
- 端视角：按 H5 / 小程序 / App 拆分的关键指标
- 告警规则：通过率环比下降 > 5pp、P95 延迟 > 5s、单错误码 > 100/min""",
    },
    {
        "title": "核身场景排查 — 活体通过率基线校准",
        "content": """活体检测通过率基线校准指南

一、基线的定义
基线是正常业务状态下的通过率期望值，用于判断当前通过率是否异常。基线应定期校准（建议每月一次），以适应业务和用户群的变化。

二、基线计算方式
1. 7 日滚动基线：过去 7 天同时段的通过率均值。最常用，能捕捉近期趋势。
2. 30 日滚动基线：过去 30 天同时段通过率均值。更平滑，不易受单日波动影响。
3. 周同比基线：上周同一天的通过率。适用于有明显周周期性的业务。

三、分维度基线
不同维度下的正常通过率差异较大，建议分别建立基线：
- 按端类型：H5（85-90%）< 小程序（90-95%）< App（92-97%）
- 按时段：工作时间（高于基线）vs 夜间（低于基线 1-3pp）
- 按产品：静默活体（88-93%）vs 动作活体（82-88%）
- 按安全等级：L1（90%+）vs L2（85-90%）vs L3（78-85%）

四、基线异常判定
- 警告阈值：当前通过率低于基线 3-5 个百分点
- 严重阈值：当前通过率低于基线 5 个百分点以上
- 单商户应额外设置绝对阈值：通过率低于 60% 直接告警（不受基线影响）

五、商户 10086 已知基线（示例）
- 产品：活体检测（liveness）
- 正常通过率：91.2%（近 7 日基线）
- 工作日上午：92.5%
- 警告阈值：< 88%
- 严重阈值：< 85%
- 常见波动原因：上午 9-10 点为业务高峰，超时率略高，通过率可能下降 2-3pp，属正常范围。""",
    },
]

# ── DDL：与 Prisma schema 对齐的表结构 ───────────────────────

CREATE_TABLES_SQL = """
CREATE TABLE IF NOT EXISTS knowledge_bases (
    id                    VARCHAR(36) PRIMARY KEY,
    name                  VARCHAR(255) NOT NULL,
    description           TEXT,
    category              VARCHAR(100),
    enabled               BOOLEAN NOT NULL DEFAULT TRUE,
    chunk_size_tokens     INTEGER,
    chunk_overlap_tokens  INTEGER,
    separator_mode        VARCHAR(20) DEFAULT 'auto',
    custom_separator      VARCHAR(100),
    chunk_structure       VARCHAR(20) DEFAULT 'paragraph',
    child_chunk_size_tokens    INTEGER,
    child_chunk_overlap_tokens INTEGER,
    remove_extra_spaces   BOOLEAN NOT NULL DEFAULT TRUE,
    remove_urls_emails    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at            TIMESTAMPTZ DEFAULT NOW(),
    updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS knowledge_documents (
    id                      VARCHAR(36) PRIMARY KEY,
    knowledge_base_id       VARCHAR(36) NOT NULL REFERENCES knowledge_bases(id),
    title                   VARCHAR(500) NOT NULL,
    content                 TEXT NOT NULL,
    chunk_count             INTEGER NOT NULL DEFAULT 0,
    status                  VARCHAR(50) NOT NULL DEFAULT 'pending',
    enabled                 BOOLEAN NOT NULL DEFAULT TRUE,
    original_filename       VARCHAR(500),
    original_file_type      VARCHAR(100),
    original_file_size      INTEGER,
    original_file_path      VARCHAR(1000),
    error_message           VARCHAR(2000),
    retry_count             INTEGER NOT NULL DEFAULT 0,
    quality_label           VARCHAR(20),
    processing_detail       TEXT,
    processing_started_at   TIMESTAMPTZ,
    downloading_completed_at TIMESTAMPTZ,
    parsing_completed_at    TIMESTAMPTZ,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_knowledge_documents_kb_id
    ON knowledge_documents(knowledge_base_id);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id                VARCHAR(36) PRIMARY KEY,
    document_id       VARCHAR(36) NOT NULL REFERENCES knowledge_documents(id),
    knowledge_base_id VARCHAR(36) NOT NULL REFERENCES knowledge_bases(id),
    chunk_index       INTEGER NOT NULL,
    content           TEXT NOT NULL,
    token_count       INTEGER NOT NULL DEFAULT 0,
    enabled           BOOLEAN NOT NULL DEFAULT TRUE,
    source_type       VARCHAR(20),
    quality_label     VARCHAR(20),
    parent_chunk_id   VARCHAR(36) REFERENCES knowledge_chunks(id),
    created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_knowledge_chunks_doc_id
    ON knowledge_chunks(document_id);

CREATE INDEX IF NOT EXISTS ix_knowledge_chunks_kb_id
    ON knowledge_chunks(knowledge_base_id);
"""


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def seed() -> None:
    """主流程：建表 → 创建 KB → 写入文档。"""
    # 用 sync 连接建表（CREATE TABLE 不能跑在事务里）
    sync_url = settings.database_url.replace("+asyncpg", "+psycopg2")
    engine = create_async_engine(
        settings.database_url,
        echo=False,
    )

    # 1. 建表（使用 raw connection 避免事务问题）
    import asyncpg  # type: ignore[import-untyped]

    # 从 DATABASE_URL 解析连接参数
    # postgresql+asyncpg://postgres:postgres@localhost:5434/agentforge_py
    url = settings.database_url
    # 简单解析：移除协议前缀
    rest = url.replace("postgresql+asyncpg://", "")
    user_pass, host_db = rest.split("@", 1) if "@" in rest else ("", rest)
    user, password = user_pass.split(":", 1) if ":" in user_pass else (user_pass, "")
    host_port, db_name = host_db.split("/", 1) if "/" in host_db else (host_db, "postgres")
    host, port = host_port.split(":", 1) if ":" in host_port else (host_port, "5434")

    conn = await asyncpg.connect(
        user=user,
        password=password,
        host=host,
        port=int(port),
        database=db_name,
    )
    try:
        await conn.execute(CREATE_TABLES_SQL)
        print("Tables ensured.")
    finally:
        await conn.close()

    # 2. 创建/确认知识库（幂等）
    async with engine.connect() as conn:
        existing = await conn.execute(
            text("SELECT id FROM knowledge_bases WHERE id = :kb_id"),
            {"kb_id": IDENTITY_KB_ID},
        )
        row = existing.fetchone()

        if row:
            print(f"Knowledge base already exists: {IDENTITY_KB_NAME}")
        else:
            await conn.execute(
                text("""
                    INSERT INTO knowledge_bases (id, name, description, enabled, chunk_structure,
                        remove_extra_spaces, remove_urls_emails)
                    VALUES (:id, :name, :desc, TRUE, 'paragraph', TRUE, FALSE)
                """),
                {"id": IDENTITY_KB_ID, "name": IDENTITY_KB_NAME, "desc": IDENTITY_KB_DESC},
            )
            await conn.commit()
            print(f"Created knowledge base: {IDENTITY_KB_NAME}")

        # 3. 检查已存在的文档数
        doc_count_row = await conn.execute(
            text("SELECT COUNT(*) FROM knowledge_documents WHERE knowledge_base_id = :kb_id"),
            {"kb_id": IDENTITY_KB_ID},
        )
        existing_docs: int = doc_count_row.scalar() or 0  # type: ignore[assignment]

        if existing_docs >= len(IDENTITY_DOCS):
            print(f"{existing_docs} documents already exist, skipping.")
            await conn.commit()
            await engine.dispose()
            return

        # 4. 写入文档
        print(f"Seeding {len(IDENTITY_DOCS)} documents...")
        for i, doc in enumerate(IDENTITY_DOCS):
            doc_id = str(uuid.uuid4())
            await conn.execute(
                text("""
                    INSERT INTO knowledge_documents
                        (id, knowledge_base_id, title, content, chunk_count, status, enabled, created_at, updated_at)
                    VALUES (:id, :kb_id, :title, :content, 0, 'pending', TRUE, :now, :now)
                    ON CONFLICT (id) DO NOTHING
                """),
                {
                    "id": doc_id,
                    "kb_id": IDENTITY_KB_ID,
                    "title": doc["title"],
                    "content": doc["content"],
                    "now": _now(),
                },
            )
            print(f"  [{i + 1}/{len(IDENTITY_DOCS)}] {doc['title']}")
        await conn.commit()

    await engine.dispose()
    print(f"Done! {len(IDENTITY_DOCS)} documents seeded into {IDENTITY_KB_NAME}")


if __name__ == "__main__":
    asyncio.run(seed())
