import { useState, useRef, useCallback } from "react";
import { generateUUID } from "@/lib/uuid";
import { isAbortError } from "@/lib/abort-utils";
import { extractCardBlocks } from "@/components/markdown/card-parser";
import type {
  KnowledgeResult,
  ToolCallRecord,
  CSMessage,
  ContentBlock,
} from "@agentforge/shared-types";

// Re-export CSMessage for backward compatibility (components currently import from here)
export type { KnowledgeResult, ToolCallRecord, CSMessage, ContentBlock };

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
      content: "您好！欢迎来到 AgentForge 智能客服中心，有什么可以帮助您的吗？",
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
        `/api/customer-chat/history?session_id=${sessionId}`,
      );
      if (!res.ok) return;
      const data = await res.json();
      if (data.messages && data.messages.length > 0) {
        const historyMsgs: CSMessage[] = data.messages.map(
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
              "您好！欢迎回到 AgentForge 智能客服中心，有什么可以帮助您的吗？",
            timestamp: Date.now(),
          },
          ...historyMsgs,
        ]);
      }
    } catch {
      // 加载失败则使用默认欢迎消息
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
          "您好！欢迎来到 AgentForge 智能客服中心，有什么可以帮助您的吗？",
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

        const res = await fetch("/api/customer-chat", {
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
        const toolCalls: ToolCallRecord[] = [];
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

            try {
              const chunk = JSON.parse(data);

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

              // ── 新增：content_block 事件（ToolAgent 结构化卡片） ──
              if (chunk.type === "content_block" && chunk.block) {
                contentBlocks.push(chunk.block as ContentBlock);
                continue;
              }

              if (chunk.type === "tool_call" && chunk.tool_call) {
                toolCalls.push({
                  id: chunk.tool_call.id,
                  name: chunk.tool_call.name,
                  arguments: chunk.tool_call.arguments,
                  status: "pending",
                });
                setMessages((prev) => {
                  const last = prev[prev.length - 1];
                  if (last?.id === "__stream__") {
                    return [
                      ...prev.slice(0, -1),
                      {
                        ...last,
                        content: streamContent,
                        toolCalls: [...toolCalls],
                      },
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
                      toolCalls: [...toolCalls],
                    },
                  ];
                });
                continue;
              }

              if (chunk.type === "tool_result" && chunk.tool_result) {
                const idx = toolCalls.findIndex(
                  (tc) => tc.id === chunk.tool_result!.tool_call_id,
                );
                if (idx >= 0) {
                  toolCalls[idx] = {
                    ...toolCalls[idx],
                    result: chunk.tool_result.result,
                    status: "done",
                  };
                }
                setMessages((prev) => {
                  const last = prev[prev.length - 1];
                  if (last?.id === "__stream__") {
                    return [
                      ...prev.slice(0, -1),
                      {
                        ...last,
                        content: streamContent,
                        toolCalls: [...toolCalls],
                      },
                    ];
                  }
                  return prev;
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
                      toolCalls: [...toolCalls],
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

                // ── 解析 markdown 中的卡片围栏 ──
                const { blocks: parsedBlocks } =
                  extractCardBlocks(streamContent);
                const allBlocks = deduplicateBlocks([
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
                          toolCalls: [...toolCalls],
                          contentBlocks:
                            allBlocks.length > 0 ? allBlocks : undefined,
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

/**
 * 去重 ContentBlock 数组：按卡片类型和关键字段去重
 * 避免 SSE content_block 事件和 Markdown fence 解析产生重复卡片
 */
function deduplicateBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const seen = new Set<string>();
  return blocks.filter((b) => {
    const key = blockKey(b);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function blockKey(block: ContentBlock): string {
  if (block.type === "order_card") {
    return `order:${block.data.orderId}`;
  }
  if (block.type === "status_card") {
    return `status:${block.data.title}`;
  }
  if (block.type === "policy_card") {
    return `policy:${block.data.category}:${block.data.title}`;
  }
  if (block.type === "action_card") {
    return `action:${block.data.title}`;
  }
  // Use JSON for fallback
  return `${block.type}:${JSON.stringify((block as unknown as Record<string, unknown>).data || block)}`;
}
