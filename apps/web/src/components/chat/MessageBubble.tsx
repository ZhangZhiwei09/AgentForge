import type { Message } from "@agentforge/shared-types";
import { MarkdownRenderer } from "../markdown/MarkdownRenderer";
import { Bot, User } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
    message: Message;
}

export function MessageBubble({ message }: Props) {
    const isUser = message.role === "user";
    const isStreaming = message.id === "__streaming__";

    return (
        <div
            className={cn(
                "animate-fade-in flex gap-3",
                isUser ? "justify-end" : "justify-start"
            )}
        >
            {!isUser && (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--accent))]">
                    <Bot className="h-4 w-4" />
                </div>
            )}

            <div
                className={cn(
                    "max-w-[80%] rounded-2xl px-4 py-3 text-sm",
                    isUser
                        ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                        : "bg-[hsl(var(--muted))]"
                )}
            >
                <MarkdownRenderer content={message.content} />
                {isStreaming && (
                    <span className="ml-0.5 inline-block h-4 w-1 animate-pulse bg-current align-middle" />
                )}
            </div>

            {isUser && (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]">
                    <User className="h-4 w-4" />
                </div>
            )}
        </div>
    );
}
