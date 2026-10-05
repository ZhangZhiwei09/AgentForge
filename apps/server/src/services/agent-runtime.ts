// Agent Runtime 服务 —— Router + Agent 编排器
//
// 编排器职责：
//   1. Session 管理（获取/创建会话、加载历史）
//   2. 传统对话快速通道（正则零延迟匹配问候/感谢/道别）
//   3. QueryRouter 分类（Rule First + LLM Fallback → SAFETY|CHAT|TASK|HUMAN）
//   4. 分发到对应 Agent 执行
//   5. 后处理（保存消息、提取记忆）
//
// 每个 Agent 各自负责自己的 Prompt、校验、重试、fallback

import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import { resolveModel } from "../providers/registry.js";
import type { ChatMessage } from "../providers/types.js";
import { logger } from "@agentforge/logger";
import { ErrorCode } from "./agent-runtime/errors/codes.js";
import {
  agentRouteClassificationTotal,
  agentRouteConfidence,
  agentRequestDurationMs,
} from "../observability/metrics.js";
import { intentDetector } from "./intent-detector.js";
import { checkContentSafety } from "../middleware/content-safety.js";
import { createExecutionScope } from "../runtime/scope.js";
import { getObservabilityProvider } from "../observability/index.js";

import { QueryRouter } from "./agent-runtime/router.js";
import { SafetyAgent } from "./agent-runtime/safety-agent.js";
import { ChatAgent } from "./agent-runtime/chat-agent.js";
import { AgentExecutor } from "./agent-runtime/agent-executor.js";
import { HumanAgent } from "./agent-runtime/human-agent.js";
import { DiagnosisRouteAgent } from "./agent-runtime/diagnosis-agent.js";

import { injectMemories } from "./agent-runtime/knowledge-context.js";
import { AGENTFORGE_PERSONA } from "@agentforge/shared-prompts";
import type { CitationCard, TraceStep } from "@agentforge/shared-types";

import type {
  RouteName,
  RouteContext,
  RouteStreamEvent,
  RouteAgent,
  KnowledgeChunkResult,
} from "./agent-runtime/types.js";
import {
  SORRY_TEMPLATE,
  type ChatResponse,
} from "./agent-runtime/validation.js";

// Re-export for backward compatibility
export {
  SORRY_TEMPLATE,
  FALLBACK_PREFIX,
  ChatResponseSchema,
  FORBIDDEN_PATTERNS,
} from "./agent-runtime/validation.js";
export type { KnowledgeChunkResult } from "./agent-runtime/types.js";

// ═══════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════

const AGENT_USER_ID = "00000000-0000-0000-0000-000000000002";
const MAX_HISTORY_MESSAGES = 20;

// 工作时间（通用配置）
const SERVICE_HOURS_START = parseInt(
  process.env.AGENT_SERVICE_HOURS_START || "9",
  10,
);
const SERVICE_HOURS_END = parseInt(
  process.env.AGENT_SERVICE_HOURS_END || "18",
  10,
);
const SERVICE_DAYS = (process.env.AGENT_SERVICE_DAYS || "1,2,3,4,5")
  .split(",")
  .map(Number);

// ═══════════════════════════════════════════════════════
// 传统对话快速通道（零延迟正则匹配）
// ═══════════════════════════════════════════════════════

interface ConversationalRule {
  pattern: RegExp;
  response: ChatResponse;
}

const CONVERSATIONAL_RULES: ConversationalRule[] = [
  {
    pattern:
      /^(你好|hi|hello|嗨|您好|早上好|下午好|晚上好|在吗|在不在)[\s!！。.,，]*$/,
    response: {
      answer:
        "你好，我是 AgentForge 智能助手，我能查询知识库、诊断系统故障。需要什么帮助？",
      suggestions: ["查询知识库", "诊断系统故障"],
    },
  },
  {
    pattern:
      /^(谢谢|感谢|多谢|谢谢你|谢谢您|thanks|thank you|3q)[\s!！。.,，]*$/,
    response: {
      answer: "不客气。还有其他问题可以随时找我。",
      suggestions: [],
    },
  },
  {
    pattern: /^(再见|拜拜|Bye|bye|88|下次见|回头见)[\s!！。.,，]*$/,
    response: {
      answer: "再见。",
      suggestions: [],
    },
  },
];

// ═══════════════════════════════════════════════════════
// AgentRuntimeService（薄编排器）
// ═══════════════════════════════════════════════════════

export class AgentRuntimeService {
  private modelId: string | null;
  private router: QueryRouter;
  private safetyAgent: SafetyAgent;
  private chatAgent: ChatAgent;
  private agentExecutor: AgentExecutor;
  private humanAgent: HumanAgent;
  private diagnosisAgent: DiagnosisRouteAgent;

  // 会话级并发控制
  private static sessionLocks = new Map<string, Promise<void>>();
  private static readonly MAX_SESSION_LOCKS = 1000;
  private static readonly SESSION_LOCK_TIMEOUT_MS = 30_000;

  constructor(modelId?: string | null) {
    this.modelId = modelId || null;
    this.router = new QueryRouter(modelId);
    this.safetyAgent = new SafetyAgent();
    this.chatAgent = new ChatAgent(AGENTFORGE_PERSONA);
    this.agentExecutor = new AgentExecutor();
    this.humanAgent = new HumanAgent();
    this.diagnosisAgent = new DiagnosisRouteAgent();

    // 强类型路由注册表
    this.agentRegistry = {
      SAFETY: this.safetyAgent,
      CHAT: this.chatAgent,
      TASK: this.agentExecutor,
      HUMAN: this.humanAgent,
      DIAGNOSIS: this.diagnosisAgent,
    };
  }

  // ── 会话管理 ──
  /**
   * 获取或创建会话。
   * lookupId 可能是 conversation_id（UUID 主键）或旧的 session_id，按优先级查找。
   */
  private async getOrCreateConversation(lookupId: string | null, userId: string) {
    if (lookupId) {
      // 优先按主键（conversation_id）查找
      const byId = await prisma.conversation.findUnique({
        where: { id: lookupId },
      });
      if (byId) return byId;

      // Fallback：按旧的 session_id 字段查找
      const bySessionId = await prisma.conversation.findFirst({
        where: { sessionId: lookupId, type: "agent_chat" },
      });
      if (bySessionId) return bySessionId;
    }
    const conversation = await prisma.conversation.create({
      data: {
        id: randomUUID(),
        title: "智能助手会话",
        userId,
        type: "agent_chat",
        sessionId: lookupId,
      },
    });
    return conversation;
  }

  // ── 工作时间检查 ──
  private isWithinServiceHours(): boolean {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const hour = now.getHours();
    const adjustedDay = dayOfWeek === 0 ? 7 : dayOfWeek;
    if (!SERVICE_DAYS.includes(adjustedDay)) return false;
    if (hour < SERVICE_HOURS_START || hour >= SERVICE_HOURS_END) return false;
    return true;
  }

  // ── 传统对话匹配 ──
  private matchConversational(userMessage: string): ChatResponse | null {
    const trimmed = userMessage.trim();
    for (const rule of CONVERSATIONAL_RULES) {
      if (rule.pattern.test(trimmed)) {
        return rule.response;
      }
    }
    return null;
  }

  // ── Agent 路由表 ──
  private readonly agentRegistry: Record<RouteName, RouteAgent>;

  private resolveAgent(route: RouteName): RouteAgent {
    const agent = this.agentRegistry[route];
    if (!agent) {
      throw new Error(`[AgentRuntimeService] 未注册的 RouteAgent: ${route}`);
    }
    return agent;
  }

  // ═══════════════════════════════════════════════════════
  // 主流程
  // ═══════════════════════════════════════════════════════

  async *streamChat(
    lookupId: string | null,
    userId: string,
    userMessage: string,
    signal?: AbortSignal,
  ): AsyncGenerator<Record<string, unknown>> {
    // ── 0. 会话级并发控制：同一 lookupId 的请求串行化 ──
    // 使用带时间戳的锁条目，超时时自动垃圾回收防止僵尸锁永久阻塞
    const lockKey = lookupId ?? `anonymous-${randomUUID()}`;
    const existingEntry = AgentRuntimeService.sessionLocks.get(lockKey);
    const previousLock = existingEntry ?? Promise.resolve();

    let releaseLock: () => void = () => {};
    const currentLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    // LRU 淘汰：Map 超过上限时逐出最旧的 entry
    if (
      AgentRuntimeService.sessionLocks.size >=
      AgentRuntimeService.MAX_SESSION_LOCKS
    ) {
      const firstKey = AgentRuntimeService.sessionLocks.keys().next().value;
      if (firstKey !== undefined) {
        AgentRuntimeService.sessionLocks.delete(firstKey);
        logger.warn(
          {
            errorCode: ErrorCode.AR_SESSION_LOCK_OVERFLOW,
            evictedKey: firstKey,
            mapSize: AgentRuntimeService.sessionLocks.size,
          },
          "Session lock map exceeded limit, evicted oldest entry",
        );
      }
    }
    AgentRuntimeService.sessionLocks.set(lockKey, currentLock);

    // 等待前一个同 session 的请求完成（带超时 + 僵尸锁 GC）
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const lockResult = await Promise.race([
      previousLock.then(() => "resolved" as const),
      new Promise<"timeout">((resolve) => {
        timeoutTimer = setTimeout(
          () => resolve("timeout"),
          AgentRuntimeService.SESSION_LOCK_TIMEOUT_MS,
        );
      }),
    ]);
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);

    if (lockResult === "timeout") {
      // 前一个请求的 Promise 已僵尸（请求崩溃/挂起未释放锁）→ GC 陈旧锁
      // 当前请求的 currentLock 已写入 Map，后续请求将等待 currentLock（健康锁）
      logger.warn(
        {
          errorCode: ErrorCode.AR_SESSION_LOCK_TIMEOUT,
          lockKey,
          timeoutMs: AgentRuntimeService.SESSION_LOCK_TIMEOUT_MS,
        },
        "Session lock timed out — stale lock garbage-collected, proceeding",
      );
    }

    // ── Observability Trace（提前声明，try/finally 均可访问）──
    const runId = randomUUID();
    const provider = getObservabilityProvider();
    let lfTrace = provider.createTrace({
      name: "agent-chat",
      input: { message: userMessage },
      metadata: { runId },
    });

    try {
      // ── 1. Session 层 ──
      const conversation = await this.getOrCreateConversation(lookupId, userId);
      const { providerName, modelId: resolvedModel } = resolveModel(this.modelId);
      const withinHours = this.isWithinServiceHours();

      const { intent } = intentDetector.detect(userMessage);

      // 加载历史
      const history = await prisma.message.findMany({
        where: { conversationId: conversation.id },
        orderBy: { createdAt: "desc" },
        take: MAX_HISTORY_MESSAGES,
      });
      const reversed = history.reverse();

      const historyMessages: ChatMessage[] = reversed.map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));

      // 保存用户消息
      await prisma.message.create({
        data: {
          id: randomUUID(),
          conversationId: conversation.id,
          role: "user",
          content: userMessage,
          model: resolvedModel,
        },
      });

      if (intent !== "其他咨询") {
        try {
          await prisma.conversation.update({
            where: { id: conversation.id },
            data: { intent },
          });
        } catch {
          /* 字段可能未迁移 */
        }
      }

      const assistantMsgId = randomUUID();

      // ── Update trace with session metadata ──
      lfTrace.update({
        metadata: {
          sessionId: conversation.sessionId ?? undefined,
          model: `${providerName}/${resolvedModel}`,
          intent,
          withinServiceHours: withinHours,
        },
      });

      // Create ExecutionScope for runtime cancellation
      const scope = createExecutionScope({
        signal: signal ?? new AbortController().signal,
        trace: lfTrace,
        runId,
      });
      scope.controller.start();

      // ── 2. 传统对话快速通道（零延迟） ──
      const convMatch = this.matchConversational(userMessage);
      if (convMatch && checkContentSafety(userMessage).safe) {
        const convStartTime = Date.now();

        yield* this.streamConversationalMatch(
          assistantMsgId,
          conversation.id,
          conversation.sessionId,
          resolvedModel,
          providerName,
          withinHours,
          intent,
          convMatch,
        );

        agentRequestDurationMs.observe(
          { route: "CHAT", phase: "ttft" },
          Date.now() - convStartTime,
        );
        agentRequestDurationMs.observe(
          { route: "CHAT", phase: "ttlt" },
          Date.now() - convStartTime,
        );

        await prisma.message.create({
          data: {
            id: assistantMsgId,
            conversationId: conversation.id,
            role: "assistant",
            content: convMatch.answer,
            model: resolvedModel,
          },
        });

        // ── Close observability trace（快通道：无 LLM 调用）──
        lfTrace.update({ output: { answer: convMatch.answer } });
        lfTrace.end();

        return;
      }

      // ── 3. QueryRouter 分类 ──
      const classifyStart = Date.now();
      const decision = await this.router.classify(
        userMessage,
        historyMessages,
        lfTrace,
      );

      logger.info(
        {
          route: decision.route,
          confidence: decision.confidence,
          sessionId: conversation.sessionId,
        },
        "Router classified message",
      );

      const source = decision.reasoning.includes("关键词命中")
        ? "keyword"
        : decision.reasoning.includes("L2语义匹配")
          ? "l2_semantic"
          : decision.reasoning.includes("L3少样本增强")
            ? "l3_fewshot"
            : decision.reasoning.includes("fallback")
              ? "fallback"
              : "llm";
      agentRouteClassificationTotal.inc({
        route: decision.route,
        source,
      });
      agentRouteConfidence.observe(
        { route: decision.route },
        decision.confidence,
      );

      // ── 路由分类审计日志（非阻塞，失败静默忽略）──
      const classifyLatencyMs = Date.now() - (classifyStart ?? Date.now());
      prisma.routeClassificationLog.create({
        data: {
          id: randomUUID(),
          sessionId: conversation.sessionId,
          conversationId: conversation.id,
          userMessage: userMessage.slice(0, 2000),
          route: decision.route,
          confidence: decision.confidence,
          source,
          latencyMs: classifyLatencyMs,
        },
      }).catch(() => {
        // 非关键路径，不影响路由流程
      });

      // ── 4. 构建 RouteContext ──
      let context: RouteContext = {
        conversationId: conversation.id,
        sessionId: conversation.sessionId,
        userMessage,
        history: historyMessages,
        knowledgeContext: "",
        knowledgeResults: [],
        kbChunks: [],
        memoryContext: "",
        injectedMemories: [],
        resolvedModel,
        providerName,
        withinServiceHours: withinHours,
        assistantMsgId,
        intent,
      };

      // ── 5. Memory 注入（所有路由通用） ──
      const [memCtx, mems] = await injectMemories(
        userMessage,
        conversation.sessionId,
      );
      context.memoryContext = memCtx;
      context.injectedMemories = mems;

      // ── 6. 分发到对应 Agent ──
      const agent = this.resolveAgent(decision.route);
      let streamedAnswer = "";

      const startTime = Date.now();
      let firstTokenRecorded = false;
      // 引用卡片与过程时间轴：编排器已在转发全部事件，在此累积以便循环结束后单点落库
      let collectedCitations: CitationCard[] = [];
      const traceBySeq = new Map<number, TraceStep>();

      for await (const event of agent.execute(context, scope)) {
        if (scope.controller.shouldStop) break;

        if (!firstTokenRecorded && event.type === "token") {
          firstTokenRecorded = true;
          agentRequestDurationMs.observe(
            { route: decision.route, phase: "ttft" },
            Date.now() - startTime,
          );
        }
        if (event.type === "clear_stream") {
          streamedAnswer = "";
        }
        if (event.type === "token") {
          streamedAnswer += event.content;
        }
        if (event.type === "done") {
          agentRequestDurationMs.observe(
            { route: decision.route, phase: "ttlt" },
            Date.now() - startTime,
          );
        }
        if (event.type === "citations") {
          // 每个 citations 事件都是本轮全集，后到者覆盖先到者
          collectedCitations = event.items;
        }
        if (event.type === "trace_step") {
          // running 与 done/failed 共用同一 seq，按 seq 覆盖得最终态
          traceBySeq.set(event.step.seq, event.step);
        }
        yield event;
      }

      // Handle interruption
      if (scope.controller.shouldStop) {
        scope.controller.interrupt();
        if (streamedAnswer) {
          await prisma.message.create({
            data: {
              id: assistantMsgId,
              conversationId: conversation.id,
              role: "assistant",
              content: streamedAnswer,
              model: resolvedModel,
            },
          });
        }
        await this.persistCitationMeta(assistantMsgId, collectedCitations, traceBySeq);
        lfTrace.update({
          output: { answer: streamedAnswer?.slice(0, 500) },
          metadata: { route: decision.route, status: "interrupted" },
        });
        lfTrace.end();
        return;
      }

      // ── 7. 保存助手消息（幂等：Agent 内部可能已保存，用 catch 避免重复插入报错）──
      if (streamedAnswer) {
        try {
          await prisma.message.create({
            data: {
              id: assistantMsgId,
              conversationId: conversation.id,
              role: "assistant",
              content: streamedAnswer,
              model: resolvedModel,
            },
          });
        } catch (e) {
          // 唯一约束冲突=Agent 已保存，忽略；其他错误记录日志
          if (!(e instanceof Error && e.message.includes("Unique constraint"))) {
            logger.warn({ errorCode: ErrorCode.AR_MSG_PERSIST_FAILED, err: e }, "Failed to persist assistant message in orchestrator");
          }
        }
      }

      // ── 引用卡片与过程时间轴落库（单点后置写）──
      await this.persistCitationMeta(assistantMsgId, collectedCitations, traceBySeq);

      // ── Close observability trace（正常完成）──
      lfTrace.update({
        output: { answer: streamedAnswer.slice(0, 500) },
        metadata: { route: decision.route, status: "completed" },
      });
      lfTrace.end();
    } finally {
      // 兜底关闭：正常路径已 end，这里幂等；异常路径保证 close
      lfTrace.end();

      releaseLock();
      if (AgentRuntimeService.sessionLocks.get(lockKey) === currentLock) {
        AgentRuntimeService.sessionLocks.delete(lockKey);
      }
    }
  }

  /**
   * 引用卡片与过程时间轴落库（单点后置写）。
   *
   * <p>助手消息存在多个 create 点（执行器内部与编排器各若干），其中一处靠唯一约束
   * 冲突幂等；逐个改 create 既会漏也会并发冲突。此处按 assistantMsgId 后置一次
   * update，与创建路径无关，天然幂等。落库是旁路，失败只记日志，不影响已输出的回答。</p>
   */
  private async persistCitationMeta(
    assistantMsgId: string,
    citations: CitationCard[],
    traceBySeq: Map<number, TraceStep>,
  ): Promise<void> {
    const traces = [...traceBySeq.values()].sort((a, b) => a.seq - b.seq);
    if (!citations.length && !traces.length) return;
    try {
      await prisma.message.update({
        where: { id: assistantMsgId },
        data: {
          // 展开为匿名对象字面量：Prisma 的 InputJsonValue 需要隐式索引签名，
          // 而 interface 不提供该签名（type alias / 匿名对象才行）
          metadata: {
            citations: citations.map((c) => ({ ...c })),
            traces: traces.map((t) => ({ ...t })),
          },
        },
      });
    } catch (e) {
      logger.warn(
        { errorCode: ErrorCode.AR_MSG_PERSIST_FAILED, err: e },
        "Failed to persist citation metadata",
      );
    }
  }

  // ── 传统对话流式输出 ──
  private async *streamConversationalMatch(
    assistantMsgId: string,
    conversationId: string,
    sessionId: string | null,
    model: string,
    provider: string,
    withinHours: boolean,
    intent: string,
    response: ChatResponse,
  ): AsyncGenerator<RouteStreamEvent> {
    yield {
      type: "meta",
      message_id: assistantMsgId,
      conversation_id: conversationId,
      session_id: sessionId,
      model,
      provider,
      knowledge: [],
      intent,
      within_service_hours: withinHours,
      memory_count: 0,
      conversational: true,
    };

    for (const char of response.answer) {
      yield {
        type: "token",
        content: char,
        message_id: assistantMsgId,
      };
    }

    yield {
      type: "done",
      message_id: assistantMsgId,
      usage: {},
      suggestions:
        response.suggestions.length > 0 ? response.suggestions : undefined,
      memory: { injected: 0, extracted: 0 },
      validated: true,
      conversational: true,
    };
  }
}

// ── 单例工厂 ──

let _defaultService: AgentRuntimeService | null = null;

export function getAgentRuntimeService(): AgentRuntimeService {
  if (!_defaultService) {
    _defaultService = new AgentRuntimeService();
  }
  return _defaultService;
}
