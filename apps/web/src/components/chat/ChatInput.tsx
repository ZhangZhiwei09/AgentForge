import { useState } from "react";
import { Send, Square } from "lucide-react";
import { useStreamChat } from "@/hooks/useStreamChat";
import { useChatStore } from "@/stores/chat";

export function ChatInput() {
  const [input, setInput] = useState("");
  const { sendMessage, isLoading, abort } = useStreamChat();
  const isStreaming = useChatStore((s) => s.isStreaming);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isStreaming) return;
    const content = input.trim();
    setInput("");
    await sendMessage(content);
  };

  const handleStop = (e: React.MouseEvent) => {
    e.preventDefault();
    abort();
  };

  return (
    <form onSubmit={handleSubmit} className="flex items-end gap-2">
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSubmit(e);
          }
        }}
        placeholder="Type your message... (Enter to send, Shift+Enter for new line)"
        rows={1}
        className="flex-1 resize-none rounded-lg border border-[hsl(var(--border))] bg-transparent px-4 py-2.5 text-sm outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-foreground/30"
      />
      {isStreaming ? (
        <button
          type="button"
          onClick={handleStop}
          className="rounded-lg border border-red-300 bg-red-50 p-2.5 text-red-600 transition-colors hover:bg-red-100 hover:text-red-700"
          aria-label="停止回复"
        >
          <Square className="h-4 w-4" />
        </button>
      ) : (
        <button
          type="submit"
          disabled={!input.trim()}
          className="rounded-lg border border-[hsl(var(--border))] p-2.5 text-muted-foreground transition-colors hover:bg-[hsl(var(--accent))] hover:text-foreground disabled:opacity-40"
        >
          <Send className="h-4 w-4" />
        </button>
      )}
    </form>
  );
}
