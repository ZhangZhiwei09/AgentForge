// L1 关键词快速路由 —— 零延迟正则匹配
//
// 处理 SAFETY、HUMAN、DIAGNOSIS 三类高确定性场景。
// 其余所有查询返回 null，交给 L2 SemanticClassifier。
//
// 从 router.ts 提取，保持原有逻辑不变。

import type { RouteName } from "../types.js";

// ── SAFETY 关键词 ──

export const SAFETY_KEYWORDS = [
  // ── 原有规则：英文 prompt injection ──
  /忽略.*(指令|规则|限制|之前)/i,
  /扮演.*(角色|黑客|坏人)/i,
  /(DAN|jailbreak|system\s*prompt)/i,
  /ignore.*(instruction|rule)/i,
  /pretend.*(you\s*are|to\s*be)/i,
  // ── 多语言攻击变体 ──
  /無視.*(指示|ルール|制限)/i,
  /開発者.*モード/i,
  /忽略.*(指示|規則|制限|以前)/i,
  /(role.?(play|扮演)|cosplay|pretend\s+to\s+be)/i,
  /你.*(现在|从现在起|以後|从此).*是.*(ChatGPT|GPT|AI|人工智能|机器人)/i,
  /forget.*(everything|all).*(before|above|previous)/i,
  // ── Token 窜改 / 特殊分隔符注入 ──
  /<\|im_start\|>/i,
  /<\|system\|>/i,
  /\[INST\].*\[\/?INST\]/i,
  /(system|系统|系統)\s*:\s*(你现在|你的新|ignore|forget)/i,
  /<\s*s\s*y\s*s\s*t\s*e\s*m\s*>/i,
  // ── 编码混淆检测 ──
  /(base64|b64|base64_decode|atob|fromCharCode)\s*\(/i,
  /[A-Za-z0-9+\/=]{40,}\s*(decode|解密|解码)/i,
  /fromCharCode\s*\(/i,
  // ── 社会工程 / 权限冒充 ──
  /(我是|我是你).*(管理员|开发者|创始人|CEO|CTO|老板|经理).*(请|要求|命令|给我)/i,
  /(give|show|reveal|tell|print).*me.*(your\s*(prompt|instructions|system|code|rules))/i,
  /(output|print|dump|show).*(your|the).*(prompt|instructions|system\s*message)/i,
  // ── 重复/填充攻击 ──
  /([^\s])\1{500,}/,
];

export const HUMAN_KEYWORDS = [
  /转人工/,
  /找(人工|真人|客服|你们经理|你们领导)/,
  /(打|联系|给.*)(客服)?电话/,
  /我要投诉/,
  /投诉.*(你们|客服|服务)/,
  /叫.*(经理|领导|负责人)/,
];

export const DIAGNOSIS_KEYWORDS = [
  // 强信号：错误码 + traceId
  /traceId\s*[:：]\s*\w+/i,
  /error[_ ]?code\s*[:：]\s*\w+/i,
  // 故障关键词
  /(报错|失败|超时|打不开|连不上|崩溃|闪退|白屏|卡死)/,
  /(排查|诊断|定位|帮我看下|帮我查下|帮我查|帮我看看|帮我看|帮我分析).*(问题|原因|怎么回事|什么情况|什么原因)/,
  /(摄像头|麦克风|活体|刷脸|人脸|认证|识别).*(失败|打不开|不能用|没反应|超时|异常)/,
  /(WebSocket|网络|连接).*(断开|超时|失败)/,
  /(成功率|通过率).*(下跌|下降|降低|异常|掉|低)/,
];

// ── 类型 ──

export interface QuickRouteResult {
  route: RouteName;
  confidence: number;
  reasoning: string;
}

/**
 * L1 规则优先扫描：处理 SAFETY、HUMAN、DIAGNOSIS 三类高确定性场景。
 * 其余所有查询返回 null，交给 L2 SemanticClassifier。
 */
export function quickRouteScan(message: string): QuickRouteResult | null {
  // SAFETY 优先 —— 安全合规不能有任何延迟
  if (SAFETY_KEYWORDS.some((p) => p.test(message))) {
    return {
      route: "SAFETY",
      confidence: 1.0,
      reasoning: "安全关键词命中",
    };
  }

  // HUMAN —— 明确要求转人工
  if (HUMAN_KEYWORDS.some((p) => p.test(message))) {
    return {
      route: "HUMAN",
      confidence: 0.95,
      reasoning: "转人工关键词命中",
    };
  }

  // DIAGNOSIS —— 故障排查/诊断类问题
  if (DIAGNOSIS_KEYWORDS.some((p) => p.test(message))) {
    return {
      route: "DIAGNOSIS",
      confidence: 0.85,
      reasoning: "诊断关键词命中",
    };
  }

  return null; // → Router LLM
}
