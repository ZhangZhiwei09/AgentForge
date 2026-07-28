import { useState, useRef, useCallback } from "react";
import { generateUUID } from "@/lib/uuid";
import { isAbortError } from "@/lib/abort-utils";
import { parseSSEChunk } from "@/lib/sse-guards";
import { extractCardBlocks, blockKey, dedupeBlocks } from "@agentforge/cui";
import type {
  KnowledgeResult,
  CSMessage,
  ContentBlock,
} from "@agentforge/shared-types";

// Re-export CSMessage for backward compatibility (components currently import from here)
export type { KnowledgeResult, CSMessage, ContentBlock };

interface StreamMeta {
  messageId: string;
  sessionId: string;
  model: string;
  provider: string;
  knowledge: KnowledgeResult[];
  suggestions?: string[];
}

export function useCustomerChatStream() {
  const [messages, setMessages] = useState<CSMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content: "您好！欢迎来到核身排障助手，请描述您遇到的核身问题",
      timestamp: Date.now(),
    },
  ]);
  const [isStreaming, setIsStreaming] = useState(false);
  const streamingRef = useRef(false);
  const [currentMeta, setCurrentMeta] = useState<StreamMeta | null>(null);
  const [sessionId, setSessionId] = useState<string>(() => {
    return localStorage.getItem("customer_chat_session_id") || generateUUID();
  });
  const abortRef = useRef<AbortController | null>(null);

  // 从后端加载会话历史
  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/agent/chat/history?session_id=${sessionId}`,
      );
      if (!res.ok) return;
      const data: unknown = await res.json();
      if (
        typeof data !== "object" ||
        data === null ||
        !("messages" in data) ||
        !Array.isArray((data as Record<string, unknown>).messages)
      ) {
        return;
      }
      const msgArray = (data as { messages: unknown[] }).messages;
      if (msgArray.length > 0) {
        const historyMsgs: CSMessage[] = msgArray.map(
          (m: unknown) => {
            const msg = m as Record<string, unknown>;
            return {
              id: String(msg.id ?? ""),
              role:
                msg.role === "user" || msg.role === "assistant"
                  ? msg.role
                  : "assistant",
              content: String(msg.content ?? ""),
              timestamp: msg.timestamp
                ? new Date(String(msg.timestamp)).getTime()
                : Date.now(),
            };
          },
        );
        setMessages([
          {
            id: "welcome",
            role: "assistant",
            content:
              "您好！欢迎回到核身排障助手，请继续描述您遇到的核身问题",
            timestamp: Date.now(),
          },
          ...historyMsgs,
        ]);
      }
    } catch {
      // 新用户或无历史记录是正常场景，静默回退到默认欢迎消息
      console.warn("Failed to load chat history, using default welcome message");
    }
  }, [sessionId]);

  const clearSession = useCallback(() => {
    const newId = generateUUID();
    setSessionId(newId);
    localStorage.setItem("customer_chat_session_id", newId);
    setMessages([
      {
        id: "welcome",
        role: "assistant",
        content:
          "您好！欢迎来到核身排障助手，请描述您遇到的核身问题",
        timestamp: Date.now(),
      },
    ]);
    setCurrentMeta(null);
  }, []);

  const sendMessage = useCallback(
    async (input: string) => {
      const trimmed = input.trim();
      if (!trimmed || streamingRef.current) return;

      const userMsg: CSMessage = {
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
          const errDetail = (err as Record<string, unknown>).detail;
          throw new Error(
            typeof errDetail === "string" ? errDetail : `HTTP ${res.status}`,
          );
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let buffer = "";
        let streamContent = "";
        let knowledgeResults: KnowledgeResult[] | undefined;
        const contentBlocks: ContentBlock[] = [];
        let meta: StreamMeta | null = null;

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

            // 边界校验：JSON.parse + Type Guard 替代裸 any
            let chunk;
            try {
              const raw: unknown = JSON.parse(data);
              chunk = parseSSEChunk(raw);
            } catch {
              console.warn("SSE JSON parse failed:", data.slice(0, 100));
              continue;
            }

            if (!chunk) {
              console.warn("Invalid SSE chunk:", data.slice(0, 100));
              continue;
            }

            // chunk 已通过 parseSSEChunk 校验，类型自动 narrowing
            if (chunk.type === "meta") {
              if (chunk.session_id) {
                localStorage.setItem(
                  "customer_chat_session_id",
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

            // content_block 事件：ToolAgent 结构化卡片
            if (chunk.type === "content_block") {
              contentBlocks.push(chunk.block);
              continue;
            }

            if (chunk.type === "token") {
              streamContent += chunk.content;
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.id === "__stream__") {
                  return [
                    ...prev.slice(0, -1),
                    { ...last, content: streamContent },
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

              // 解析 markdown 中的卡片围栏
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
                        id: chunk.message_id,
                        content: streamContent,
                        knowledge: knowledgeResults,
                        contentBlocks:
                          allBlocks.length > 0 ? allBlocks : undefined,
                      },
                    ];
                  }
                  return prev;
                });
              }
            }
          }
        }
      } catch (err: unknown) {
        if (isAbortError(err)) {
          // Preserve partial streaming content with a real message ID
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
        console.error("Customer chat failed:", err);
        setMessages((prev) => [
          ...prev,
          {
            id: `msg-${Date.now()}`,
            role: "assistant",
            content: "抱歉，暂时无法连接客服，请稍后再试。",
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
    clearSession,
    abort,
  };
}
