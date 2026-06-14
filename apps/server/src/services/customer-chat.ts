// 客服聊天服务 —— Agent Router + RAG + Tools 架构
//
// 编排器职责：
//   1. Session 管理（获取/创建会话、加载历史）
//   2. 传统对话快速通道（正则零延迟匹配问候/感谢/道别）
//   3. QueryRouter 分类（LLM 驱动 → SAFETY|SMALL_TALK|BUSINESS|TOOL|HUMAN）
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
  csRouteClassificationTotal,
  csRouteConfidence,
} from "../observability/metrics.js";
import { intentDetector } from "./intent-detector.js";
import { MemoryEngine } from "./memory-engine.js";

import { QueryRouter } from "./customer-chat/router.js";
import { SafetyAgent } from "./customer-chat/safety-agent.js";
import { SmallTalkAgent } from "./customer-chat/smalltalk-agent.js";

import {
  fetchKnowledge,
  injectMemories,
} from "./customer-chat/business-agent.js";
import { ToolAgent } from "./customer-chat/tool-agent.js";
import { HumanAgent } from "./customer-chat/human-agent.js";

import type {
  RouteName,
  RouteContext,
  RouteStreamEvent,
  RouteAgent,
  KnowledgeChunkResult,
} from "./customer-chat/types.js";
import {
  SORRY_TEMPLATE,
  type ChatResponse,
} from "./customer-chat/validation.js";

// Re-export for backward compatibility with existing tests
export {
  SORRY_TEMPLATE,
  FALLBACK_PREFIX,
  ChatResponseSchema,
  FORBIDDEN_PATTERNS,
} from "./customer-chat/validation.js";
export type { KnowledgeChunkResult } from "./customer-chat/types.js";

// ═══════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════

const CUSTOMER_USER_ID = "00000000-0000-0000-0000-000000000002";
const MAX_HISTORY_MESSAGES = 20;

// 工作时间
const SERVICE_HOURS_START = parseInt(
  process.env.CS_SERVICE_HOURS_START || "9",
  10,
);
const SERVICE_HOURS_END = parseInt(
  process.env.CS_SERVICE_HOURS_END || "18",
  10,
);
const SERVICE_DAYS = (process.env.CS_SERVICE_DAYS || "1,2,3,4,5")
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
        "您好！欢迎来到 AgentForge 智能客服中心 😊 请问有什么可以帮助您的？",
      suggestions: ["查询订单", "退货退款政策", "联系人工客服"],
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
// CustomerChatService（薄编排器）
// ═══════════════════════════════════════════════════════

export class CustomerChatService {
  private modelId: string | null;
  private router: QueryRouter;
  private safetyAgent: SafetyAgent;
  private smallTalkAgent: SmallTalkAgent;
  private toolAgent: ToolAgent;
  private humanAgent: HumanAgent;

  // 会话级并发控制：同一 sessionId 的请求串行化，防止竞态条件
  // 使用 Promise 链式串行化而非阻塞式互斥锁，避免饿死 Node 事件循环
  //
  // 内存安全：Map 上限 MAX_SESSION_LOCKS 条，超出时淘汰最旧的 entry（LRU 语义）。
  // 正常路径下 finally 块会清理，上限仅在异常泄漏时触发（如客户端断连后锁未释放）。
  private static sessionLocks = new Map<string, Promise<void>>();
  private static readonly MAX_SESSION_LOCKS = 1000;

  constructor(modelId?: string | null) {
    this.modelId = modelId || null;
    this.router = new QueryRouter(modelId);
    this.safetyAgent = new SafetyAgent();
    this.smallTalkAgent = new SmallTalkAgent();
    this.toolAgent = new ToolAgent();
    this.humanAgent = new HumanAgent();

    // 强类型路由注册表：确保每个 RouteName 都有对应 Agent 实现
    this.agentRegistry = {
      SAFETY: this.safetyAgent,
      SMALL_TALK: this.smallTalkAgent,
      TOOL: this.toolAgent,
      HUMAN: this.humanAgent,
    };
  }

  // ── 会话管理 ──
  private async getOrCreateConversation(sessionId: string | null) {
    if (sessionId) {
      const existing = await prisma.conversation.findFirst({
        where: { sessionId, type: "customer_service" },
      });
      if (existing) return existing;
    }
    const conversation = await prisma.conversation.create({
      data: {
        id: randomUUID(),
        title: "客服会话",
        userId: CUSTOMER_USER_ID,
        type: "customer_service",
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

  // ── Agent 路由表 —— Rule First + LLM Fallback 架构 ──
  // SAFETY / HUMAN: 规则命中直接处理
  // SMALL_TALK: 简单 LLM 响应
  // TOOL: 统一 Agent，有全部工具（RAG + 订单 + 物流 + 退货 + 工单）
  //
  // 使用 Record 强类型注册表替代 switch，确保每个 RouteName 都有对应的 Agent
  private readonly agentRegistry: Record<RouteName, RouteAgent>;

  private resolveAgent(route: RouteName): RouteAgent {
    const agent = this.agentRegistry[route];
    if (!agent) {
      // 防御性编程：如果 RouteName 扩展了新值但忘记注册，这里会明确报错
      // 而不是静默返回 undefined 导致 NPE
      throw new Error(`[CustomerChatService] 未注册的 RouteAgent: ${route}`);
    }
    return agent;
  }

  // ═══════════════════════════════════════════════════════
  // 主流程
  // ═══════════════════════════════════════════════════════

  async *streamChat(
    sessionId: string | null,
    userMessage: string,
  ): AsyncGenerator<Record<string, unknown>> {
    // ── 0. 会话级并发控制：同一 sessionId 的请求串行化 ──
    const lockKey = sessionId ?? `anonymous-${randomUUID()}`;
    const previousLock =
      CustomerChatService.sessionLocks.get(lockKey) ?? Promise.resolve();

    // 创建当前请求的完成信号（在 finally 中 resolve）
    let releaseLock: () => void;
    const currentLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    // 防御性淘汰：Map 超过上限时逐出最旧的 entry（防止异常泄漏导致 OOM）
    if (
      CustomerChatService.sessionLocks.size >=
      CustomerChatService.MAX_SESSION_LOCKS
    ) {
      const firstKey = CustomerChatService.sessionLocks.keys().next().value;
      if (firstKey !== undefined) {
        CustomerChatService.sessionLocks.delete(firstKey);
        logger.warn(
          {
            evictedKey: firstKey,
            mapSize: CustomerChatService.sessionLocks.size,
          },
          "Session lock map exceeded limit, evicted oldest entry",
        );
      }
    }
    CustomerChatService.sessionLocks.set(lockKey, currentLock);

    // 等待前一个同 session 的请求完成
    await previousLock;

    try {
      // ── 1. Session 层 ──
      const conversation = await this.getOrCreateConversation(sessionId);
      const [providerName, resolvedModel] = resolveModel(this.modelId);
      const withinHours = this.isWithinServiceHours();

      // 意图识别（用于日志和 fallback）
      const { intent } = intentDetector.detect(userMessage);

      // 加载历史
      const history = await prisma.message.findMany({
        where: { conversationId: conversation.id },
        orderBy: { createdAt: "desc" },
        take: MAX_HISTORY_MESSAGES,
      });
      const reversed = history.reverse();

      // 历史消息转换为 ChatMessage[]
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

      // ── 2. 传统对话快速通道（零延迟） ──
      const convMatch = this.matchConversational(userMessage);
      if (convMatch) {
        yield* this.streamConversationalMatch(
          assistantMsgId,
          conversation.sessionId,
          resolvedModel,
          providerName,
          withinHours,
          intent,
          convMatch,
        );

        // 保存助手消息
        await prisma.message.create({
          data: {
            id: assistantMsgId,
            conversationId: conversation.id,
            role: "assistant",
            content: convMatch.answer,
            model: resolvedModel,
          },
        });

        return;
      }

      // ── 3. QueryRouter 分类 ──
      const decision = await this.router.classify(userMessage, historyMessages);

      logger.info(
        {
          route: decision.route,
          confidence: decision.confidence,
          sessionId: conversation.sessionId,
        },
        "Router classified customer message",
      );

      // ── 路由分类指标埋点 ──
      const source = decision.reasoning.includes("关键词命中")
        ? "keyword"
        : decision.reasoning.includes("fallback")
          ? "fallback"
          : "llm";
      csRouteClassificationTotal.inc({
        route: decision.route,
        source,
      });
      csRouteConfidence.observe({ route: decision.route }, decision.confidence);

      // ── 4. 构建 RouteContext（含 Intent Classifier 的工具推荐） ──
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
        toolHints: decision.tools,
        executionHint: decision.execution_order,
      };

      // ── 5. KB 预加载（统一 Agent 架构：不再预加载，Agent 按需调用 search_knowledge_base 工具） ──

      // ── 5b. Memory 注入（所有路由通用） ──
      const [memCtx, mems] = await injectMemories(
        userMessage,
        conversation.sessionId,
      );
      context.memoryContext = memCtx;
      context.injectedMemories = mems;

      // ── 6. 分发到对应 Agent，收集 answer ──
      const agent = this.resolveAgent(decision.route);
      let streamedAnswer = "";

      for await (const event of agent.execute(context)) {
        if (event.type === "token") {
          streamedAnswer += event.content;
        }
        yield event;
      }

      // ── 7. 保存助手消息 ──
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

      // ── 8. 提取记忆 ──
      if (conversation.sessionId && streamedAnswer) {
        try {
          const engine = new MemoryEngine();
          const allMessages = [
            ...historyMessages.map((m) => ({
              role: m.role,
              content: m.content ?? "",
            })),
            { role: "user" as const, content: userMessage },
            { role: "assistant" as const, content: streamedAnswer },
          ];
          const extracted = await engine.extractAndStore(
            allMessages,
            CUSTOMER_USER_ID,
            conversation.id,
            providerName,
            conversation.sessionId,
          );
          if (extracted.length > 0) {
            logger.info(
              { count: extracted.length, sessionId: conversation.sessionId },
              "Customer memories extracted",
            );
          }
        } catch (e) {
          logger.warn(e, "Customer memory extraction failed");
        }
      }
    } finally {
      // 释放会话锁：允许下一个同 sessionId 的请求进入
      releaseLock!();
      if (CustomerChatService.sessionLocks.get(lockKey) === currentLock) {
        CustomerChatService.sessionLocks.delete(lockKey);
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
