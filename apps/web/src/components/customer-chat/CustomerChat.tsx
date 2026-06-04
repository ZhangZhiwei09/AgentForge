import { useState, useRef, useEffect, type KeyboardEvent } from "react";
import { MessageCircle, X, Send } from "lucide-react";

interface ChatMessage {
    id: string;
    role: "user" | "assistant";
    content: string;
    timestamp: number;
}

// 模拟客服自动回复
function simulateReply(userMessage: string): string {
    const replies = [
        "感谢您的咨询，我们的客服团队会尽快回复您。",
        "您好！请问有什么可以帮助您的？",
        "感谢您的反馈，我们会认真考虑您的建议。",
        "这个问题我来帮您查一下，请稍等。",
        "很高兴为您服务，请详细描述您遇到的问题。",
    ];
    return replies[Math.floor(Math.random() * replies.length)];
}

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
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

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

    function handleSend() {
        const trimmed = input.trim();
        if (!trimmed) return;

        const userMsg: ChatMessage = {
            id: `msg-${Date.now()}`,
            role: "user",
            content: trimmed,
            timestamp: Date.now(),
        };

        setMessages((prev) => [...prev, userMsg]);
        setInput("");
        setIsTyping(true);

        // 模拟客服回复延迟
        setTimeout(() => {
            const reply: ChatMessage = {
                id: `msg-${Date.now()}`,
                role: "assistant",
                content: simulateReply(trimmed),
                timestamp: Date.now(),
            };
            setMessages((prev) => [...prev, reply]);
            setIsTyping(false);
        }, 800 + Math.random() * 1200);
    }

    function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
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
                <div className="fixed bottom-6 right-6 z-50 flex w-[380px] max-w-[calc(100vw-3rem)] flex-col rounded-2xl border border-[hsl(var(--border))] bg-white shadow-2xl animate-fade-in overflow-hidden"
                    style={{ height: "520px", maxHeight: "calc(100vh - 6rem)" }}
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
                        <button
                            onClick={() => setIsOpen(false)}
                            className="rounded-full p-1.5 transition-colors hover:bg-white/20"
                            aria-label="关闭客服聊天"
                        >
                            <X className="h-5 w-5" />
                        </button>
                    </div>

                    {/* 消息列表 */}
                    <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 bg-[hsl(var(--muted))]/30">
                        {messages.map((msg) => (
                            <div
                                key={msg.id}
                                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"} animate-fade-in`}
                            >
                                <div
                                    className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                                        msg.role === "user"
                                            ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-br-md"
                                            : "bg-white border border-[hsl(var(--border))] text-[hsl(var(--foreground))] rounded-bl-md"
                                    }`}
                                >
                                    {msg.content}
                                </div>
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
                            <button
                                onClick={handleSend}
                                disabled={!input.trim()}
                                className="flex-shrink-0 rounded-lg p-1.5 text-[hsl(var(--primary))] transition-colors hover:bg-[hsl(var(--primary))]/10 disabled:opacity-30 disabled:cursor-not-allowed"
                                aria-label="发送消息"
                            >
                                <Send className="h-4 w-4" />
                            </button>
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
