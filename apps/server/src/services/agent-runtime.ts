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
import {
  agentRouteClassificationTotal,
  agentRouteConfidence,
  agentRequestDurationMs,
} from "../observability/metrics.js";
import { intentDetector } from "./intent-detector.js";
import { createExecutionScope } from "../runtime/scope.js";
import { getObservabilityProvider } from "../observability/index.js";

import { QueryRouter } from "./agent-runtime/router.js";
import { SafetyAgent } from "./agent-runtime/safety-agent.js";
import { ChatAgent } from "./agent-runtime/chat-agent.js";
import { AgentExecutor } from "./agent-runtime/agent-executor.js";
import { HumanAgent } from "./agent-runtime/human-agent.js";
import { DiagnosisRouteAgent } from "./agent-runtime/diagnosis-agent.js";

import { injectMemories } from "./agent-runtime/knowledge-context.js";

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
        "您好！欢迎来到 AgentForge 智能助手 😊 请问有什么可以帮助您的？",
      suggestions: ["知识库查询", "任务执行", "联系人工客服"],
    },
  },
  {
    pattern:
      /^(谢谢|感谢|多谢|谢谢你|谢谢您|thanks|thank you|3q)[\s!！。.,，]*$/,
    response: {
      answer:
        "不客气！很高兴能帮到您。如果后续还有任何问题，随时联系我。祝您生活愉快！",
      suggestions: [],
    },
  },
  {
    pattern: /^(再见|拜拜|Bye|bye|88|下次见|回头见)[\s!！。.,，]*$/,
    response: {
      answer: "再见！感谢您的咨询，祝您生活愉快。如有需要，欢迎随时回来！",
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
    this.chatAgent = new ChatAgent();
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
  private async getOrCreateConversation(sessionId: string | null) {
    if (sessionId) {
      const existing = await prisma.conversation.findFirst({
        where: { sessionId, type: "agent_chat" },
      });
      if (existing) return existing;
    }
    const conversation = await prisma.conversation.create({
      data: {
        id: randomUUID(),
        title: "智能助手会话",
        userId: AGENT_USER_ID,
        type: "agent_chat",
        sessionId,
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
    sessionId: string | null,
    userMessage: string,
    signal?: AbortSignal,
  ): AsyncGenerator<Record<string, unknown>> {
    // ── 0. 会话级并发控制：同一 sessionId 的请求串行化 ──
    // 使用带时间戳的锁条目，超时时自动垃圾回收防止僵尸锁永久阻塞
    const lockKey = sessionId ?? `anonymous-${randomUUID()}`;
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
          lockKey,
          timeoutMs: AgentRuntimeService.SESSION_LOCK_TIMEOUT_MS,
        },
        "Session lock timed out — stale lock garbage-collected, proceeding",
      );
    }

    // ── Observability Trace（提前声明，try/finally 均可访问）──
    const provider = getObservabilityProvider();
    let lfTrace = provider.createTrace({
      name: "agent-chat",
      input: { message: userMessage },
    });

    try {
      // ── 1. Session 层 ──
      const conversation = await this.getOrCreateConversation(sessionId);
      const [providerName, resolvedModel] = resolveModel(this.modelId);
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
      });
      scope.controller.start();

      // ── 2. 传统对话快速通道（零延迟） ──
      const convMatch = this.matchConversational(userMessage);
      if (convMatch) {
        const convStartTime = Date.now();

        yield* this.streamConversationalMatch(
          assistantMsgId,
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

      for await (const event of agent.execute(context, scope)) {
        if (scope.controller.shouldStop) break;

        if (!firstTokenRecorded && event.type === "token") {
          firstTokenRecorded = true;
          agentRequestDurationMs.observe(
            { route: decision.route, phase: "ttft" },
            Date.now() - startTime,
          );
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
            logger.warn(e, "Failed to persist assistant message in orchestrator");
          }
        }
      }

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

  // ── 传统对话流式输出 ──
  private async *streamConversationalMatch(
    assistantMsgId: string,
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
