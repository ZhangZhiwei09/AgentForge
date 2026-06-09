import type { ChatRequest, ChatStreamChunk, Conversation, CreateConversationDTO, LLMProviderInfo, Message, Memory, MemorySearchResult } from "@agentforge/shared-types";

export interface AgentForgeConfig {
    baseUrl: string;
}

export class AgentForgeClient {
    private baseUrl: string;

    constructor(config: AgentForgeConfig) {
        this.baseUrl = config.baseUrl.replace(/\/$/, "");
    }

    async request<T>(path: string, options?: RequestInit): Promise<T> {
        const res = await fetch(`${this.baseUrl}${path}`, {
            headers: { "Content-Type": "application/json" },
            ...options,
        });
        if (!res.ok) {
            const error = await res.json().catch(() => ({ detail: res.statusText }));
            throw new Error(error.detail ?? `HTTP ${res.status}`);
        }
        return res.json();
    }

    async *streamChat(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
        const res = await fetch(`${this.baseUrl}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request),
        });

        if (!res.ok) {
            const error = await res.json().catch(() => ({ detail: res.statusText }));
            throw new Error(error.detail ?? `HTTP ${res.status}`);
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let buffer = "";

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
                if (data === "[DONE]") return;
                try {
                    yield JSON.parse(data) as ChatStreamChunk;
                } catch {
                    continue;
                }
            }
        }
    }

    async createConversation(dto?: CreateConversationDTO): Promise<Conversation> {
        return this.request<Conversation>("/api/conversations", {
            method: "POST",
            body: JSON.stringify(dto ?? {}),
        });
    }

    async listConversations(): Promise<Conversation[]> {
        return this.request<Conversation[]>("/api/conversations");
    }

    async getConversation(id: string): Promise<Conversation> {
        return this.request<Conversation>(`/api/conversations/${id}`);
    }

    async deleteConversation(id: string): Promise<void> {
        await this.request<void>(`/api/conversations/${id}`, {
            method: "DELETE",
        });
    }

    async getMessages(conversationId: string): Promise<Message[]> {
        return this.request<Message[]>(`/api/conversations/${conversationId}/messages`);
    }

    async listProviders(): Promise<LLMProviderInfo[]> {
        return this.request<LLMProviderInfo[]>("/api/providers");
    }

    async listTools(): Promise<{ tools: Array<{ name: string; description: string; parameters: unknown }>; count: number }> {
        return this.request("/api/tools");
    }

    async listMemories(type?: string): Promise<Memory[]> {
        const path = type ? `/api/memories?type=${encodeURIComponent(type)}` : "/api/memories";
        return this.request<Memory[]>(path);
    }

    async searchMemories(query: string, topK: number = 5): Promise<MemorySearchResult[]> {
        return this.request<MemorySearchResult[]>(
            `/api/memories/search?q=${encodeURIComponent(query)}&top_k=${topK}`
        );
    }

    async deleteMemory(id: string): Promise<void> {
        await this.request<void>(`/api/memories/${id}`, {
            method: "DELETE",
        });
    }
}
