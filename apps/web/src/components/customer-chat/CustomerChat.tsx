import { useState, useRef, useEffect, type KeyboardEvent } from "react";
import { MessageCircle, X, Send } from "lucide-react";

interface ChatMessage {
    id: string;
    role: "user" | "assistant";
    content: string;
    timestamp: number;
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
    const abortRef = useRef<AbortController | null>(null);

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

    async function handleSend() {
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

        try {
            abortRef.current?.abort();
            abortRef.current = new AbortController();

            const res = await fetch("/api/customer-chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ message: trimmed }),
                signal: abortRef.current.signal,
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({ detail: res.statusText }));
                throw new Error(err.detail ?? `HTTP ${res.status}`);
            }

            const reader = res.body?.getReader();
            if (!reader) throw new Error("No response body");

            const decoder = new TextDecoder();
            let buffer = "";
            let streamContent = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith("data: ")) continue;

                    const data = trimmed.slice(6);
                    if (data === "[DONE]") continue;

                    try {
                        const chunk = JSON.parse(data);
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
                                    },
                                ];
                            });
                        } else if (chunk.type === "error") {
                            console.error("Stream error:", chunk.content);
                        }
                    } catch {
                        continue;
                    }
                }
            }
        } catch (err: unknown) {
            if (err instanceof DOMException && err.name === "AbortError") return;
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
