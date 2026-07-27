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
} from "@agentforge/shared-types";

// Re-export for backward compatibility
export type { KnowledgeResult, ContentBlock, AgentMessage, DiagnosisProgress, DiagnosisPhase };

interface StreamMeta {
  messageId: string;
  sessionId: string;
  model: string;
  provider: string;
  knowledge: KnowledgeResult[];
  suggestions?: string[];
}

export function useAgentChatStream() {
  const [messages, setMessages] = useState<AgentMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content: "您好！欢迎来到 AgentForge 智能助手，有什么可以帮助您的吗？",
      timestamp: Date.now(),
    },
  ]);
  const [isStreaming, setIsStreaming] = useState(false);
  const streamingRef = useRef(false);
  const [currentMeta, setCurrentMeta] = useState<StreamMeta | null>(null);
  const [sessionId, setSessionId] = useState<string>(() => {
    return localStorage.getItem("agent_chat_session_id") || generateUUID();
  });
  const abortRef = useRef<AbortController | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/agent/chat/history?session_id=${sessionId}`,
      );
      if (!res.ok) return;
      const data = await res.json();
      if (data.messages && data.messages.length > 0) {
        const historyMsgs: AgentMessage[] = data.messages.map(
          (m: {
            id: string;
            role: string;
            content: string;
            timestamp: string;
          }) => ({
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
              "您好！欢迎回到 AgentForge 智能助手，有什么可以帮助您的吗？",
            timestamp: Date.now(),
          },
          ...historyMsgs,
        ]);
      }
    } catch {
      // 加载失败则使用默认欢迎消息
    }
  }, [sessionId]);

  const newChat = useCallback(() => {
    const newId = generateUUID();
    setSessionId(newId);
    localStorage.setItem("agent_chat_session_id", newId);
    setMessages([
      {
        id: "welcome",
        role: "assistant",
        content:
          "您好！欢迎来到 AgentForge 智能助手，有什么可以帮助您的吗？",
        timestamp: Date.now(),
      },
    ]);
    setCurrentMeta(null);
  }, []);

  const switchSession = useCallback(
    (newSessionId: string) => {
      // 终止当前进行中的流
      abortRef.current?.abort();
      streamingRef.current = false;
      setIsStreaming(false);

      setSessionId(newSessionId);
      localStorage.setItem("agent_chat_session_id", newSessionId);
      setMessages([
        {
          id: "welcome",
          role: "assistant",
          content:
            "您好！欢迎来到 AgentForge 智能助手，有什么可以帮助您的吗？",
          timestamp: Date.now(),
        },
      ]);
      setCurrentMeta(null);
      // loadHistory 通过 useEffect 监听 sessionId 自动触发
    },
    [],
  );

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

        const res = await fetch("/api/agent/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, message: trimmed }),
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
            // Create stream message if it doesn't exist yet (diagnosis may arrive before tokens)
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
                if (chunk.session_id) {
                  localStorage.setItem(
                    "agent_chat_session_id",
                    chunk.session_id,
                  );
                  setSessionId(chunk.session_id);
                }
                if (chunk.knowledge && Array.isArray(chunk.knowledge)) {
                  knowledgeResults = chunk.knowledge;
                }
                meta = {
                  messageId: chunk.message_id,
                  sessionId: chunk.session_id || sessionId,
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
                    (a) => ({
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
                if (diagnosisProgress) {
                  const output = chunk.output as Record<string, unknown>;
                  diagnosisProgress = {
                    ...diagnosisProgress,
                    status: "done",
                    resolution: String(output.resolution ?? ""),
                    finalConclusion:
                      extractConclusionFromOutput(output),
                  };
                  updateStreamWithDiagnosis(diagnosisProgress);
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

              if (chunk.type === "token" && chunk.content) {
                streamContent += chunk.content;
                setMessages((prev) => {
                  const last = prev[prev.length - 1];
                  if (last?.id === "__stream__") {
                    return [
                      ...prev.slice(0, -1),
                      { ...last, content: streamContent, diagnosis: diagnosisProgress, clarification: clarificationData },
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
    [sessionId],
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return {
    messages,
    isStreaming,
    sessionId,
    currentMeta,
    sendMessage,
    loadHistory,
    newChat,
    switchSession,
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
    // output.conclusion 可能是 LLM 原始 JSON 文本，尝试从中提取
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
  // Try finding JSON in the text via regex
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
