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
} from "@agentforge/shared-types";

// Re-export for backward compatibility
export type { KnowledgeResult, ContentBlock, AgentMessage, DiagnosisProgress, DiagnosisPhase };

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
        const historyMsgs: AgentMessage[] = data.messages.map(
          (m) => ({
            id: m.id,
            role: m.role as "user" | "assistant",
            content: m.content,
            timestamp: new Date(m.timestamp).getTime(),
          }),
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
        const olderMsgs: AgentMessage[] = data.messages.map(
          (m) => ({
            id: m.id,
            role: m.role as "user" | "assistant",
            content: m.content,
            timestamp: new Date(m.timestamp).getTime(),
          }),
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

              // ── 诊断事件处理 ──
              if (chunk.type === "diagnosis_started") {
                diagnosisProgress = {
                  status: "running",
                  phases: (chunk.agents as Array<{ name: string; role: string }>).map(
                    (a: { name: string; role: string }) => ({
                      phase:
                        a.name === "frontend_agent"
                          ? 1
                          : a.name === "backend_agent"
                            ? 2
                            : 3,
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
                  phases: diagnosisProgress?.phases ?? [],
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
