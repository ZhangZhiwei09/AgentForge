import { ConversationList } from "../sidebar/ConversationList";
import { ChatArea } from "../chat/ChatArea";
import { DebugPanel } from "../debug/DebugPanel";
import { MemoryPanel } from "../memory/MemoryPanel";
import { KnowledgePanel } from "../knowledge/KnowledgePanel";
import { AgentPanel } from "../agent/AgentPanel";
import { VoicePanel } from "../voice/VoicePanel";
import { useChatStore } from "@/stores/chat";
import { Braces, Brain, BookOpen, Bot, Mic } from "lucide-react";

export function ChatLayout() {
  const isDebugOpen = useChatStore((s) => s.isDebugOpen);
  const panelMode = useChatStore((s) => s.panelMode);
  const setPanelMode = useChatStore((s) => s.setPanelMode);
  const currentConversationId = useChatStore((s) => s.currentConversationId);

  return (
    <div className="flex flex-1 overflow-hidden">
      <ConversationList />
      <ChatArea />
      {isDebugOpen && (
        <div className="flex flex-col">
          {/* Panel Mode Tabs */}
          <div className="flex border-b border-[hsl(var(--border))] bg-[hsl(var(--muted))]/30">
            <button
              onClick={() => setPanelMode("debug")}
              className={`flex items-center gap-1 px-3 py-2 text-xs font-medium transition-colors ${
                panelMode === "debug"
                  ? "border-b-2 border-foreground text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Braces className="h-3.5 w-3.5" />
              Debug
            </button>
            <button
              onClick={() => setPanelMode("memory")}
              className={`flex items-center gap-1 px-3 py-2 text-xs font-medium transition-colors ${
                panelMode === "memory"
                  ? "border-b-2 border-foreground text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Brain className="h-3.5 w-3.5" />
              Memory
            </button>
            <button
              onClick={() => setPanelMode("knowledge")}
              className={`flex items-center gap-1 px-3 py-2 text-xs font-medium transition-colors ${
                panelMode === "knowledge"
                  ? "border-b-2 border-foreground text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <BookOpen className="h-3.5 w-3.5" />
              Knowledge
            </button>
            <button
              onClick={() => setPanelMode("agent")}
              className={`flex items-center gap-1 px-3 py-2 text-xs font-medium transition-colors ${
                panelMode === "agent"
                  ? "border-b-2 border-foreground text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Bot className="h-3.5 w-3.5" />
              Agent
            </button>
            <button
              onClick={() => setPanelMode("voice")}
              className={`flex items-center gap-1 px-3 py-2 text-xs font-medium transition-colors ${
                panelMode === "voice"
                  ? "border-b-2 border-foreground text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Mic className="h-3.5 w-3.5" />
              Voice
            </button>
          </div>
          {panelMode === "debug" ? (
            <DebugPanel />
          ) : panelMode === "memory" ? (
            <MemoryPanel />
          ) : panelMode === "knowledge" ? (
            <KnowledgePanel />
          ) : panelMode === "voice" ? (
            <VoicePanel />
          ) : (
            <AgentPanel conversationId={currentConversationId} />
          )}
        </div>
      )}
    </div>
  );
}
