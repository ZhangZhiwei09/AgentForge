import { useState, useRef, useEffect, type KeyboardEvent } from "react";
import {
  Send,
  Square,
  MessageCircle,
  BookOpen,
  ChevronDown,
  ChevronUp,
  PanelRightClose,
  PanelRightOpen,
  Video,
} from "lucide-react";
import { useCustomerChatStream } from "@/hooks/useCustomerChatStream";
import type { CSMessage } from "@/hooks/useCustomerChatStream";
import { RichMessageRenderer } from "@/components/markdown/RichMessageRenderer";
import { FAQSidebar } from "./FAQSidebar";
import { WelcomeScreen } from "./WelcomeScreen";
import { QuickReplies } from "./QuickReplies";
import { SatisfactionRating } from "./SatisfactionRating";
import { ChatSessionInfo } from "./ChatSessionInfo";
import { CustomerServiceDashboard } from "./CustomerServiceDashboard";
import { CustomerVideoCall } from "./CustomerVideoCall";

export function CustomerChatPage() {
  const {
    messages,
    isStreaming,
    sessionId,
    currentMeta,
    sendMessage,
    loadHistory,
    clearSession,
    abort,
  } = useCustomerChatStream();
  const [input, setInput] = useState("");
  const [showRightPanel, setShowRightPanel] = useState(true);
  const [showDashboard, setShowDashboard] = useState(false);
  const [showVideoCall, setShowVideoCall] = useState(false);
  const [expandedKnowledge, setExpandedKnowledge] = useState<Set<string>>(
    new Set(),
  );
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 自动滚动
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isStreaming]);

  // 加载历史消息
  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // 聚焦输入框
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleFAQSelect(question: string) {
    sendMessage(question);
  }

  function toggleKnowledge(msgId: string) {
    setExpandedKnowledge((prev) => {
      const next = new Set(prev);
      if (next.has(msgId)) next.delete(msgId);
      else next.add(msgId);
      return next;
    });
  }

  function scoreColor(score: number): string {
    if (score >= 0.8) return "text-green-600 bg-green-50";
    if (score >= 0.5) return "text-amber-600 bg-amber-50";
    return "text-red-500 bg-red-50";
  }

  return (
    <div
      className="flex flex-1 overflow-hidden"
      style={{ height: "calc(100dvh - 48px)" }}
    >
      {/* 左侧 FAQ 边栏 — 移动端隐藏 */}
      <div className="hidden md:block">
        <FAQSidebar onSelectQuestion={handleFAQSelect} />
      </div>

      {/* 中间聊天区域 */}
      <main className="flex flex-1 flex-col bg-[hsl(var(--cs-bg))]">
        {/* 聊天消息 */}
        <div className="flex-1 overflow-y-auto">
          {!hasRealMessages ? (
            <WelcomeScreen onSend={handleFAQSelect} />
          ) : (
            <div className="mx-auto max-w-2xl space-y-4 px-3 sm:px-6 py-4 sm:py-6">
              {messages
                .filter((m) => m.id !== "welcome")
                .map((msg) => (
                  <div key={msg.id}>
                    {/* 消息气泡 */}
                    <div
                      className={`flex ${
                        msg.role === "user" ? "justify-end" : "justify-start"
                      } animate-fade-in`}
                    >
                      {/* AI 头像 */}
                      {msg.role === "assistant" && (
                        <div className="mr-3 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--cs-primary))] shadow-sm">
                          <MessageCircle className="h-4 w-4 text-white" />
                        </div>
                      )}

                      <div
                        className={`max-w-[78%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm ${
                          msg.role === "user"
                            ? "bg-[hsl(var(--cs-primary))] text-white rounded-br-md"
                            : "bg-white border border-[hsl(var(--cs-border))] text-[hsl(var(--foreground))] rounded-bl-md"
                        }`}
                      >
                        {msg.id === "__stream__" && isStreaming ? (
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

                      {/* 用户头像 */}
                      {msg.role === "user" && (
                        <div className="ml-3 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--muted))] shadow-sm">
                          <span className="text-xs font-medium text-[hsl(var(--muted-foreground))]">
                            我
                          </span>
                        </div>
                      )}
                    </div>

                    {/* 工具调用展示 */}
                    {msg.role === "assistant" &&
                      msg.toolCalls &&
                      msg.toolCalls.length > 0 && (
                        <div className="ml-11 mt-1.5 space-y-1">
                          {msg.toolCalls.map((tc) => (
                            <div
                              key={tc.id}
                              className="flex items-center gap-1.5 text-[11px] text-[hsl(var(--muted-foreground))]"
                            >
                              {tc.status === "pending" ? (
                                <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
                              ) : (
                                <span className="text-green-500">✓</span>
                              )}
                              <span className="font-medium">
                                {tc.name === "get_current_time"
                                  ? "获取当前时间"
                                  : tc.name}
                              </span>
                              {tc.result && (
                                <span className="text-muted-foreground/70">
                                  →{" "}
                                  {tc.result.length > 50
                                    ? tc.result.slice(0, 50) + "..."
                                    : tc.result}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                    {/* 知识库参考来源 */}
                    {msg.role === "assistant" &&
                      msg.knowledge &&
                      msg.knowledge.length > 0 && (
                        <div className="ml-11 mt-1.5">
                          <button
                            onClick={() => toggleKnowledge(msg.id)}
                            className="flex items-center gap-1 text-[11px] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-colors"
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
                                  className="rounded-lg border border-[hsl(var(--cs-border))] bg-white p-2.5 text-xs shadow-sm"
                                >
                                  <div className="flex items-center justify-between mb-1">
                                    <span className="font-medium text-[hsl(var(--muted-foreground))]">
                                      #{i + 1} {kr.docTitle}
                                    </span>
                                    <span
                                      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-mono font-medium ${scoreColor(kr.score)}`}
                                    >
                                      相似度 {kr.score.toFixed(4)}
                                    </span>
                                  </div>
                                  <p className="text-[hsl(var(--muted-foreground))] leading-relaxed line-clamp-3">
                                    {kr.content}
                                  </p>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                    {/* 满意度评分（仅最后一条 AI 消息且流结束） */}
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

              {/* 流式输出中正在输入提示 */}
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

              {/* 快捷追问 */}
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
          <div className="mx-auto max-w-2xl">
            <div className="flex items-center gap-2 sm:gap-3 rounded-xl border border-[hsl(var(--cs-border))] bg-[hsl(var(--cs-bg))] px-3 sm:px-4 py-2 sm:py-2.5 focus-within:ring-2 focus-within:ring-[hsl(var(--cs-primary))]/20 focus-within:border-[hsl(var(--cs-primary))] transition-all shadow-sm">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="输入您的问题，Enter 发送..."
                className="flex-1 bg-transparent py-1.5 text-sm outline-none placeholder:text-gray-400"
              />
              <button
                onClick={() => setShowVideoCall(true)}
                disabled={isStreaming}
                className="flex-shrink-0 rounded-lg border border-[hsl(var(--cs-border))] bg-white p-2 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--cs-primary))] hover:border-[hsl(var(--cs-primary))] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="开始视频通话"
                title={isStreaming ? "请等待AI回复完成" : "视频客服"}
              >
                <Video className="h-4 w-4" />
              </button>
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
              客服工作时间：工作日 9:00 - 18:00 · AI
              客服可能产生不准确回复，重要问题请联系人工客服
            </p>
          </div>
        </div>
      </main>

      {/* 右侧面板：视频通话 或 会话信息 */}
      {showVideoCall ? (
        <div className="fixed inset-0 z-50 bg-gray-900 md:relative md:inset-auto md:w-[360px] md:border-l md:border-gray-700">
          <CustomerVideoCall
            sessionId={sessionId}
            onClose={() => setShowVideoCall(false)}
          />
        </div>
      ) : showRightPanel ? (
        <div className="w-56 border-l border-[hsl(var(--cs-border))] bg-white">
          <div className="flex items-center justify-between border-b border-[hsl(var(--cs-border))] px-3 py-2">
            <span className="text-xs font-medium text-[hsl(var(--muted-foreground))]">
              会话信息
            </span>
            <button
              onClick={() => setShowRightPanel(false)}
              className="rounded p-0.5 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-colors"
            >
              <PanelRightClose className="h-3.5 w-3.5" />
            </button>
          </div>
          <ChatSessionInfo
            sessionId={sessionId}
            messages={messages}
            onClear={clearSession}
            onDashboard={() => setShowDashboard(true)}
          />
        </div>
      ) : null}

      {/* 展开右侧面板按钮 */}
      {!showRightPanel && !showVideoCall && (
        <button
          onClick={() => setShowRightPanel(true)}
          className="absolute right-4 top-16 rounded-lg border border-[hsl(var(--cs-border))] bg-white p-1.5 shadow-sm text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-colors"
          title="显示会话信息"
        >
          <PanelRightOpen className="h-3.5 w-3.5" />
        </button>
      )}

      {/* 数据概览弹窗 */}
      {showDashboard && (
        <CustomerServiceDashboard onClose={() => setShowDashboard(false)} />
      )}
    </div>
  );
}
