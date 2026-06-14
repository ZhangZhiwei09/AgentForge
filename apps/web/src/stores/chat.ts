import { create } from "zustand";
import type {
  Conversation,
  DebugInfo,
  Message,
  MemoryInfo,
  ProviderType,
  ToolCallRecord,
} from "@/types";

type PanelMode = "debug" | "memory" | "knowledge" | "agent" | "voice";

export type VoiceStatus = "idle" | "listening" | "processing" | "speaking";
export type VideoStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "listening"
  | "processing"
  | "speaking";

export interface PendingApproval {
  approvalId: string;
  sessionId: string;
  step: number;
  toolName: string;
  toolArgs: Record<string, unknown>;
  riskLevel: string;
  reason: string;
  timeoutMs: number;
}

interface ChatState {
  conversations: Conversation[];
  currentConversationId: string | null;
  messages: Message[];
  isStreaming: boolean;
  debugInfo: DebugInfo | null;
  memoryInfo: MemoryInfo | null;
  selectedModel: string;
  selectedProvider: ProviderType;
  isDebugOpen: boolean;
  panelMode: PanelMode;
  toolCalls: ToolCallRecord[];
  enabledTools: string[];
  // P1-5 Approval state
  pendingApproval: PendingApproval | null;
  // V5 Voice state
  isVoiceActive: boolean;
  voiceStatus: VoiceStatus;
  voiceTranscript: Array<{ role: string; content: string }>;
  // V11 Video state
  isVideoActive: boolean;
  videoStatus: VideoStatus;
  videoTranscript: Array<{ role: string; content: string }>;
  videoVisionContext: string;

  setConversations: (convs: Conversation[]) => void;
  setCurrentConversation: (id: string | null) => void;
  setMessages: (msgs: Message[]) => void;
  appendMessage: (msg: Message) => void;
  appendStreamToken: (token: string) => void;
  setIsStreaming: (v: boolean) => void;
  setDebugInfo: (info: DebugInfo | null) => void;
  setMemoryInfo: (info: MemoryInfo | null) => void;
  setSelectedModel: (model: string) => void;
  setSelectedProvider: (provider: ProviderType) => void;
  toggleDebugPanel: () => void;
  setPanelMode: (mode: PanelMode) => void;
  resetChat: () => void;
  addToolCall: (tc: { id: string; name: string; arguments: string }) => void;
  setToolResult: (id: string, result: string) => void;
  toggleTool: (name: string) => void;
  setEnabledTools: (tools: string[]) => void;
  // P1-5 Approval actions
  setPendingApproval: (approval: PendingApproval | null) => void;
  clearPendingApproval: () => void;
  // V5 Voice actions
  setVoiceActive: (v: boolean) => void;
  setVoiceStatus: (status: VoiceStatus) => void;
  appendVoiceTranscript: (entry: { role: string; content: string }) => void;
  clearVoiceTranscript: () => void;
  // V11 Video actions
  setVideoActive: (v: boolean) => void;
  setVideoStatus: (status: VideoStatus) => void;
  appendVideoTranscript: (entry: { role: string; content: string }) => void;
  clearVideoTranscript: () => void;
  setVideoVisionContext: (ctx: string) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  currentConversationId: null,
  messages: [],
  isStreaming: false,
  debugInfo: null,
  memoryInfo: null,
  selectedModel: "deepseek-chat",
  selectedProvider: "deepseek",
  isDebugOpen: true,
  panelMode: "debug",
  toolCalls: [],
  enabledTools: [],
  pendingApproval: null,
  isVoiceActive: false,
  voiceStatus: "idle" as VoiceStatus,
  voiceTranscript: [],
  isVideoActive: false,
  videoStatus: "idle" as VideoStatus,
  videoTranscript: [],
  videoVisionContext: "",

  setConversations: (convs) => set({ conversations: convs }),
  setCurrentConversation: (id) => set({ currentConversationId: id }),
  setMessages: (msgs) => set({ messages: msgs }),
  appendMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  appendStreamToken: (token) => {
    const msgs = get().messages;
    if (msgs.length > 0) {
      const last = msgs[msgs.length - 1];
      if (last.role === "assistant" && last.id === "__streaming__") {
        set({
          messages: [
            ...msgs.slice(0, -1),
            { ...last, content: last.content + token },
          ],
        });
      }
    }
  },
  setIsStreaming: (v) => set({ isStreaming: v }),
  setDebugInfo: (info) => set({ debugInfo: info }),
  setMemoryInfo: (info) => set({ memoryInfo: info }),
  setSelectedModel: (model) => set({ selectedModel: model }),
  setSelectedProvider: (provider) => set({ selectedProvider: provider }),
  toggleDebugPanel: () => set((s) => ({ isDebugOpen: !s.isDebugOpen })),
  setPanelMode: (mode) => set({ panelMode: mode }),
  resetChat: () =>
    set({ messages: [], debugInfo: null, memoryInfo: null, toolCalls: [] }),
  toggleTool: (name) =>
    set((s) => ({
      enabledTools: s.enabledTools.includes(name)
        ? s.enabledTools.filter((t) => t !== name)
        : [...s.enabledTools, name],
    })),
  setEnabledTools: (tools) => set({ enabledTools: tools }),
  addToolCall: (tc) =>
    set((s) => ({
      toolCalls: [...s.toolCalls, { ...tc, status: "pending" as const }],
    })),
  setToolResult: (id, result) =>
    set((s) => ({
      toolCalls: s.toolCalls.map((tc) =>
        tc.id === id ? { ...tc, result, status: "done" as const } : tc,
      ),
    })),
  setPendingApproval: (approval) => set({ pendingApproval: approval }),
  clearPendingApproval: () => set({ pendingApproval: null }),
  setVoiceActive: (v) => set({ isVoiceActive: v }),
  setVoiceStatus: (status) => set({ voiceStatus: status }),
  appendVoiceTranscript: (entry) =>
    set((s) => ({ voiceTranscript: [...s.voiceTranscript, entry] })),
  clearVoiceTranscript: () => set({ voiceTranscript: [] }),
  setVideoActive: (v) => set({ isVideoActive: v }),
  setVideoStatus: (status) => set({ videoStatus: status }),
  appendVideoTranscript: (entry) =>
    set((s) => ({ videoTranscript: [...s.videoTranscript, entry] })),
  clearVideoTranscript: () => set({ videoTranscript: [] }),
  setVideoVisionContext: (ctx) => set({ videoVisionContext: ctx }),
}));
