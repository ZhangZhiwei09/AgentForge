import { useState, useRef, useEffect, type KeyboardEvent } from "react";
import { Send, Square, MessageCircle } from "lucide-react";
import { useAgentChatStream } from "@/hooks/useAgentChatStream";
import type { AgentMessage } from "@/hooks/useAgentChatStream";
import {
  RichMessageRenderer,
  DiagnosisCard,
  ClarificationCard,
  WaitingInputCard,
  TraceTimeline,
  CitationCardList,
  filterCitedCards,
} from "@agentforge/cui";
import type { CitationCard } from "@agentforge/shared-types";

/** 取该消息实际被引用的卡片：正文未标注 [n] 时回退为全部召回 */
function citedCardsOf(msg: AgentMessage): CitationCard[] {
  if (msg.role !== "assistant" || !msg.citations?.length) return [];
  return filterCitedCards(msg.citations, msg.content);
}

function formatMessageTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
import { SessionList } from "./SessionList";
import { WelcomeScreen } from "./WelcomeScreen";
import { QuickReplies } from "@/components/customer-chat/QuickReplies";
import { SatisfactionRating } from "@/components/customer-chat/SatisfactionRating";

export function AgentChatPage() {
  const {
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
    switchConversation,
    switchSession,
    abort,
  } = useAgentChatStream();
  const [input, setInput] = useState("");
  const [listRefreshKey, setListRefreshKey] = useState(0);
  const prevStreamingRef = useRef(isStreaming);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const topTriggerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const prevScrollHeightRef = useRef<number>(0);

  // 新消息时滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isStreaming]);

  // 首次加载 + 切换会话时加载历史
  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // 流式完成时刷新左侧会话列表
  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming && conversationId) {
      setListRefreshKey((k) => k + 1);
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming, conversationId]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // IntersectionObserver：顶部触发加载更多
  useEffect(() => {
    const trigger = topTriggerRef.current;
    if (!trigger || !hasMore) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && hasMore && !isLoadingMore) {
          // 记录当前滚动高度，用于加载完成后保持位置
          const container = scrollContainerRef.current;
          if (container) {
            prevScrollHeightRef.current = container.scrollHeight;
          }
          loadMoreHistory();
        }
      },
      { threshold: 0.1 },
    );

    observer.observe(trigger);
    return () => observer.disconnect();
  }, [hasMore, isLoadingMore, loadMoreHistory]);

  // 加载更早消息后恢复滚动位置
  useEffect(() => {
    if (!isLoadingMore && prevScrollHeightRef.current > 0) {
      const container = scrollContainerRef.current;
      if (container) {
        const newScrollHeight = container.scrollHeight;
        const diff = newScrollHeight - prevScrollHeightRef.current;
        container.scrollTop = diff;
        prevScrollHeightRef.current = 0;
      }
    }
  }, [isLoadingMore]);

  const hasRealMessages = messages.length > 1 || messages[0]?.id !== "welcome";
  const lastAssistantMsg = [...messages]
    .reverse()
    .find((m) => m.role === "assistant");

  function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;
    sendMessage(trimmed);
    setInput("");
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleFAQSelect(question: string) {
    sendMessage(question);
  }

  return (
    <div
      className="flex flex-1 overflow-hidden"
      style={{ height: "calc(100dvh - 48px)" }}
    >
      {/* 左侧会话列表（ChatGPT 风格） */}
      <SessionList
        activeConversationId={conversationId}
        onSelectConversation={switchConversation}
        onNewChat={newChat}
        refreshTrigger={listRefreshKey}
      />

      {/* 中间聊天区域 */}
      <main className="flex flex-1 flex-col bg-[hsl(var(--cs-bg))]">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-[hsl(var(--cs-border))] bg-white px-4 sm:px-7">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[hsl(var(--muted-foreground))]">
              AgentForge / Support
            </p>
            <h1 className="truncate text-sm font-semibold text-[hsl(var(--foreground))]">
              核身排障助手
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-[11px] text-[hsl(var(--muted-foreground))]">
            <span className="h-2 w-2 rounded-full bg-[hsl(var(--cs-success))]" />
            智能体在线
          </div>
        </header>
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
          {!hasRealMessages ? (
            <WelcomeScreen onSend={handleFAQSelect} />
          ) : (
            <div className="mx-auto max-w-3xl space-y-4 px-3 py-4 sm:px-6 sm:py-6">
              {/* 顶部加载触发器 */}
              <div ref={topTriggerRef} className="py-2 text-center">
                {isLoadingMore ? (
                  <span className="text-xs text-[hsl(var(--muted-foreground))]">
                    加载更早的消息...
                  </span>
                ) : hasMore ? (
                  <span className="text-xs text-[hsl(var(--muted-foreground))]">
                    向上滚动加载更多
                  </span>
                ) : messages.length > 2 ? (
                  <span className="text-xs text-[hsl(var(--muted-foreground))]">
                    已加载全部消息
                  </span>
                ) : null}
              </div>

              {messages
                .filter((m) => m.id !== "welcome")
                .map((msg) => (
                  <div key={msg.id}>
                    <div
                      className={`flex ${
                        msg.role === "user" ? "justify-end" : "justify-start"
                      } animate-fade-in`}
                    >
                      {msg.role === "assistant" && (
                        <div className="mr-3 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--cs-primary))] shadow-sm">
                          <MessageCircle className="h-4 w-4 text-white" />
                        </div>
                      )}

                      <div
                        className={`max-w-[86%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm ${
                          msg.role === "user"
                            ? "bg-[hsl(var(--cs-primary))] text-white rounded-br-md"
                            : "bg-white border border-[hsl(var(--cs-border))] text-[hsl(var(--foreground))] rounded-bl-md"
                        }`}
                      >
                        <div
                          className={`mb-1.5 flex items-center gap-2 text-[10px] ${
                            msg.role === "user"
                              ? "text-blue-100"
                              : "text-[hsl(var(--muted-foreground))]"
                          }`}
                        >
                          <span className="font-semibold">
                            {msg.role === "user" ? "你" : "诊断助手"}
                          </span>
                          <span>{formatMessageTime(msg.timestamp)}</span>
                        </div>
                        {/* 诊断信息采集卡片（信息不足时提示用户补充） */}
                        {msg.role === "assistant" && msg.clarification && (
                          <ClarificationCard clarification={msg.clarification} />
                        )}
                        {/* 诊断进度卡片 */}
                        {msg.role === "assistant" && msg.diagnosis && (
                          <DiagnosisCard diagnosis={msg.diagnosis} />
                        )}
                        {/* HITL 等待补充卡片（诊断进行中暂停，用户补充后同 thread 续跑） */}
                        {msg.role === "assistant" && msg.waitingInput && (
                          <WaitingInputCard
                            waitingInput={msg.waitingInput}
                            onSubmit={sendMessage}
                          />
                        )}
                        {/* Agent 过程时间轴：本轮去查了什么 */}
                        {msg.role === "assistant" && msg.traces && (
                          <TraceTimeline steps={msg.traces} />
                        )}
                        {msg.id === "__stream__" && isStreaming ? (
                          <div>
                            <RichMessageRenderer
                              content={msg.content}
                              isStreaming
                              citeIndexes={citedCardsOf(msg).map((c) => c.index)}
                              citeScope={msg.id}
                            />
                            <span className="inline-block w-1.5 h-4 ml-0.5 bg-current animate-pulse rounded-sm align-middle" />
                          </div>
                        ) : (
                          <RichMessageRenderer
                            content={msg.content}
                            citeIndexes={citedCardsOf(msg).map((c) => c.index)}
                            citeScope={msg.id}
                          />
                        )}
                        {msg.role === "assistant" && (
                          <CitationCardList
                            cards={citedCardsOf(msg)}
                            scope={msg.id}
                          />
                        )}
                      </div>

                      {msg.role === "user" && (
                        <div className="ml-3 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--muted))] shadow-sm">
                          <span className="text-xs font-medium text-[hsl(var(--muted-foreground))]">
                            我
                          </span>
                        </div>
                      )}
                    </div>

                    {/* 满意度评分 */}
                    {msg.role === "assistant" &&
                      msg.id !== "__stream__" &&
                      msg.id !== "welcome" &&
                      !isStreaming &&
                      msg === lastAssistantMsg && (
                        <div className="ml-11 mt-2">
                          <SatisfactionRating
                            sessionId={sessionId}
                            messageId={msg.id}
                          />
                        </div>
                      )}
                  </div>
                ))}

              {isStreaming &&
                messages[messages.length - 1]?.id !== "__stream__" && (
                  <div className="flex justify-start animate-fade-in">
                    <div className="mr-3 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--cs-primary))] shadow-sm">
                      <MessageCircle className="h-4 w-4 text-white" />
                    </div>
                    <div className="rounded-2xl rounded-bl-md border border-[hsl(var(--cs-border))] bg-white px-4 py-3 shadow-sm">
                      <div className="flex gap-1">
                        <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400 [animation-delay:0ms]" />
                        <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400 [animation-delay:150ms]" />
                        <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400 [animation-delay:300ms]" />
                      </div>
                    </div>
                  </div>
                )}

              {!isStreaming &&
                currentMeta?.suggestions &&
                currentMeta.suggestions.length > 0 &&
                lastAssistantMsg === messages[messages.length - 1] && (
                  <div className="ml-11">
                    <QuickReplies
                      suggestions={currentMeta.suggestions}
                      onSelect={handleFAQSelect}
                    />
                  </div>
                )}

              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* 输入区域 */}
        <div className="border-t border-[hsl(var(--cs-border))] bg-white px-3 sm:px-6 py-3 sm:py-4">
          <div className="mx-auto max-w-3xl">
            <div className="flex items-center gap-2 sm:gap-3 rounded-2xl border border-[hsl(var(--cs-border))] bg-white px-3 sm:px-4 py-2 sm:py-2.5 focus-within:ring-2 focus-within:ring-[hsl(var(--cs-primary))]/20 focus-within:border-[hsl(var(--cs-primary))] transition-all shadow-[0_10px_28px_rgba(32,55,90,0.08)]">
              <textarea
                ref={inputRef}
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="输入您的问题，Enter 发送..."
                className="max-h-28 min-h-7 flex-1 resize-none bg-transparent py-1.5 text-sm leading-6 outline-none placeholder:text-gray-400"
              />
              {isStreaming ? (
                <button
                  onClick={abort}
                  className="flex-shrink-0 rounded-lg bg-red-600 p-2 text-white transition-all hover:bg-red-700 hover:shadow-md"
                  aria-label="停止回复"
                >
                  <Square className="h-4 w-4" />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!input.trim()}
                  className="flex-shrink-0 rounded-lg bg-[hsl(var(--cs-primary))] p-2 text-white transition-all hover:bg-[hsl(var(--cs-primary-dark))] disabled:opacity-30 disabled:cursor-not-allowed hover:shadow-md"
                  aria-label="发送消息"
                >
                  <Send className="h-4 w-4" />
                </button>
              )}
            </div>
            <p className="mt-2 text-center text-[10px] text-[hsl(var(--muted-foreground))]">
              AI 助手可能产生不准确回复，重要问题请联系人工客服
            </p>
          </div>
        </div>
      </main>

    </div>
  );
}
