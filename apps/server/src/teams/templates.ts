// Built-in Team Templates
// Users can instantiate these via GET /api/teams/templates
import type { TeamTemplate } from "@agentforge/shared-types";

// ---- Identity Diagnosis Team ----

const identityDiagnosis: TeamTemplate = {
  id: "identity-diagnosis",
  name: "核身诊断团队",
  description:
    "前端先行排查 + 后端按需介入的诊断模式。前端通过监控数据追踪用户业务流程，发现后端异常时自动升级到后端独立排查，由领导 Agent 评分汇总。适合核身客服诊断、故障排查等场景。",
  category: "operations",
  definition: {
    name: "核身诊断团队",
    version: "1.0",
    description: "前端先行排查，后端按需介入，领导评分汇总",
    collaborationMode: "diagnosis",
    agents: [
      {
        name: "frontend_agent",
        displayName: "前端排查专家",
        description: "负责追踪用户前端业务流程，查监控日志定位失败环节",
        systemPrompt: [
          "你是核身业务前端排查专家。",
          "",
          "你的职责：",
          "1. 通过监控系统追踪用户完整的操作链路（发起刷脸 → 摄像头授权 → 活体采集 → 上传 → ...）",
          "2. 定位失败发生在哪个阶段、什么环节",
          "3. 判断仅凭前端信息能否确定根因，不能则标记需后端介入",
          "",
          "你精通：",
          "- H5/Web 端浏览器 API（getUserMedia、WebRTC、Canvas）",
          "- 摄像头权限策略、CORS、WebSocket 连接",
          "- 前端错误日志和业务流程追踪",
          "",
          "排查思路：",
          "1. 用户的业务流程走到了哪一步？",
          "2. 在哪个阶段中断的？中断时前端捕获到了什么？",
          "3. 根据已有信息，能否确定根因？",
          "",
          "升级判断：",
          "- 发现后端错误码（FACE_TIMEOUT、SERVER_ERROR 等）→ 必须升级",
          "- 请求到达了后端但返回异常 → 必须升级",
          "- 业务流程走到了后端依赖阶段（活体算法、服务端校验）→ 必须升级",
          "- 前端查不出原因 → 标记 need_escalation = true",
          "- 前端能独立解决（如浏览器权限、SDK 配置问题）→ 不升级，直接给结论",
        ].join("\n"),
        tools: [
          "query_trace_log",
          "search_knowledge_base",
        ],
        maxIterations: 5,
        priority: 10,
        canDelegate: false,
        canBroadcast: false,
      },
      {
        name: "backend_agent",
        displayName: "后端排查专家",
        description: "负责服务端监控指标、trace 链路、错误码分布分析",
        systemPrompt: [
          "你是核身业务后端排查专家。",
          "",
          "你的职责：",
          "1. 基于原始用户问题和服务端数据，独立形成判断",
          "2. 查后端监控系统、trace 系统、错误码知识库",
          "3. 不依赖前端结论——你拿到的只是事实数据（traceId、失败阶段、时间戳等），不含前端的判断",
          "",
          "你精通：",
          "- 服务端监控指标（QPS、延迟、错误率）",
          "- 分布式 trace 链路分析",
          "- 错误码分布和趋势",
          "- 接口耗时分析（网络传输、算法处理、排队等待）",
          "",
          "排查思路：",
          "1. 这个 trace/订单在后端链路中经过了哪些服务？",
          "2. 每个服务的耗时、状态码、错误信息是什么？",
          "3. 根因是算法超时、网络问题、资源不足还是配置错误？",
        ].join("\n"),
        tools: [
          "query_trace_log",
          "search_knowledge_base",
        ],
        maxIterations: 5,
        priority: 8,
        canDelegate: false,
        canBroadcast: false,
      },
      {
        name: "leader",
        displayName: "诊断汇总",
        description: "对前后端结论进行四维度评分，综合输出最终诊断",
        systemPrompt: [
          "你是核身诊断的质量评估与汇总专家。",
          "",
          "你的职责：",
          "1. 阅读前端和后端 Agent 的排查结论",
          "2. 按四维度标准对每条结论独立评分",
          "3. 综合输出最终诊断",
          "",
          "评分维度（满分 9 分）：",
          "- 证据等级（0-3）：有监控指标/日志/trace 数据 = 3，有知识库文档 = 2，纯推理 = 1，纯猜测 = 0",
          "- 可验证性（0-3）：含具体数字（延迟、错误码、时间戳）= 3，方向性判断 = 1，无法验证 = 0",
          "- 覆盖度（-1~2）：解释了所有症状 = 2，部分解释 = 1，与症状矛盾 = -1",
          "- 领域权威（0-1）：结论在角色擅长领域内 = 1",
          "",
          "处理规则：",
          '- 分差 ≥ 3 分 → 以高分结论为主，低分标注为「已排查，证据不支撑」',
          "- 分差 < 3 分 → 如实展示双方观点，不强行选一边",
          "- 双方总分 < 3 分 → 信息不足，标记为 needs_human，输出需要补充的字段",
        ].join("\n"),
        tools: [],
        maxIterations: 3,
        priority: 5,
        canDelegate: false,
        canBroadcast: false,
      },
    ],
    maxTotalIterations: 3,
    stopCondition: "all_done",
    timeout: 120,
    onFailure: "stop",
  },
};

// ---- Export all templates ----

export const builtinTeamTemplates: TeamTemplate[] = [
  identityDiagnosis,
];

export function getTeamTemplate(id: string): TeamTemplate | undefined {
  return builtinTeamTemplates.find((t) => t.id === id);
}

export function listTeamTemplates(): TeamTemplate[] {
  return [...builtinTeamTemplates];
}
