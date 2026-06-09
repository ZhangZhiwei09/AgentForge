import type { AuthResponse, ChatRequest, ChatStreamChunk, Conversation, CreateConversationDTO, LLMProviderInfo, Message, Memory, MemorySearchResult, ApiKeyDTO, CreateApiKeyResponse, AuthUser } from "@agentforge/shared-types";

export interface AgentForgeConfig {
    baseUrl: string;
    getAccessToken?: () => string | null;
    onAuthError?: () => void;
}

export class AgentForgeClient {
    private baseUrl: string;
    private getAccessToken: () => string | null;
    private onAuthError: (() => void) | undefined;

    constructor(config: AgentForgeConfig) {
        this.baseUrl = config.baseUrl.replace(/\/$/, "");
        this.getAccessToken = config.getAccessToken ?? (() => null);
        this.onAuthError = config.onAuthError;
    }

    private authHeaders(): Record<string, string> {
        const token = this.getAccessToken();
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (token) {
            headers["Authorization"] = `Bearer ${token}`;
        }
        return headers;
    }

    async request<T>(path: string, options?: RequestInit): Promise<T> {
        const res = await fetch(`${this.baseUrl}${path}`, {
            headers: this.authHeaders(),
            ...options,
        });
        if (res.status === 401 && this.onAuthError) {
            this.onAuthError();
        }
        if (!res.ok) {
            const error = await res.json().catch(() => ({ detail: res.statusText }));
            throw new Error(error.detail ?? `HTTP ${res.status}`);
        }
        return res.json();
    }

    // ---- Auth Methods ----

    async signUp(email: string, password: string): Promise<AuthResponse> {
        return this.request<AuthResponse>("/api/auth/signup", {
            method: "POST",
            body: JSON.stringify({ email, password }),
        });
    }

    async signIn(email: string, password: string): Promise<AuthResponse> {
        return this.request<AuthResponse>("/api/auth/signin", {
            method: "POST",
            body: JSON.stringify({ email, password }),
        });
    }

    async refreshToken(refreshToken: string): Promise<AuthResponse> {
        return this.request<AuthResponse>("/api/auth/refresh", {
            method: "POST",
            body: JSON.stringify({ refresh_token: refreshToken }),
        });
    }

    async signOut(): Promise<void> {
        await this.request<void>("/api/auth/signout", { method: "POST" });
    }

    async getMe(): Promise<AuthUser> {
        return this.request<AuthUser>("/api/auth/me");
    }

    async createApiKey(name: string): Promise<CreateApiKeyResponse> {
        return this.request<CreateApiKeyResponse>("/api/auth/api-keys", {
            method: "POST",
            body: JSON.stringify({ name }),
        });
    }

    async listApiKeys(): Promise<ApiKeyDTO[]> {
        return this.request<ApiKeyDTO[]>("/api/auth/api-keys");
    }

    async revokeApiKey(id: string): Promise<void> {
        await this.request<void>(`/api/auth/api-keys/${id}`, { method: "DELETE" });
    }

    // ---- Streaming ----

    async *streamChat(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
        const res = await fetch(`${this.baseUrl}/api/chat`, {
            method: "POST",
            headers: this.authHeaders(),
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
