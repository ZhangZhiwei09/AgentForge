import { useState, useRef, useCallback } from "react";
import { generateUUID } from "@/lib/uuid";
import { isAbortError } from "@/lib/abort-utils";
import { extractCardBlocks, dedupeBlocks } from "@agentforge/cui";
import type {
  KnowledgeResult,
  ContentBlock,
  AgentMessage,
  DiagnosisProgress,
  DiagnosisPhase,
  ClarificationRequest,
  WaitingInputRequest,
  CitationCard,
  TraceStep,
  MessageCitationsMeta,
} from "@agentforge/shared-types";

// ── metadata 校验 ──
// Message.metadata 由历史会话带出，可能被旧版本或脏数据污染，属外部数据：
// 逐字段校验后才可用于渲染，校验不过的部分直接丢弃。

function isCitationCard(v: unknown): v is CitationCard {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.index === "number" &&
    typeof r.docId === "string" &&
    typeof r.docTitle === "string" &&
    typeof r.excerpt === "string" &&
    typeof r.score === "number"
  );
}

function isTraceStep(v: unknown): v is TraceStep {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.seq === "number" &&
    (r.kind === "retrieval" || r.kind === "tool") &&
    typeof r.label === "string" &&
    (r.status === "running" || r.status === "done" || r.status === "failed")
  );
}

function parseCitationMeta(raw: unknown): MessageCitationsMeta {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const rec = raw as Record<string, unknown>;

  const citations = Array.isArray(rec.citations)
    ? rec.citations.filter(isCitationCard)
    : [];
  const traces = Array.isArray(rec.traces)
    ? rec.traces.filter(isTraceStep)
    : [];

  return {
    citations: citations.length ? citations : undefined,
    traces: traces.length ? traces : undefined,
  };
}

// Re-export for backward compatibility
export type { KnowledgeResult, ContentBlock, AgentMessage, DiagnosisProgress, DiagnosisPhase };

function isInternalDiagnosisMessage(content: string): boolean {
  return [
    "Blackboard（共享上下文）",
    "你是核身业务前端排查专家",
    "你是核身业务后端排查专家",
    "你是核身诊断的质量评估与汇总专家",
  ].some((marker) => content.includes(marker));
}

function isLegacyDiagnosisReport(content: string): boolean {
  // Older server versions persisted the internal diagnosis report as ordinary
  // assistant text. Keep those records out of the chat after refresh.
  return (
    content.includes("核身诊断质量评估与综合结论") ||
    (content.includes("多 Agent 协同诊断") &&
      (content.includes("Phase 1") ||
        content.includes("评分结果") ||
        content.includes("快速通道")))
  );
}

function isDiagnosisPhase(value: unknown): value is DiagnosisPhase {
  if (!value || typeof value !== "object") return false;
  const phase = value as Record<string, unknown>;
  return (
    typeof phase.phase === "number" &&
    typeof phase.label === "string" &&
    typeof phase.agent === "string" &&
    (phase.status === "pending" ||
      phase.status === "running" ||
      phase.status === "done" ||
      phase.status === "skipped") &&
    (phase.summary === undefined || typeof phase.summary === "string")
  );
}

function parseDiagnosisMeta(raw: unknown): {
  diagnosis?: DiagnosisProgress;
  clarification?: ClarificationRequest;
  waitingInput?: WaitingInputRequest;
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const metadata = raw as Record<string, unknown>;
  const rawDiagnosis = metadata.diagnosis;
  let diagnosis: DiagnosisProgress | undefined;

  if (rawDiagnosis && typeof rawDiagnosis === "object") {
    const value = rawDiagnosis as Record<string, unknown>;
    const phases = Array.isArray(value.phases)
      ? value.phases.filter(isDiagnosisPhase)
      : [];
    if (
      (value.status === "running" ||
        value.status === "done" ||
        value.status === "error" ||
        value.status === "waiting_input") &&
      phases.length > 0
    ) {
      diagnosis = {
        status: value.status,
        phases,
        ...(typeof value.resolution === "string"
          ? { resolution: value.resolution }
          : {}),
        ...(typeof value.finalConclusion === "string"
          ? { finalConclusion: value.finalConclusion }
          : {}),
      };
    }
  }

  const rawClarification = metadata.clarification;
  let clarification: ClarificationRequest | undefined;
  if (rawClarification && typeof rawClarification === "object") {
    const value = rawClarification as Record<string, unknown>;
    if (
      typeof value.intent === "string" &&
      Array.isArray(value.missingFields) &&
      value.missingFields.every((field) => typeof field === "string") &&
      typeof value.promptMessage === "string" &&
      Array.isArray(value.hints) &&
      value.hints.every((hint) => typeof hint === "string")
    ) {
      clarification = {
        intent: value.intent,
        missingFields: value.missingFields,
        promptMessage: value.promptMessage,
        hints: value.hints,
      };
    }
  }

  const rawWaiting = metadata.waitingInput;
  let waitingInput: WaitingInputRequest | undefined;
  if (rawWaiting && typeof rawWaiting === "object") {
    const value = rawWaiting as Record<string, unknown>;
    if (typeof value.message === "string" && Array.isArray(value.missingFields) &&
        value.missingFields.every((field) => typeof field === "string")) {
      waitingInput = { message: value.message, missingFields: value.missingFields };
    }
  }
  return { diagnosis, clarification, waitingInput };
}

interface StreamMeta {
  messageId: string;
  conversationId: string;
  sessionId: string;
  model: string;
  provider: string;
  knowledge: KnowledgeResult[];
  suggestions?: string[];
}

interface Cursor {
  before_time: string;
  before_id: string;
}

interface HistoryResponse {
  conversation_id: string;
  messages: {
    id: string;
    role: string;
    type?: string;
    content: string;
    timestamp: string;
    /** 引用卡片与过程时间轴；后端已透传，旧数据可能缺失 */
    metadata?: unknown;
  }[];
  has_more: boolean;
  next_cursor: Cursor | null;
}

export function useAgentChatStream() {
  const [messages, setMessages] = useState<AgentMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content: "您好！欢迎来到核身排障智能助手，请描述您遇到的问题",
      timestamp: Date.now(),
    },
  ]);
  const [isStreaming, setIsStreaming] = useState(false);
  const streamingRef = useRef(false);
  const [currentMeta, setCurrentMeta] = useState<StreamMeta | null>(null);
  const [conversationId, setConversationId] = useState<string>(() => {
    return localStorage.getItem("agent_chat_conversation_id") || "";
  });
  const abortRef = useRef<AbortController | null>(null);

  // 分页状态
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<Cursor | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // ── 历史加载（分页）──

  const loadHistory = useCallback(async () => {
    if (!conversationId) return;
    try {
      const params = new URLSearchParams({
        conversation_id: conversationId,
        limit: "5",
      });

      const token = localStorage.getItem("accessToken");
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const res = await fetch(
        `/api/agent/chat/history?${params.toString()}`,
        { headers },
      );
      if (!res.ok) return;

      const data: HistoryResponse = await res.json();
      if (data.messages && data.messages.length > 0) {
        const historyMsgs: AgentMessage[] = data.messages
          .filter(
            (m) =>
              !isInternalDiagnosisMessage(m.content) &&
              !(m.role === "assistant" && isLegacyDiagnosisReport(m.content)),
          )
          .map(
            (m) => {
              const diagnosisMeta =
                m.role === "assistant" ? parseDiagnosisMeta(m.metadata) : {};
              return {
                id: m.id,
                role: m.role as "user" | "assistant",
                content: m.content,
                timestamp: new Date(m.timestamp).getTime(),
                // 引用卡片、过程时间轴和诊断卡片都从 metadata 水合
                ...(m.role === "assistant" ? parseCitationMeta(m.metadata) : {}),
                ...diagnosisMeta,
              };
            },
          );
        setMessages([
          {
            id: "welcome",
            role: "assistant",
            content:
              "您好！欢迎回到核身排障智能助手，请继续描述您遇到的问题",
            timestamp: Date.now(),
          },
          ...historyMsgs,
        ]);
      }
      setHasMore(data.has_more);
      setNextCursor(data.next_cursor);
    } catch {
      // 加载失败则使用默认欢迎消息
    }
  }, [conversationId]);

  // ── 加载更早的消息（无限滚动）──

  const loadMoreHistory = useCallback(async () => {
    if (!conversationId || !hasMore || !nextCursor || isLoadingMore) return;
    setIsLoadingMore(true);

    try {
      const params = new URLSearchParams({
        conversation_id: conversationId,
        limit: "5",
        before_time: nextCursor.before_time,
        before_id: nextCursor.before_id,
      });

      const token = localStorage.getItem("accessToken");
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const res = await fetch(
        `/api/agent/chat/history?${params.toString()}`,
        { headers },
      );
      if (!res.ok) return;

      const data: HistoryResponse = await res.json();
      if (data.messages && data.messages.length > 0) {
        const olderMsgs: AgentMessage[] = data.messages
          .filter(
            (m) =>
              !isInternalDiagnosisMessage(m.content) &&
              !(m.role === "assistant" && isLegacyDiagnosisReport(m.content)),
          )
          .map(
            (m) => {
              const diagnosisMeta =
                m.role === "assistant" ? parseDiagnosisMeta(m.metadata) : {};
              return {
                id: m.id,
                role: m.role as "user" | "assistant",
                content: m.content,
                timestamp: new Date(m.timestamp).getTime(),
                ...(m.role === "assistant" ? parseCitationMeta(m.metadata) : {}),
                ...diagnosisMeta,
              };
            },
          );

        setMessages((prev) => {
          // 跳过 welcome 消息，插入到其后
          const welcome = prev[0];
          const rest = prev.slice(1);
          return [welcome, ...olderMsgs, ...rest];
        });
      }
      setHasMore(data.has_more);
      setNextCursor(data.next_cursor);
    } catch {
      // 加载失败静默处理
    } finally {
      setIsLoadingMore(false);
    }
  }, [conversationId, hasMore, nextCursor, isLoadingMore]);

  // ── 新建对话 ──

  const newChat = useCallback(() => {
    abortRef.current?.abort();
    streamingRef.current = false;
    setIsStreaming(false);
    setConversationId("");
    localStorage.removeItem("agent_chat_conversation_id");
    setMessages([
      {
        id: "welcome",
        role: "assistant",
        content:
          "您好！欢迎来到核身排障智能助手，请描述您遇到的问题",
        timestamp: Date.now(),
      },
    ]);
    setCurrentMeta(null);
    setHasMore(false);
    setNextCursor(null);
  }, []);

  // ── 切换会话 ──

  const switchConversation = useCallback(
    (newConvId: string) => {
      abortRef.current?.abort();
      streamingRef.current = false;
      setIsStreaming(false);

      setConversationId(newConvId);
      localStorage.setItem("agent_chat_conversation_id", newConvId);
      setMessages([
        {
          id: "welcome",
          role: "assistant",
          content:
            "您好！欢迎来到核身排障智能助手，请描述您遇到的问题",
          timestamp: Date.now(),
        },
      ]);
      setCurrentMeta(null);
      setHasMore(false);
      setNextCursor(null);
      // loadHistory 通过 useEffect 监听 conversationId 自动触发
    },
    [],
  );

  // ── 发送消息 ──

  const sendMessage = useCallback(
    async (input: string) => {
      const trimmed = input.trim();
      if (!trimmed || streamingRef.current) return;

      const userMsg: AgentMessage = {
        id: `msg-${Date.now()}`,
        role: "user",
        content: trimmed,
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, userMsg]);
      streamingRef.current = true;
      setIsStreaming(true);

      try {
        abortRef.current?.abort();
        abortRef.current = new AbortController();

        const token = localStorage.getItem("accessToken");
        const body: Record<string, string> = { message: trimmed };
        if (conversationId) {
          body.conversation_id = conversationId;
        }

        const res = await fetch("/api/agent/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
          signal: abortRef.current.signal,
        });

        if (!res.ok) {
          const err = await res
            .json()
            .catch(() => ({ detail: res.statusText }));
          throw new Error(err.detail ?? `HTTP ${res.status}`);
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let buffer = "";
        let streamContent = "";
        let knowledgeResults: KnowledgeResult[] | undefined;
        const contentBlocks: ContentBlock[] = [];
        let meta: StreamMeta | null = null;
        let diagnosisProgress: DiagnosisProgress | undefined;
        let clarificationData: ClarificationRequest | undefined;
        let waitingInputData: WaitingInputRequest | undefined;
        let citations: CitationCard[] = [];
        const tracesBySeq = new Map<number, TraceStep>();

        // Helper: 引用卡片/过程步骤可能早于首个 token 到达，此时 __stream__ 消息尚未创建，
        // 需在此自建，否则事件会被丢弃。
        function updateStreamWithCitations() {
          const traces = [...tracesBySeq.values()].sort((a, b) => a.seq - b.seq);
          const patch: Partial<AgentMessage> = {
            citations: citations.length ? citations : undefined,
            traces: traces.length ? traces : undefined,
          };
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.id === "__stream__") {
              return [...prev.slice(0, -1), { ...last, ...patch }];
            }
            return [
              ...prev,
              {
                id: "__stream__",
                role: "assistant" as const,
                content: "",
                timestamp: Date.now(),
                ...patch,
              },
            ];
          });
        }

        // Helper: update the stream message with current diagnosis progress
        function updateStreamWithDiagnosis(dp: DiagnosisProgress | undefined) {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.id === "__stream__") {
              return [
                ...prev.slice(0, -1),
                { ...last, diagnosis: dp },
              ];
            }
            return [
              ...prev,
              {
                id: "__stream__",
                role: "assistant" as const,
                content: "",
                timestamp: Date.now(),
                diagnosis: dp,
              },
            ];
          });
        }

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine || !trimmedLine.startsWith("data: ")) continue;

            const data = trimmedLine.slice(6);
            if (data === "[DONE]") continue;

            try {
              const chunk = JSON.parse(data);

              if (chunk.type === "meta") {
                if (chunk.conversation_id) {
                  localStorage.setItem(
                    "agent_chat_conversation_id",
                    chunk.conversation_id,
                  );
                  setConversationId(chunk.conversation_id);
                }
                if (chunk.knowledge && Array.isArray(chunk.knowledge)) {
                  knowledgeResults = chunk.knowledge;
                }
                meta = {
                  messageId: chunk.message_id,
                  conversationId: chunk.conversation_id || "",
                  sessionId: chunk.conversation_id || "",
                  model: chunk.model || "",
                  provider: chunk.provider || "",
                  knowledge: knowledgeResults || [],
                };
                setCurrentMeta(meta);
                continue;
              }

              if (chunk.type === "content_block" && chunk.block) {
                contentBlocks.push(chunk.block as ContentBlock);
                continue;
              }

              // ── 引用卡片与过程时间轴 ──
              if (chunk.type === "citations") {
                const rawItems: unknown = chunk.items;
                citations = Array.isArray(rawItems)
                  ? rawItems.filter(isCitationCard)
                  : [];
                updateStreamWithCitations();
                continue;
              }

              if (chunk.type === "trace_step") {
                const rawStep: unknown = chunk.step;
                if (isTraceStep(rawStep)) {
                  // running 与 done/failed 共用同一 seq，后到者覆盖
                  tracesBySeq.set(rawStep.seq, rawStep);
                  updateStreamWithCitations();
                }
                continue;
              }

              // ── 诊断事件处理 ──
              if (chunk.type === "diagnosis_started") {
                diagnosisProgress = {
                  status: "running",
                  phases: (chunk.agents as Array<{ name: string; role: string; phase?: number }>).map(
                    (a, index) => ({
                      phase: a.phase ?? index + 1,
                      label: a.role,
                      agent: a.name,
                      status: "pending" as const,
                    }),
                  ),
                };
                updateStreamWithDiagnosis(diagnosisProgress);
                continue;
              }

              if (chunk.type === "diagnosis_phase") {
                if (diagnosisProgress) {
                  diagnosisProgress = {
                    ...diagnosisProgress,
                    phases: diagnosisProgress.phases.map((p) =>
                      p.phase === (chunk.phase as number)
                        ? { ...p, status: "running" as const }
                        : p,
                    ),
                  };
                  updateStreamWithDiagnosis(diagnosisProgress);
                }
                continue;
              }

              if (chunk.type === "diagnosis_phase_done") {
                if (diagnosisProgress) {
                  diagnosisProgress = {
                    ...diagnosisProgress,
                    phases: diagnosisProgress.phases.map((p) =>
                      p.phase === (chunk.phase as number)
                        ? {
                            ...p,
                            status: "done" as const,
                            summary: (chunk.summary as string) ?? p.summary,
                          }
                        : p,
                    ),
                  };
                  updateStreamWithDiagnosis(diagnosisProgress);
                }
                continue;
              }

              if (chunk.type === "diagnosis_completed") {
                const output = chunk.output as Record<string, unknown>;
                const doneProgress: DiagnosisProgress = {
                  status: "done",
                  phases: (diagnosisProgress?.phases ?? []).map((phase) =>
                    phase.status === "pending" ||
                    (Array.isArray(output.skipped_nodes) && output.skipped_nodes.includes(phase.agent))
                      ? { ...phase, status: "skipped" as const }
                      : phase),
                  resolution: String(output.resolution ?? ""),
                  finalConclusion: extractConclusionFromOutput(output),
                };
                if (diagnosisProgress) {
                  diagnosisProgress = doneProgress;
                  updateStreamWithDiagnosis(diagnosisProgress);
                } else {
                  // Phase 3b HITL resume：续跑流不再重放 diagnosis_started，
                  // 局部 diagnosisProgress 为空。回填最近一条"诊断中 + 等待补充"
                  // 的 assistant 消息为完成态，并清除等待补充标记。
                  setMessages((prev) => {
                    let updated = false;
                    const next = prev.map((m) => {
                      if (updated) return m;
                      if (
                        m.role === "assistant" &&
                        m.diagnosis &&
                        m.diagnosis.status === "running"
                      ) {
                        updated = true;
                        return {
                          ...m,
                          diagnosis: doneProgress,
                          waitingInput: undefined,
                        };
                      }
                      return m;
                    });
                    return updated ? next : prev;
                  });
                }
                continue;
              }

              // ── 诊断信息采集事件 ──
              if (chunk.type === "clarification_needed") {
                clarificationData = {
                  intent: chunk.intent as string,
                  missingFields: chunk.missing_fields as string[],
                  promptMessage: chunk.prompt_message as string,
                  hints: chunk.hints as string[],
                };
                setMessages((prev) => {
                  const last = prev[prev.length - 1];
                  if (last?.id === "__stream__") {
                    return [
                      ...prev.slice(0, -1),
                      { ...last, clarification: clarificationData },
                    ];
                  }
                  return [
                    ...prev,
                    {
                      id: "__stream__",
                      role: "assistant" as const,
                      content: "",
                      timestamp: Date.now(),
                      clarification: clarificationData,
                    },
                  ];
                });
                continue;
              }

              // ── HITL 等待补充事件（Phase 3b） ──
              if (chunk.type === "diagnosis_waiting_input") {
                if (diagnosisProgress) {
                  diagnosisProgress = { ...diagnosisProgress, status: "waiting_input" };
                  updateStreamWithDiagnosis(diagnosisProgress);
                }
                waitingInputData = {
                  message: (chunk.message as string) ?? "",
                  missingFields: (chunk.missing_fields as string[]) ?? [],
                };
                setMessages((prev) => {
                  // 复用最近的"诊断中/等待补充"assistant 消息，避免续跑后
                  // re-interrupt 时产生重复的等待补充卡片。
                  let target = -1;
                  for (let i = prev.length - 1; i >= 0; i--) {
                    const m = prev[i];
                    if (m.role === "assistant" && (m.diagnosis || m.waitingInput)) {
                      target = i;
                      break;
                    }
                  }
                  if (target >= 0) {
                    const next = [...prev];
                    next[target] = {
                      ...next[target],
                      waitingInput: waitingInputData,
                    };
                    return next;
                  }
                  return [
                    ...prev,
                    {
                      id: "__stream__",
                      role: "assistant" as const,
                      content: "",
                      timestamp: Date.now(),
                      waitingInput: waitingInputData,
                    },
                  ];
                });
                continue;
              }

              if (chunk.type === "token" && chunk.content) {
                streamContent += chunk.content;
                setMessages((prev) => {
                  const last = prev[prev.length - 1];
                  if (last?.id === "__stream__") {
                    return [
                      ...prev.slice(0, -1),
                      { ...last, content: streamContent, diagnosis: diagnosisProgress, clarification: clarificationData, waitingInput: waitingInputData },
                    ];
                  }
                  return [
                    ...prev,
                    {
                      id: "__stream__",
                      role: "assistant" as const,
                      content: streamContent,
                      timestamp: Date.now(),
                      knowledge: knowledgeResults,
                      diagnosis: diagnosisProgress,
                      clarification: clarificationData,
                      waitingInput: waitingInputData,
                    },
                  ];
                });
              } else if (chunk.type === "error") {
                console.error("Stream error:", chunk.content);
                if (diagnosisProgress) {
                  diagnosisProgress = {
                    ...diagnosisProgress,
                    status: "error",
                    finalConclusion:
                      typeof chunk.content === "string"
                        ? chunk.content
                        : "诊断过程出现异常，请稍后重试。",
                  };
                  updateStreamWithDiagnosis(diagnosisProgress);
                }
              } else if (chunk.type === "done") {
                if (chunk.suggestions && meta) {
                  meta = { ...meta, suggestions: chunk.suggestions };
                  setCurrentMeta(meta);
                }

                const { blocks: parsedBlocks } =
                  extractCardBlocks(streamContent);
                const allBlocks = dedupeBlocks([
                  ...contentBlocks,
                  ...parsedBlocks.map((b) => b.block),
                ]);

                if (chunk.message_id) {
                  setMessages((prev) => {
                    const last = prev[prev.length - 1];
                    if (last?.id === "__stream__") {
                      return [
                        ...prev.slice(0, -1),
                        {
                          ...last,
                          id: chunk.message_id as string,
                          content: streamContent,
                          knowledge: knowledgeResults,
                          contentBlocks:
                            allBlocks.length > 0 ? allBlocks : undefined,
                          diagnosis: diagnosisProgress ?? last.diagnosis,
                          clarification: clarificationData ?? last.clarification,
                          waitingInput: waitingInputData ?? last.waitingInput,
                          citations: citations.length
                            ? citations
                            : last.citations,
                          traces: tracesBySeq.size
                            ? [...tracesBySeq.values()].sort(
                                (a, b) => a.seq - b.seq,
                              )
                            : last.traces,
                        },
                      ];
                    }
                    return prev;
                  });
                }
              }
            } catch {
              continue;
            }
          }
        }
      } catch (err: unknown) {
        if (isAbortError(err)) {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.id === "__stream__") {
              return [
                ...prev.slice(0, -1),
                { ...last, id: `msg-${Date.now()}` },
              ];
            }
            return prev;
          });
          return;
        }
        console.error("Agent chat failed:", err);
        setMessages((prev) => [
          ...prev,
          {
            id: `msg-${Date.now()}`,
            role: "assistant",
            content: "抱歉，暂时无法连接服务，请稍后再试。",
            timestamp: Date.now(),
          },
        ]);
      } finally {
        streamingRef.current = false;
        setIsStreaming(false);
      }
    },
    [conversationId],
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // 兼容旧代码：暴露 sessionId 别名
  const sessionId = conversationId;

  return {
    messages,
    isStreaming,
    sessionId,
    conversationId,
    currentMeta,
    hasMore,
    isLoadingMore,
    sendMessage,
    loadHistory,
    loadMoreHistory,
    newChat,
    switchSession: switchConversation,
    switchConversation,
    abort,
  };
}

/** Extract a human-readable conclusion string from diagnosis_completed output */
function extractConclusionFromOutput(
  output: Record<string, unknown>,
): string {
  const finalDiag = output.final_diagnosis as Record<string, unknown> | undefined;
  if (finalDiag) {
    if (typeof finalDiag.conclusion === "string") return finalDiag.conclusion;
    if (typeof finalDiag.message === "string") return finalDiag.message;

    const sections: string[] = [];
    const frontendView = finalDiag.frontend_view;
    const backendView = finalDiag.backend_view;
    if (
      frontendView &&
      typeof frontendView === "object" &&
      typeof (frontendView as Record<string, unknown>).conclusion === "string"
    ) {
      sections.push(
        `前端排查结论：${(frontendView as Record<string, unknown>).conclusion}`,
      );
    }
    if (
      backendView &&
      typeof backendView === "object" &&
      typeof (backendView as Record<string, unknown>).conclusion === "string"
    ) {
      sections.push(
        `后端排查结论：${(backendView as Record<string, unknown>).conclusion}`,
      );
    }
    if (sections.length > 0) return sections.join("\n\n");
  }
  if (typeof output.conclusion === "string") {
    const parsed = tryExtractJsonField(output.conclusion, "conclusion");
    return parsed ?? output.conclusion;
  }
  return "";
}

/** Try to extract a field value from a JSON string */
function tryExtractJsonField(text: string, field: string): string | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed[field] === "string") return parsed[field] as string;
  } catch {
    // Not valid JSON, try regex-based extraction
  }
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as Record<string, unknown>;
      if (typeof parsed[field] === "string") return parsed[field] as string;
    } catch {
      // Not parseable
    }
  }
  return null;
}
