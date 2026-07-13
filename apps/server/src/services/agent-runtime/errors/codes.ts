// AgentForge 统一错误码
//
// 所有 Agent Runtime 及下游模块的 logger.warn/error 调用
// 均使用此模块定义的错误码，以便日志检索、告警和监控。
//
// 格式：<DOMAIN>_<COMPONENT>_<FAILURE>
//   例：AE_EXECUTION_FAILED → AgentExecutor 执行异常
//
// 使用方式：
//   import { ErrorCode } from "./errors/codes.js";
//   logger.warn({ errorCode: ErrorCode.AE_AGENT_ERROR, ... }, "message");

// ═══════════════════════════════════════════════════════
// ErrorCode — 统一错误码常量
// ═══════════════════════════════════════════════════════

export const ErrorCode = {
  // ── AgentExecutor ──
  /** Agent ReAct 循环中 LLM 返回 agent_error */
  AE_AGENT_ERROR: "AE_AGENT_ERROR",
  /** agent_ask_user 事件的 question 字段为空 */
  AE_ASK_USER_EMPTY: "AE_ASK_USER_EMPTY",
  /** ReAct JSON 泄漏到最终回复，已触发安全网 fallback */
  AE_REACT_JSON_LEAK: "AE_REACT_JSON_LEAK",
  /** 中断时持久化部分内容到 DB 失败 */
  AE_INTERRUPT_PERSIST_FAILED: "AE_INTERRUPT_PERSIST_FAILED",
  /** KnowledgeContext 构建异常（非阻塞） */
  AE_KB_CONTEXT_FAILED: "AE_KB_CONTEXT_FAILED",
  /** Citation 引证校验异常（非阻塞） */
  AE_CITATION_FAILED: "AE_CITATION_FAILED",
  /** 业务回复校验未通过 */
  AE_VALIDATION_FAILED: "AE_VALIDATION_FAILED",
  /** AgentExecutor.execute() 顶层未捕获异常 */
  AE_EXECUTION_FAILED: "AE_EXECUTION_FAILED",
  /** 记忆记录失败（非阻塞） */
  AE_MEMORY_FAILED: "AE_MEMORY_FAILED",
  /** simple_qa 知识库搜索失败（降级继续） */
  AE_SIMPLE_QA_KB_FAILED: "AE_SIMPLE_QA_KB_FAILED",
  /** simple_qa LLM 调用失败（触发 fallback） */
  AE_SIMPLE_QA_LLM_FAILED: "AE_SIMPLE_QA_LLM_FAILED",
  /** simple_qa 助手消息持久化失败 */
  AE_SIMPLE_QA_PERSIST_FAILED: "AE_SIMPLE_QA_PERSIST_FAILED",
  /** 收到未识别的 AgentStreamEvent type */
  AE_UNRECOGNIZED_EVENT: "AE_UNRECOGNIZED_EVENT",

  // ── AgentRuntimeService（编排器）──
  /** Session lock Map 超过容量上限，已 LRU 淘汰 */
  AR_SESSION_LOCK_OVERFLOW: "AR_SESSION_LOCK_OVERFLOW",
  /** Session lock 等待超时（前一个请求僵尸），已 GC */
  AR_SESSION_LOCK_TIMEOUT: "AR_SESSION_LOCK_TIMEOUT",
  /** 编排器持久化助手消息失败（可能 Agent 已写入） */
  AR_MSG_PERSIST_FAILED: "AR_MSG_PERSIST_FAILED",

  // ── Router ──
  /** L2 SemanticClassifier 分类异常，降级到 LLM Router */
  RT_L2_CLASSIFY_FAILED: "RT_L2_CLASSIFY_FAILED",
  /** L2 pgvector 返回行未通过 Zod 校验 */
  RT_L2_INVALID_MATCH: "RT_L2_INVALID_MATCH",
  /** L3 Few-Shot LLM 调用异常，降级到 L4 */
  RT_L3_LLM_FAILED: "RT_L3_LLM_FAILED",
  /** L3 解析失败或置信度过低，降级到 L4 */
  RT_L3_LOW_CONFIDENCE: "RT_L3_LOW_CONFIDENCE",
  /** L3/L4 parseRouterDecision JSON 解析失败 */
  RT_PARSE_FAILED: "RT_PARSE_FAILED",
  /** L4 LLM 调用异常，降级到 L5 */
  RT_L4_LLM_FAILED: "RT_L4_LLM_FAILED",
  /** L4 置信度过低，降级到 L5 */
  RT_L4_LOW_CONFIDENCE: "RT_L4_LOW_CONFIDENCE",

  // ── HumanAgent ──
  /** 人工转接时更新会话状态失败（非阻塞） */
  HM_ESCALATE_FAILED: "HM_ESCALATE_FAILED",

  // ── Validation ──
  /** LLM 响应 JSON 解析失败 */
  VL_PARSE_FAILED: "VL_PARSE_FAILED",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
