import { memo } from "react";
import type { Message } from "@agentforge/shared-types";
import { MarkdownRenderer } from "../markdown/MarkdownRenderer";
import { Bot, User, Wrench, Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chat";

interface Props {
  message: Message;
}

function MessageBubbleInner({ message }: Props) {
  const isUser = message.role === "user";
  const isStreaming = message.id === "__streaming__";
  const toolCalls = useChatStore((s) => s.toolCalls);

  return (
    <div
      className={cn(
        "animate-fade-in flex gap-3",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      {!isUser && (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--accent))]">
          <Bot className="h-4 w-4" />
        </div>
      )}

      <div className={cn("max-w-[80%] space-y-2")}>
        {/* Main text bubble */}
        <div
          className={cn(
            "rounded-2xl px-4 py-3 text-sm",
            isUser
              ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
              : "bg-[hsl(var(--muted))]",
          )}
        >
          <MarkdownRenderer content={message.content} />
          {isStreaming && (
            <span className="ml-0.5 inline-block h-4 w-1 animate-pulse bg-current align-middle" />
          )}
        </div>

        {/* Tool call badges — shown inline for the streaming assistant message */}
        {!isUser && toolCalls.length > 0 && (
          <div className="space-y-1.5">
            {toolCalls.map((tc) => (
              <ToolCallBadge key={tc.id} toolCall={tc} />
            ))}
          </div>
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

function ToolCallBadge({
  toolCall,
}: {
  toolCall: {
    id: string;
    name: string;
    arguments: string;
    result?: string;
    status: string;
  };
}) {
  const isPending = toolCall.status === "pending";
  const args = (() => {
    try {
      const obj = JSON.parse(toolCall.arguments);
      // Show first key-value pair as preview
      const entries = Object.entries(obj);
      if (entries.length === 0) return "";
      const [key, value] = entries[0];
      const valStr = typeof value === "string" ? value : JSON.stringify(value);
      return `${key}=${valStr.length > 40 ? valStr.slice(0, 40) + "..." : valStr}`;
    } catch {
      return toolCall.arguments.slice(0, 50);
    }
  })();

  return (
    <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        {isPending ? (
          <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
        ) : (
          <Check className="h-3 w-3 text-green-500" />
        )}
        <Wrench className="h-3 w-3 text-muted-foreground" />
        <span className="font-medium">{formatToolName(toolCall.name)}</span>
        {args && <span className="text-muted-foreground">({args})</span>}
      </div>
      {!isPending && toolCall.result && (
        <div className="mt-1.5 border-t border-[hsl(var(--border))] pt-1.5 text-muted-foreground">
          <span className="font-mono text-[11px] whitespace-pre-wrap break-all">
            {toolCall.result.length > 200
              ? toolCall.result.slice(0, 200) + "..."
              : toolCall.result}
          </span>
        </div>
      )}
    </div>
  );
}

function formatToolName(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export const MessageBubble = memo(MessageBubbleInner, (prev, next) => {
  // Re-render if message identity changed
  if (prev.message.id !== next.message.id) return false;
  // Re-render if content changed (streaming token append)
  if (prev.message.content !== next.message.content) return false;
  // Never skip the streaming placeholder
  if (prev.message.id === "__streaming__" || next.message.id === "__streaming__") return false;
  // Skip re-render for all other cases
  return true;
});
