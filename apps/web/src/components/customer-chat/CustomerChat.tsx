import { useState, useRef, useEffect, type KeyboardEvent } from "react";
import { generateUUID } from "@/lib/uuid";
import {
  MessageCircle,
  X,
  Send,
  Square,
  Trash2,
  BookOpen,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { QuickReplies } from "./QuickReplies";
import { RichMessageRenderer } from "@/components/markdown/RichMessageRenderer";
import { extractCardBlocks } from "@/components/markdown/card-parser";
import { parseSSEChunk, dedupeBlocks } from "@/lib/sse-guards";
import type {
  KnowledgeResult,
  CSMessage,
  ContentBlock,
} from "@agentforge/shared-types";

// 使用共享类型，本地别名保持代码兼容
type ChatMessage = CSMessage;

export function CustomerChat() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content: "您好！欢迎来到 AgentForge，有什么可以帮助您的吗？",
      timestamp: Date.now(),
    },
  ]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  // 展开/收起知识库参考来源（按消息 ID）
  const [expandedKnowledge, setExpandedKnowledge] = useState<Set<string>>(
    new Set(),
  );
  const [sessionId, setSessionId] = useState<string>(() => {
    return localStorage.getItem("customer_chat_session_id") || generateUUID();
  });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  function clearSession() {
    const newId = generateUUID();
    setSessionId(newId);
    localStorage.setItem("customer_chat_session_id", newId);
    setMessages([
      {
        id: "welcome",
        role: "assistant",
        content: "您好！欢迎来到 AgentForge，有什么可以帮助您的吗？",
        timestamp: Date.now(),
      },
    ]);
    setExpandedKnowledge(new Set());
    setSuggestions([]);
  }

  // 新消息时自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // 打开窗口时聚焦输入框
  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  // 组件卸载时取消请求
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // 切换某个消息的知识库展开状态
  function toggleKnowledge(msgId: string) {
    setExpandedKnowledge((prev) => {
      const next = new Set(prev);
      if (next.has(msgId)) {
        next.delete(msgId);
      } else {
        next.add(msgId);
      }
      return next;
    });
  }

  async function handleSend() {
    const trimmed = input.trim();
    if (!trimmed) return;
    sendMessage(trimmed);
  }

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: "user",
      content: trimmed,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setSuggestions([]);
    setIsTyping(true);

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
        const err = await res.json().catch(() => ({ detail: res.statusText }));
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
          // meta 事件：携带知识库检索结果
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
            continue;
          }

          // content_block 事件：ToolAgent 产出的结构化卡片
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
          } else if (chunk.type === "done") {
            if (chunk.suggestions && Array.isArray(chunk.suggestions)) {
              setSuggestions(chunk.suggestions);
            }

            // 解析 markdown 中的卡片围栏
            const { blocks: parsedBlocks } = extractCardBlocks(streamContent);
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
          } else if (chunk.type === "error") {
            console.error("Stream error:", chunk.content);
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // Preserve partial streaming content
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.id === "__stream__") {
            return [...prev.slice(0, -1), { ...last, id: `msg-${Date.now()}` }];
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
      setIsTyping(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // 分数颜色映射：绿色高相关，黄色中等，红色低相关
  function scoreColor(score: number): string {
    if (score >= 0.8) return "text-green-600 bg-green-50";
    if (score >= 0.5) return "text-amber-600 bg-amber-50";
    return "text-red-500 bg-red-50";
  }

  return (
    <>
      {/* 浮动按钮 */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:shadow-xl hover:scale-110 active:scale-95 transition-all duration-200"
          aria-label="打开客服聊天"
        >
          <MessageCircle className="h-6 w-6" />
        </button>
      )}

      {/* 聊天窗口 */}
      {isOpen && (
        <div
          className="fixed bottom-6 right-6 z-50 flex w-[420px] max-w-[calc(100vw-3rem)] flex-col rounded-2xl border border-[hsl(var(--border))] bg-white shadow-2xl animate-fade-in overflow-hidden"
          style={{ height: "560px", maxHeight: "calc(100vh - 6rem)" }}
        >
          {/* 头部 */}
          <div className="flex items-center justify-between border-b border-[hsl(var(--border))] bg-[hsl(var(--primary))] px-5 py-4 text-[hsl(var(--primary-foreground))]">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/20">
                <MessageCircle className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-semibold">客服中心</p>
                <p className="text-xs opacity-80">我们随时为您服务</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={clearSession}
                className="rounded-full p-1.5 transition-colors hover:bg-white/20"
                aria-label="清空对话"
                title="清空对话"
              >
                <Trash2 className="h-4 w-4" />
              </button>
              <button
                onClick={() => setIsOpen(false)}
                className="rounded-full p-1.5 transition-colors hover:bg-white/20"
                aria-label="关闭客服聊天"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          {/* 消息列表 */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 bg-[hsl(var(--muted))]/30">
            {messages.map((msg) => (
              <div key={msg.id}>
                <div
                  className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"} animate-fade-in`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                      msg.role === "user"
                        ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-br-md"
                        : "bg-white border border-[hsl(var(--border))] text-[hsl(var(--foreground))] rounded-bl-md"
                    }`}
                  >
                    {msg.id === "__stream__" ? (
                      <div>
                        <RichMessageRenderer
                          content={msg.content}
                          isStreaming
                        />
                        <span className="inline-block w-1.5 h-4 ml-0.5 bg-current animate-pulse rounded-sm align-middle" />
                      </div>
                    ) : (
                      <RichMessageRenderer content={msg.content} />
                    )}
                  </div>
                </div>

                {/* 知识库参考来源（仅 assistant 消息 + 有检索结果时显示） */}
                {msg.role === "assistant" &&
                  msg.knowledge &&
                  msg.knowledge.length > 0 && (
                    <div className="mt-1.5 ml-1">
                      <button
                        onClick={() => toggleKnowledge(msg.id)}
                        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <BookOpen className="h-3 w-3" />
                        参考来源 ({msg.knowledge.length})
                        {expandedKnowledge.has(msg.id) ? (
                          <ChevronUp className="h-3 w-3" />
                        ) : (
                          <ChevronDown className="h-3 w-3" />
                        )}
                      </button>

                      {expandedKnowledge.has(msg.id) && (
                        <div className="mt-1.5 space-y-1.5">
                          {msg.knowledge.map((kr, i) => (
                            <div
                              key={i}
                              className="rounded-lg border border-[hsl(var(--border))] bg-white p-2.5 text-xs"
                            >
                              <div className="flex items-center justify-between mb-1">
                                <span className="font-medium text-muted-foreground">
                                  #{i + 1} {kr.docTitle}
                                </span>
                                <span
                                  className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-mono font-medium ${scoreColor(kr.score)}`}
                                >
                                  相似度 {kr.score.toFixed(4)}
                                </span>
                              </div>
                              <p className="text-muted-foreground leading-relaxed line-clamp-3">
                                {kr.content}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
              </div>
            ))}

            {/* 正在输入提示 */}
            {isTyping && (
              <div className="flex justify-start animate-fade-in">
                <div className="rounded-2xl rounded-bl-md border border-[hsl(var(--border))] bg-white px-4 py-3">
                  <div className="flex gap-1">
                    <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400 [animation-delay:0ms]" />
                    <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400 [animation-delay:150ms]" />
                    <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400 [animation-delay:300ms]" />
                  </div>
                </div>
              </div>
            )}

            {/* 快捷追问建议 */}
            {!isTyping && suggestions.length > 0 && (
              <div className="flex justify-start animate-fade-in">
                <QuickReplies
                  suggestions={suggestions}
                  onSelect={(text) => sendMessage(text)}
                />
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* 输入区域 */}
          <div className="border-t border-[hsl(var(--border))] bg-white px-4 py-3">
            <div className="flex items-center gap-2 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted))] px-3 py-1.5 focus-within:ring-2 focus-within:ring-[hsl(var(--primary))]/20 focus-within:border-[hsl(var(--primary))] transition-all">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="输入您的问题..."
                className="flex-1 bg-transparent py-1.5 text-sm outline-none placeholder:text-gray-400"
              />
              {isTyping ? (
                <button
                  onClick={() => abortRef.current?.abort()}
                  className="flex-shrink-0 rounded-lg p-1.5 text-red-600 transition-colors hover:bg-red-100"
                  aria-label="停止回复"
                >
                  <Square className="h-4 w-4" />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!input.trim()}
                  className="flex-shrink-0 rounded-lg p-1.5 text-[hsl(var(--primary))] transition-colors hover:bg-[hsl(var(--primary))]/10 disabled:opacity-30 disabled:cursor-not-allowed"
                  aria-label="发送消息"
                >
                  <Send className="h-4 w-4" />
                </button>
              )}
            </div>
            <p className="mt-1.5 text-center text-[10px] text-gray-400">
              客服工作时间：工作日 9:00 - 18:00
            </p>
          </div>
        </div>
      )}
    </>
  );
}
