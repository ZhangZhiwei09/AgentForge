import { create } from "zustand";
import type { Conversation, DebugInfo, Message, ProviderType } from "@/types";

interface ChatState {
    conversations: Conversation[];
    currentConversationId: string | null;
    messages: Message[];
    isStreaming: boolean;
    debugInfo: DebugInfo | null;
    selectedModel: string;
    selectedProvider: ProviderType;
    isDebugOpen: boolean;

    setConversations: (convs: Conversation[]) => void;
    setCurrentConversation: (id: string | null) => void;
    setMessages: (msgs: Message[]) => void;
    appendMessage: (msg: Message) => void;
    appendStreamToken: (token: string) => void;
    setIsStreaming: (v: boolean) => void;
    setDebugInfo: (info: DebugInfo | null) => void;
    setSelectedModel: (model: string) => void;
    setSelectedProvider: (provider: ProviderType) => void;
    toggleDebugPanel: () => void;
    resetChat: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
    conversations: [],
    currentConversationId: null,
    messages: [],
    isStreaming: false,
    debugInfo: null,
    selectedModel: "gpt-4o-mini",
    selectedProvider: "openai",
    isDebugOpen: true,

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
    setSelectedModel: (model) => set({ selectedModel: model }),
    setSelectedProvider: (provider) => set({ selectedProvider: provider }),
    toggleDebugPanel: () => set((s) => ({ isDebugOpen: !s.isDebugOpen })),
    resetChat: () => set({ messages: [], debugInfo: null }),
}));
