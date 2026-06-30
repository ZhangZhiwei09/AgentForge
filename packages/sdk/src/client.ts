import type {
  AuthResponse,
  Memory,
  MemorySearchResult,
  ApiKeyDTO,
  CreateApiKeyResponse,
  AuthUser,
  AppProjectDTO,
  ProjectFileDTO,
  AppGenRunDTO,
  CreateProjectRequest,
  UpdateProjectRequest,
  GenerateAppRequest,
  KnowledgeBaseDTO,
  CreateKnowledgeBaseRequest,
  UpdateKnowledgeBaseRequest,
  KnowledgeDocumentDTO,
  KnowledgeSearchResponse,
  KnowledgeStatsDTO,
  AnalyticsDTO,
  FeedbackResponse,
  FAQDocumentDTO,
  FAQCategoryDTO,
  ChunkingConfigDTO,
  ChunkPreviewResponseDTO,
  HitTestingRequestDTO,
  HitTestingResponseDTO,
} from "@agentforge/shared-types";
import { VoiceService } from "./services/voice.js";

export interface AgentForgeConfig {
  baseUrl: string;
  getAccessToken?: () => string | null;
  onAuthError?: () => void;
}

export class AgentForgeClient {
  private baseUrl: string;
  private getAccessToken: () => string | null;
  private onAuthError: (() => void) | undefined;
  public voice: VoiceService;

  constructor(config: AgentForgeConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.getAccessToken = config.getAccessToken ?? (() => null);
    this.onAuthError = config.onAuthError;
    this.voice = new VoiceService(this.baseUrl, () => this.getAccessToken());
  }

  private authHeaders(): Record<string, string> {
    const token = this.getAccessToken();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
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

  async listTools(): Promise<{
    tools: Array<{ name: string; description: string; parameters: unknown }>;
    count: number;
  }> {
    return this.request("/api/tools");
  }

  async listMemories(type?: string): Promise<Memory[]> {
    const path = type
      ? `/api/memories?type=${encodeURIComponent(type)}`
      : "/api/memories";
    return this.request<Memory[]>(path);
  }

  async searchMemories(
    query: string,
    topK: number = 5,
  ): Promise<MemorySearchResult[]> {
    return this.request<MemorySearchResult[]>(
      `/api/memories/search?q=${encodeURIComponent(query)}&top_k=${topK}`,
    );
  }

  async deleteMemory(id: string): Promise<void> {
    await this.request<void>(`/api/memories/${id}`, {
      method: "DELETE",
    });
  }

  // ---- App Projects (WeaveFox V12) ----

  async createProject(input: CreateProjectRequest): Promise<AppProjectDTO> {
    return this.request<AppProjectDTO>("/api/projects", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async listProjects(): Promise<{ projects: AppProjectDTO[]; count: number }> {
    return this.request<{ projects: AppProjectDTO[]; count: number }>(
      "/api/projects",
    );
  }

  async getProject(
    id: string,
  ): Promise<AppProjectDTO & { files: ProjectFileDTO[] }> {
    return this.request<AppProjectDTO & { files: ProjectFileDTO[] }>(
      `/api/projects/${id}`,
    );
  }

  async updateProject(
    id: string,
    input: UpdateProjectRequest,
  ): Promise<AppProjectDTO> {
    return this.request<AppProjectDTO>(`/api/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  async deleteProject(id: string): Promise<void> {
    await this.request<void>(`/api/projects/${id}`, { method: "DELETE" });
  }

  async generateApp(
    projectId: string,
    input: GenerateAppRequest,
  ): Promise<Response> {
    const res = await fetch(
      `${this.baseUrl}/api/projects/${projectId}/generate`,
      {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify(input),
      },
    );
    if (!res.ok) {
      const error = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(error.detail ?? `HTTP ${res.status}`);
    }
    return res; // Returns Response for SSE streaming
  }

  async listProjectFiles(
    id: string,
  ): Promise<{ files: ProjectFileDTO[]; count: number }> {
    return this.request<{ files: ProjectFileDTO[]; count: number }>(
      `/api/projects/${id}/files`,
    );
  }

  async getProjectFile(
    projectId: string,
    filePath: string,
  ): Promise<ProjectFileDTO> {
    return this.request<ProjectFileDTO>(
      `/api/projects/${projectId}/files/${encodeURIComponent(filePath)}`,
    );
  }

  async writeProjectFile(
    projectId: string,
    filePath: string,
    content: string,
    language?: string,
  ): Promise<ProjectFileDTO> {
    return this.request<ProjectFileDTO>(
      `/api/projects/${projectId}/files/${encodeURIComponent(filePath)}`,
      {
        method: "PUT",
        body: JSON.stringify({ content, language }),
      },
    );
  }

  async listGenRuns(
    projectId: string,
  ): Promise<{ runs: AppGenRunDTO[]; count: number }> {
    return this.request<{ runs: AppGenRunDTO[]; count: number }>(
      `/api/projects/${projectId}/generations`,
    );
  }

  // ---- Knowledge Bases ----

  async listKnowledgeBases(): Promise<KnowledgeBaseDTO[]> {
    return this.request<KnowledgeBaseDTO[]>("/api/knowledge/bases");
  }

  async getKnowledgeBase(kbId: string): Promise<KnowledgeBaseDTO> {
    return this.request<KnowledgeBaseDTO>(`/api/knowledge/bases/${kbId}`);
  }

  async createKnowledgeBase(
    input: CreateKnowledgeBaseRequest,
  ): Promise<KnowledgeBaseDTO> {
    return this.request<KnowledgeBaseDTO>("/api/knowledge/bases", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async updateKnowledgeBase(
    kbId: string,
    input: UpdateKnowledgeBaseRequest,
  ): Promise<KnowledgeBaseDTO> {
    return this.request<KnowledgeBaseDTO>(`/api/knowledge/bases/${kbId}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }

  async deleteKnowledgeBase(kbId: string): Promise<void> {
    await this.request<void>(`/api/knowledge/bases/${kbId}`, {
      method: "DELETE",
    });
  }

  // ---- Knowledge Documents ----

  async listDocuments(kbId: string): Promise<KnowledgeDocumentDTO[]> {
    return this.request<KnowledgeDocumentDTO[]>(
      `/api/knowledge/bases/${kbId}/documents`,
    );
  }

  async getDocument(docId: string): Promise<KnowledgeDocumentDTO> {
    return this.request<KnowledgeDocumentDTO>(
      `/api/knowledge/documents/${docId}`,
    );
  }

  async deleteDocument(docId: string): Promise<void> {
    await this.request<void>(`/api/knowledge/documents/${docId}`, {
      method: "DELETE",
    });
  }

  async searchKnowledge(
    query: string,
    kbIds?: string[] | null,
    topK?: number,
  ): Promise<KnowledgeSearchResponse> {
    return this.request<KnowledgeSearchResponse>("/api/knowledge/search", {
      method: "POST",
      body: JSON.stringify({ query, kb_ids: kbIds, top_k: topK ?? 3 }),
    });
  }

  // ---- Knowledge Document Upload ----

  async uploadDocumentFile(
    kbId: string,
    file: File,
    options?: { title?: string },
  ): Promise<KnowledgeDocumentDTO> {
    const formData = new FormData();
    formData.append("file", file);
    if (options?.title) {
      formData.append("title", options.title);
    }

    const token = this.getAccessToken();
    const headers: Record<string, string> = {};
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    // 不设置 Content-Type，让浏览器自动生成含 boundary 的 multipart/form-data

    const res = await fetch(
      `${this.baseUrl}/api/knowledge/bases/${encodeURIComponent(kbId)}/documents/upload`,
      {
        method: "POST",
        headers,
        body: formData,
      },
    );

    if (res.status === 401 && this.onAuthError) {
      this.onAuthError();
    }
    if (!res.ok) {
      const error = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(error.detail ?? `HTTP ${res.status}`);
    }
    return res.json();
  }

  // ---- Chunk Preview ----

  async previewChunks(
    text: string,
    config: ChunkingConfigDTO,
  ): Promise<ChunkPreviewResponseDTO> {
    return this.request<ChunkPreviewResponseDTO>("/api/knowledge/chunk-preview", {
      method: "POST",
      body: JSON.stringify({
        text,
        chunk_size_tokens: config.maxChunkSize,
        chunk_overlap_tokens: config.overlap,
        chunk_structure: config.mode === "parent_child" ? "hierarchical" : "paragraph",
        child_chunk_size_tokens: config.childMaxSize,
        child_chunk_overlap_tokens: config.overlap,
        separator_mode: config.separator ? "custom" : "auto",
        custom_separator: config.separator || null,
      }),
    });
  }

  // ---- Hit Testing ----

  async hitTest(
    kbId: string,
    params: HitTestingRequestDTO,
  ): Promise<HitTestingResponseDTO> {
    return this.request<HitTestingResponseDTO>(
      `/api/knowledge/bases/${encodeURIComponent(kbId)}/hit-testing`,
      {
        method: "POST",
        body: JSON.stringify({
          query: params.query,
          top_k: params.topK ?? 10,
          search_method: params.searchMethod ?? "hybrid",
          reranking_enable: params.rerankingEnable ?? true,
          score_threshold: params.scoreThreshold ?? 0,
        }),
      },
    );
  }

  async getKnowledgeStats(): Promise<KnowledgeStatsDTO> {
    return this.request<KnowledgeStatsDTO>("/api/knowledge/stats");
  }

  // ---- Analytics & Feedback ----

  async getAnalytics(): Promise<AnalyticsDTO> {
    return this.request<AnalyticsDTO>("/api/agent/chat/analytics");
  }

  async getFeedback(
    type: "all" | "positive" | "negative" = "all",
    page = 1,
    limit = 20,
  ): Promise<FeedbackResponse> {
    const params = new URLSearchParams({ type, page: String(page), limit: String(limit) });
    return this.request<FeedbackResponse>(
      `/api/agent/chat/feedback?${params.toString()}`,
    );
  }

  // ---- FAQ ----

  async getFAQ(category?: string): Promise<{ documents: FAQDocumentDTO[] }> {
    const url = category
      ? `/api/agent/chat/faq?category=${encodeURIComponent(category)}`
      : "/api/agent/chat/faq";
    return this.request<{ documents: FAQDocumentDTO[] }>(url);
  }

  async getFAQCategories(): Promise<{ categories: FAQCategoryDTO[] }> {
    return this.request<{ categories: FAQCategoryDTO[] }>(
      "/api/agent/chat/faq/categories",
    );
  }
}
