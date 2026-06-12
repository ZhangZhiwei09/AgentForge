import { useEffect, useRef } from "react";
import { useChatStore } from "@/stores/chat";
import { useMessages, useCreateConversation } from "@/hooks/useApi";
import { ChatInput } from "./ChatInput";
import { MessageBubble } from "./MessageBubble";
import { ModelSelector } from "./ModelSelector";
import { MessageSquare, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { ApprovalCard } from "../agent/ApprovalCard";

const AVAILABLE_TOOLS = [
  { name: "calculator", label: "Calculator" },
  { name: "get_current_time", label: "Time" },
  { name: "web_search", label: "Search" },
];

export function ChatArea() {
  const currentId = useChatStore((s) => s.currentConversationId);
  const messages = useChatStore((s) => s.messages);
  const setMessages = useChatStore((s) => s.setMessages);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const enabledTools = useChatStore((s) => s.enabledTools);
  const toggleTool = useChatStore((s) => s.toggleTool);
  const bottomRef = useRef<HTMLDivElement>(null);
  const { data: apiMessages } = useMessages(currentId);
  const createConv = useCreateConversation();

  useEffect(() => {
    if (apiMessages) {
      setMessages(apiMessages);
    }
  }, [apiMessages, setMessages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isStreaming]);

  if (!currentId) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center bg-[hsl(var(--background))]">
        <div className="text-center">
          <MessageSquare className="mx-auto mb-4 h-12 w-12 text-muted-foreground/40" />
          <h2 className="text-lg font-medium text-muted-foreground">
            AgentForge
          </h2>
          <p className="mt-1 text-sm text-muted-foreground/60">
            Select a conversation or create a new one to start
          </p>
          <button
            onClick={async () => {
              const conv = await createConv.mutateAsync(undefined);
            }}
            className="mt-4 rounded-lg border border-[hsl(var(--border))] px-4 py-2 text-sm transition-colors hover:bg-[hsl(var(--accent))]"
          >
            New Conversation
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col bg-[hsl(var(--background))]">
      <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-4 py-2">
        <div className="flex items-center gap-2">
          <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
          <div className="flex items-center gap-1">
            {AVAILABLE_TOOLS.map((tool) => (
              <button
                key={tool.name}
                onClick={() => toggleTool(tool.name)}
                disabled={isStreaming}
                className={cn(
                  "rounded-md border px-2 py-0.5 text-xs transition-colors",
                  enabledTools.includes(tool.name)
                    ? "border-blue-500/50 bg-blue-500/10 text-blue-400"
                    : "border-[hsl(var(--border))] text-muted-foreground hover:border-foreground/20 hover:text-foreground",
                  "disabled:opacity-40",
                )}
              >
                {tool.label}
              </button>
            ))}
          </div>
        </div>
        <ModelSelector />
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-6">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">
              Send a message to start the conversation
            </p>
          </div>
        )}
        <div className="mx-auto max-w-3xl space-y-4">
          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
        </div>
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-[hsl(var(--border))] p-4">
        <div className="mx-auto max-w-3xl">
          <ChatInput />
        </div>
      </div>

      {/* P1-5 Approval Card — renders as overlay when pending approval exists */}
      <ApprovalCard />
    </main>
  );
}
