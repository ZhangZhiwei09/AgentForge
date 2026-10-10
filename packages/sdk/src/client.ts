import type {
  AuthResponse,
  Memory,
  MemorySearchResult,
  ApiKeyDTO,
  CreateApiKeyResponse,
  AuthUser,
  KnowledgeBaseDTO,
  CreateKnowledgeBaseRequest,
  UpdateKnowledgeBaseRequest,
  KnowledgeChunkDTO,
  UpdateKnowledgeChunkRequest,
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
  KnowledgeRegressionRunDTO,
  KnowledgeRegressionTestSetDTO,
  KnowledgeRegressionCaseDTO,
  CreateKnowledgeRegressionCaseRequest,
  CreateKnowledgeRegressionTestSetRequest,
  KnowledgeRegressionMetricsDTO,
  KnowledgeRegressionMetricsQuery,
  AgentFlowDTO,
  AgentFlowDefinition,
  AgentFlowRunDTO,
  AgentFlowEvent,
  EntryRouteFlowDTO,
  EntryRouteDefinition,
  EntryRouteValidation,
  EntryRouteRunDTO,
  EntryRouteRunPage,
} from "@agentforge/shared-types";
export interface AgentForgeConfig {
  baseUrl: string;
  getAccessToken?: () => string | null;
  onAuthError?: () => void;
}

function formatApiError(detail: unknown, status: number): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail.map((item: { loc?: string[]; msg?: string }) =>
      `${item.loc?.join(".") ?? ""}: ${item.msg ?? "请求格式错误"}`).join("\n");
  }
  if (detail && typeof detail === "object") {
    const structured = detail as { message?: string; errors?: Array<{ path: string; message: string }> };
    return structured.errors?.map((item) => `${item.path}: ${item.message}`).join("\n")
      || structured.message || `HTTP ${status}`;
  }
  return `HTTP ${status}`;
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
      throw new Error(formatApiError(error.detail, res.status));
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

  async listAgentFlows(): Promise<{ items: AgentFlowDTO[] }> {
    return this.request("/api/agent-flows");
  }

  async listEntryRouteFlows(): Promise<{ items: EntryRouteFlowDTO[] }> {
    return this.request("/api/entry-route-flows");
  }

  async createEntryRouteFlow(name: string, template: "default" | "empty" = "default"): Promise<EntryRouteFlowDTO> {
    return this.request("/api/entry-route-flows", { method: "POST", body: JSON.stringify({ name, template }) });
  }

  async getEntryRouteFlow(id: string): Promise<EntryRouteFlowDTO> {
    return this.request(`/api/entry-route-flows/${id}`);
  }

  async saveEntryRouteFlow(id: string, name: string, revision: number, definition: EntryRouteDefinition): Promise<EntryRouteFlowDTO> {
    return this.request(`/api/entry-route-flows/${id}/draft`, { method: "PUT", body: JSON.stringify({ name, revision, definition }) });
  }

  async validateEntryRouteFlow(id: string, revision: number): Promise<EntryRouteValidation> {
    return this.request(`/api/entry-route-flows/${id}/validate`, { method: "POST", body: JSON.stringify({ revision }) });
  }

  async publishEntryRouteFlow(id: string, revision: number): Promise<EntryRouteFlowDTO> {
    return this.request(`/api/entry-route-flows/${id}/publish`, { method: "POST", body: JSON.stringify({ revision }) });
  }

  async activateEntryRouteFlow(id: string, enabled: boolean): Promise<EntryRouteFlowDTO> {
    return this.request(`/api/entry-route-flows/${id}/activation`, { method: "PUT", body: JSON.stringify({ enabled }) });
  }

  async archiveEntryRouteFlow(id: string): Promise<{ ok: boolean }> {
    return this.request(`/api/entry-route-flows/${id}`, { method: "DELETE" });
  }

  async testEntryRouteFlow(id: string, revision: number, message: string, signal?: AbortSignal): Promise<EntryRouteRunDTO> {
    return this.request(`/api/entry-route-flows/${id}/test-run`, { method: "POST", body: JSON.stringify({ revision, message }), signal });
  }

  async listEntryRouteRuns(id: string, page = 1): Promise<EntryRouteRunPage> {
    return this.request(`/api/entry-route-flows/${id}/runs?page=${page}`);
  }

  async getEntryRouteRun(id: string, runId: string): Promise<EntryRouteRunDTO> {
    return this.request(`/api/entry-route-flows/${id}/runs/${runId}`);
  }

  async createAgentFlow(name: string): Promise<AgentFlowDTO> {
    return this.request("/api/agent-flows", { method: "POST", body: JSON.stringify({ name }) });
  }

  async getAgentFlow(id: string): Promise<AgentFlowDTO> {
    return this.request(`/api/agent-flows/${id}`);
  }

  async saveAgentFlow(id: string, name: string, revision: number, definition: AgentFlowDefinition): Promise<AgentFlowDTO> {
    return this.request(`/api/agent-flows/${id}/draft`, {
      method: "PUT", body: JSON.stringify({ name, revision, definition }),
    });
  }

  async publishAgentFlow(id: string, revision: number): Promise<AgentFlowDTO> {
    return this.request(`/api/agent-flows/${id}/publish`, {
      method: "POST", body: JSON.stringify({ revision }),
    });
  }

  async activateAgentFlow(id: string, enabled: boolean): Promise<AgentFlowDTO> {
    return this.request(`/api/agent-flows/${id}/activation`, {
      method: "PUT", body: JSON.stringify({ enabled }),
    });
  }

  async archiveAgentFlow(id: string): Promise<{ ok: boolean }> {
    return this.request(`/api/agent-flows/${id}`, { method: "DELETE" });
  }

  async listAgentFlowTools(): Promise<{ tools: Array<{ name: string; description: string }> }> {
    return this.request("/api/agent-flows/tools");
  }

  async listAgentFlowRuns(id: string): Promise<{ items: AgentFlowRunDTO[] }> {
    return this.request(`/api/agent-flows/${id}/runs`);
  }

  async cancelAgentFlowRun(id: string, runId: string): Promise<{ ok: boolean }> {
    return this.request(`/api/agent-flows/${id}/runs/${runId}/cancel`, { method: "POST" });
  }

  async *testAgentFlow(id: string, revision: number, message: string, signal?: AbortSignal): AsyncGenerator<AgentFlowEvent> {
    const response = await fetch(`${this.baseUrl}/api/agent-flows/${id}/test-run`, {
      method: "POST", headers: this.authHeaders(), body: JSON.stringify({ revision, message }), signal,
    });
    if (response.status === 401) this.onAuthError?.();
    if (!response.ok || !response.body) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(formatApiError(error.detail, response.status));
    }
    const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let terminal = false;
      try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
          buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
          if (buffer.length > 1048576) throw new Error("流程事件超过大小上限");
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split("\n").filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim()).join("\n");
            if (data && data !== "[DONE]") {
              const event = JSON.parse(data) as AgentFlowEvent;
              if (["flow_completed", "flow_failed", "flow_cancelled", "flow_waiting_input"].includes(event.type)) terminal = true;
              yield event;
            }
          }
        }
        if (!terminal) throw new Error("流程连接提前结束，请查看运行记录");
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
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

  async getDocumentChunks(docId: string): Promise<KnowledgeChunkDTO[]> {
    return this.request<KnowledgeChunkDTO[]>(
      `/api/knowledge/documents/${docId}/chunks`,
    );
  }

  async updateKnowledgeChunk(
    chunkId: string,
    input: UpdateKnowledgeChunkRequest,
  ): Promise<KnowledgeChunkDTO> {
    return this.request<KnowledgeChunkDTO>(
      `/api/knowledge/chunks/${encodeURIComponent(chunkId)}`,
      {
        method: "PUT",
        body: JSON.stringify(input),
      },
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
    options?: { title?: string; process?: boolean },
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

    // process=false 跳过入队，由前端在配置保存后显式触发
    const processParam = options?.process === false ? "?process=false" : "";

    const res = await fetch(
      `${this.baseUrl}/api/knowledge/bases/${encodeURIComponent(kbId)}/documents/upload${processParam}`,
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
    // 自动 clamp overlap：后端校验要求 overlap < size * 0.5，避免 400
    const clampOverlap = (size: number, overlap: number) =>
      Math.min(overlap, Math.max(0, Math.floor(size * 0.5) - 1));

    const parentSize = config.maxChunkSize;
    const parentOverlap = clampOverlap(parentSize, config.overlap);
    const childSize = config.childMaxSize ?? parentSize;
    const childOverlap = clampOverlap(childSize, parentOverlap);

    return this.request<ChunkPreviewResponseDTO>("/api/knowledge/chunk-preview", {
      method: "POST",
      body: JSON.stringify({
        text,
        chunk_size_tokens: parentSize,
        chunk_overlap_tokens: parentOverlap,
        chunk_structure: config.mode === "parent_child" ? "hierarchical" : "paragraph",
        child_chunk_size_tokens: childSize,
        child_chunk_overlap_tokens: childOverlap,
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

  async listKnowledgeRegressionTestSets(
    kbId: string,
  ): Promise<KnowledgeRegressionTestSetDTO[]> {
    return this.request<KnowledgeRegressionTestSetDTO[]>(
      `/api/knowledge/bases/${encodeURIComponent(kbId)}/regression/test-sets`,
    );
  }

  async createKnowledgeRegressionTestSet(
    kbId: string,
    input: CreateKnowledgeRegressionTestSetRequest,
  ): Promise<KnowledgeRegressionTestSetDTO> {
    return this.request<KnowledgeRegressionTestSetDTO>(
      `/api/knowledge/bases/${encodeURIComponent(kbId)}/regression/test-sets`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  }

  async createKnowledgeRegressionCase(
    kbId: string,
    input: CreateKnowledgeRegressionCaseRequest,
  ): Promise<KnowledgeRegressionCaseDTO> {
    return this.request<KnowledgeRegressionCaseDTO>(
      `/api/knowledge/bases/${encodeURIComponent(kbId)}/regression/cases`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  }

  async updateKnowledgeRegressionCase(
    caseId: string,
    input: CreateKnowledgeRegressionCaseRequest,
  ): Promise<KnowledgeRegressionCaseDTO> {
    return this.request<KnowledgeRegressionCaseDTO>(`/api/knowledge/regression/cases/${encodeURIComponent(caseId)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }

  async deleteKnowledgeRegressionCase(caseId: string): Promise<void> {
    await this.request<void>(
      `/api/knowledge/regression/cases/${encodeURIComponent(caseId)}`,
      { method: "DELETE" },
    );
  }

  async runKnowledgeRegression(
    kbId: string,
    testSetId?: string,
  ): Promise<KnowledgeRegressionRunDTO> {
    return this.request<KnowledgeRegressionRunDTO>(
      `/api/knowledge/bases/${encodeURIComponent(kbId)}/regression/runs`,
      {
        method: "POST",
        body: JSON.stringify({ testSetId }),
      },
    );
  }

  async listKnowledgeRegressionRuns(
    kbId: string,
    testSetId?: string,
  ): Promise<KnowledgeRegressionRunDTO[]> {
    const suffix = testSetId
      ? `?testSetId=${encodeURIComponent(testSetId)}`
      : "";
    return this.request<KnowledgeRegressionRunDTO[]>(
      `/api/knowledge/bases/${encodeURIComponent(kbId)}/regression/runs${suffix}`,
    );
  }

  async getKnowledgeRegressionMetrics(
    kbId: string,
    opts?: KnowledgeRegressionMetricsQuery,
  ): Promise<KnowledgeRegressionMetricsDTO> {
    const params = new URLSearchParams();
    if (opts?.testSetId) params.set("testSetId", opts.testSetId);
    if (opts?.limit != null) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return this.request<KnowledgeRegressionMetricsDTO>(
      `/api/knowledge/bases/${encodeURIComponent(kbId)}/regression/metrics${qs ? `?${qs}` : ""}`,
    );
  }

  async getKnowledgeStats(): Promise<KnowledgeStatsDTO> {
    return this.request<KnowledgeStatsDTO>("/api/knowledge/stats");
  }

  // ---- Knowledge Processing ----

  /** 将知识库中所有 pending 状态的文档入队处理（在保存分块配置后调用） */
  async processKnowledgeBase(kbId: string): Promise<{ processed: number; message: string }> {
    return this.request<{ processed: number; message: string }>(
      `/api/knowledge/bases/${encodeURIComponent(kbId)}/process`,
      { method: "POST" },
    );
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
