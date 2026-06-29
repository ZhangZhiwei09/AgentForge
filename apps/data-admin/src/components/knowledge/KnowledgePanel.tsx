import { useState, useEffect, useCallback } from "react";
import {
  BookOpen,
  Search,
  Trash2,
  Loader2,
  RefreshCw,
  Plus,
  Upload,
  FileText,
  ChevronLeft,
  FolderOpen,
  Eye,
} from "lucide-react";

// ── Types ──────────────────────────────────────

interface KnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  document_count: number;
  created_at: string;
  updated_at: string;
}

interface KnowledgeDocument {
  id: string;
  knowledgeBaseId: string;
  title: string;
  content: string;
  chunkCount: number;
  status: string;
  createdAt: string;
  originalFilename?: string | null;
  originalFileType?: string | null;
  errorMessage?: string | null;
  qualityLabel?: string | null;
  processingDetail?: ProcessingDetail | null;
  processingStartedAt?: string | null;
  downloadingCompletedAt?: string | null;
  parsingCompletedAt?: string | null;
  normalizingCompletedAt?: string | null;
  chunkingCompletedAt?: string | null;
  embeddingCompletedAt?: string | null;
}

interface ProcessingDetail {
  phase: string;
  progress: number;
  total: number;
  message: string;
  updatedAt?: string;
}

interface KnowledgeSearchResult {
  chunkId: string;
  docId: string;
  kbId: string;
  content: string;
  score: number;
  chunkIndex: number;
  docTitle: string;
}

interface GraphStats {
  available: boolean;
  nodeCount: number;
  relationCount: number;
}

interface KnowledgeStats {
  knowledge_bases: number;
  documents: number;
  chunks: number;
  milvus: Record<string, unknown>;
  totalChunks?: number;
  chunksWithEmbedding?: number;
  pgvectorEnabled?: boolean;
  elasticsearchAvailable?: boolean;
  elasticsearchIndexedChunks?: number;
}

// ── API Helpers ────────────────────────────────

const API_BASE = "/api/knowledge";

function authHeaders(json: boolean = true): Record<string, string> {
  const token = localStorage.getItem("accessToken");
  const headers: Record<string, string> = {};
  if (json) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

function handle401(res: Response): void {
  if (res.status === 401) {
    localStorage.removeItem("accessToken");
    if (window.location.pathname !== "/login") {
      window.location.href = "/login";
    }
  }
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders() });
  handle401(res);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  handle401(res);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? `HTTP ${res.status}`);
  }
  return res.json();
}

async function apiDelete(path: string): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  handle401(res);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// ── Component ──────────────────────────────────

type ViewMode = "bases" | "documents";

interface KnowledgePanelProps {
  viewingDoc: KnowledgeDocument | null;
  onViewDoc: (doc: KnowledgeDocument | null) => void;
}

export function KnowledgePanel({ viewingDoc, onViewDoc }: KnowledgePanelProps) {
  // Navigation state
  const [viewMode, setViewMode] = useState<ViewMode>("bases");
  const [selectedKb, setSelectedKb] = useState<KnowledgeBase | null>(null);

  // Data state
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [searchResults, setSearchResults] = useState<
    KnowledgeSearchResult[] | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Create KB state
  const [showCreateKb, setShowCreateKb] = useState(false);
  const [newKbName, setNewKbName] = useState("");
  const [newKbDesc, setNewKbDesc] = useState("");

  // Upload document state
  const [showUpload, setShowUpload] = useState(false);
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadContent, setUploadContent] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadMode, setUploadMode] = useState<"text" | "file">("text");

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);

  // Infrastructure stats state
  const [stats, setStats] = useState<KnowledgeStats | null>(null);
  const [graphStats, setGraphStats] = useState<GraphStats | null>(null);

  // ── Data fetching ──────────────────────────

  const fetchKnowledgeBases = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<KnowledgeBase[]>("/bases");
      setKnowledgeBases(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchDocuments = useCallback(async (kbId: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<KnowledgeDocument[]>(
        `/bases/${kbId}/documents`,
      );
      setDocuments(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const [knowStats, graph] = await Promise.all([
        apiGet<KnowledgeStats>("/stats"),
        apiGet<GraphStats>("/graph/stats").catch(() => ({
          available: false,
          nodeCount: 0,
          relationCount: 0,
        })),
      ]);
      setStats(knowStats);
      setGraphStats(graph);
    } catch {
      // Stats fetch failure is silent — infrastructure indicators show red
    }
  }, []);

  useEffect(() => {
    if (viewMode === "bases") {
      fetchKnowledgeBases();
    }
  }, [viewMode, fetchKnowledgeBases]);

  useEffect(() => {
    if (viewMode === "documents" && selectedKb) {
      fetchDocuments(selectedKb.id);
    }
  }, [viewMode, selectedKb, fetchDocuments]);

  // 处理中的文档自动轮询（每 3 秒刷新）
  useEffect(() => {
    if (viewMode !== "documents" || !selectedKb) return;
    const hasProcessing = documents.some(
      (d) => !["completed", "failed", "pending"].includes(d.status),
    );
    if (!hasProcessing) return;

    const timer = setInterval(() => {
      fetchDocuments(selectedKb.id);
    }, 3000);
    return () => clearInterval(timer);
  }, [viewMode, selectedKb, documents, fetchDocuments]);

  // Auto-fetch stats on mount
  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  // ── Actions ─────────────────────────────────

  const handleCreateKb = async () => {
    if (!newKbName.trim()) return;
    try {
      await apiPost("/bases", {
        name: newKbName.trim(),
        description: newKbDesc.trim() || null,
      });
      setNewKbName("");
      setNewKbDesc("");
      setShowCreateKb(false);
      fetchKnowledgeBases();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create");
    }
  };

  const handleDeleteKb = async (kbId: string) => {
    if (!confirm("Delete this knowledge base and all its documents?")) return;
    try {
      await apiDelete(`/bases/${kbId}`);
      fetchKnowledgeBases();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    }
  };

  const handleUploadDocument = async () => {
    if (!selectedKb) return;
    try {
      if (uploadMode === "file" && uploadFile) {
        const formData = new FormData();
        formData.append("file", uploadFile);
        const token = localStorage.getItem("accessToken");
        const res = await fetch(
          `${API_BASE}/bases/${selectedKb.id}/documents/upload`,
          {
            method: "POST",
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            body: formData,
          },
        );
        if (!res.ok) {
          const err = await res
            .json()
            .catch(() => ({ detail: res.statusText }));
          throw new Error(err.detail ?? `HTTP ${res.status}`);
        }
      } else if (
        uploadMode === "text" &&
        uploadTitle.trim() &&
        uploadContent.trim()
      ) {
        await apiPost(`/bases/${selectedKb.id}/documents`, {
          title: uploadTitle.trim(),
          content: uploadContent,
        });
      } else {
        return;
      }
      setUploadTitle("");
      setUploadContent("");
      setUploadFile(null);
      setShowUpload(false);
      fetchDocuments(selectedKb.id);
      // Refresh KB list to update doc count
      fetchKnowledgeBases();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to upload");
    }
  };

  const handleDeleteDocument = async (docId: string) => {
    if (!confirm("Delete this document?")) return;
    try {
      await apiDelete(`/documents/${docId}`);
      if (selectedKb) {
        fetchDocuments(selectedKb.id);
        fetchKnowledgeBases();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    try {
      const data = await apiPost<{ results: KnowledgeSearchResult[] }>(
        "/search",
        {
          query: searchQuery.trim(),
          kb_ids: selectedKb ? [selectedKb.id] : null,
          top_k: 5,
        },
      );
      setSearchResults(data.results);
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  const openDocuments = (kb: KnowledgeBase) => {
    setSelectedKb(kb);
    setViewMode("documents");
    setSearchResults(null);
    setSearchQuery("");
  };

  const backToBases = () => {
    setSelectedKb(null);
    setViewMode("bases");
    setDocuments([]);
    setSearchResults(null);
    setSearchQuery("");
    setShowUpload(false);
  };

  // ── Render Helpers ──────────────────────────

  const scoreColor = (score: number): string => {
    if (score >= 0.8) return "text-green-600 bg-green-50";
    if (score >= 0.5) return "text-amber-600 bg-amber-50";
    return "text-red-500 bg-red-50";
  };

  const statusBadge = (status: string) => {
    const map: Record<string, string> = {
      completed: "bg-green-100 text-green-700",
      processing: "bg-amber-100 text-amber-700",
      failed: "bg-red-100 text-red-700",
      pending: "bg-gray-100 text-gray-500",
    };
    return map[status] ?? "bg-gray-100 text-gray-500";
  };

  // Stage progress bar — 参考 Dify 的阶段进度追踪设计
  const getStageProgress = (doc: KnowledgeDocument) => {
    const stages = doc.originalFilename
      ? [
          { key: "download", label: "下载", done: !!doc.downloadingCompletedAt },
          { key: "parse", label: "解析", done: !!doc.parsingCompletedAt },
          { key: "clean", label: "清洗", done: !!doc.normalizingCompletedAt },
          { key: "chunk", label: "分段", done: !!doc.chunkingCompletedAt },
          { key: "embed", label: "向量化", done: !!doc.embeddingCompletedAt },
        ]
      : [
          { key: "clean", label: "清洗", done: !!doc.normalizingCompletedAt },
          { key: "chunk", label: "分段", done: !!doc.chunkingCompletedAt },
          { key: "embed", label: "向量化", done: !!doc.embeddingCompletedAt },
        ];

    const completedCount = stages.filter((s) => s.done).length;
    const progressPct = doc.processingDetail
      ? Math.round((doc.processingDetail.progress / doc.processingDetail.total) * 100)
      : stages.length > 0
        ? Math.round((completedCount / stages.length) * 100)
        : 0;
    const currentPhase = doc.processingDetail?.phase;

    return { stages, completedCount, progressPct, currentPhase };
  };

  // Document status display with stage progress
  function DocumentStatus({ doc }: { doc: KnowledgeDocument }) {
    if (doc.status === "completed") {
      return (
        <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-green-100 text-green-700">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500" />
          完成
        </span>
      );
    }

    if (doc.status === "failed") {
      return (
        <span
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-red-100 text-red-700"
          title={doc.errorMessage ?? undefined}
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500" />
          失败
        </span>
      );
    }

    if (doc.status === "pending") {
      return (
        <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-gray-100 text-gray-500">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-gray-400" />
          等待
        </span>
      );
    }

    // Processing — show stage progress bar
    const { stages, progressPct, currentPhase } = getStageProgress(doc);

    return (
      <div className="flex items-center gap-1.5 flex-1 min-w-0">
        {/* Stage dots */}
        <div className="flex items-center gap-0.5">
          {stages.map((stage, i) => (
            <div
              key={stage.key}
              className={`h-1.5 rounded-full transition-all ${
                stage.done
                  ? "w-3 bg-green-500"
                  : currentPhase === stage.key
                    ? "w-3 bg-amber-400 animate-pulse"
                    : "w-1.5 bg-gray-300"
              }`}
              title={`${stage.label}${stage.done ? " ✓" : currentPhase === stage.key ? " ..." : ""}`}
            />
          ))}
        </div>
        {/* Progress percent */}
        <span className="text-[10px] text-muted-foreground font-mono tabular-nums">
          {progressPct}%
        </span>
      </div>
    );
  }

  // ── Main Render ─────────────────────────────

  return (
    <aside className="flex w-80 flex-col border-l border-[hsl(var(--border))] bg-[hsl(var(--muted))]/30">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-3 py-2.5">
        <div className="flex items-center gap-2 text-xs font-medium">
          <BookOpen className="h-3.5 w-3.5" />
          {viewMode === "documents" && selectedKb ? (
            <>
              <button
                onClick={backToBases}
                className="rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors"
                title="Back to Knowledge Bases"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="truncate max-w-[140px]">{selectedKb.name}</span>
            </>
          ) : (
            <>
              Knowledge Base
              {knowledgeBases.length > 0 && (
                <span className="rounded-full bg-[hsl(var(--primary))]/10 px-1.5 py-0.5 text-[10px] text-[hsl(var(--primary))]">
                  {knowledgeBases.length}
                </span>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() =>
              viewMode === "bases"
                ? fetchKnowledgeBases()
                : selectedKb && fetchDocuments(selectedKb.id)
            }
            className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            title="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          {/* Close button removed — standalone page */}
        </div>
      </div>

      {/* Search Bar */}
      <div className="border-b border-[hsl(var(--border))] px-3 py-2">
        <div className="flex gap-1">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder={
              viewMode === "documents"
                ? `Search in ${selectedKb?.name ?? "KB"}...`
                : "Search all knowledge..."
            }
            className="flex-1 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ring))]"
          />
          <button
            onClick={handleSearch}
            disabled={searching}
            className="rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 py-1 text-xs text-foreground hover:bg-[hsl(var(--accent))] disabled:opacity-50"
          >
            {searching ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Search className="h-3 w-3" />
            )}
          </button>
          {searchResults != null && (
            <button
              onClick={() => {
                setSearchQuery("");
                setSearchResults(null);
              }}
              className="rounded px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Action Bar */}
      <div className="flex items-center gap-1 border-b border-[hsl(var(--border))] px-3 py-1.5">
        {viewMode === "bases" ? (
          <button
            onClick={() => setShowCreateKb(!showCreateKb)}
            className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--accent))] transition-colors"
          >
            <Plus className="h-3 w-3" />
            New KB
          </button>
        ) : (
          <button
            onClick={() => setShowUpload(!showUpload)}
            className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--accent))] transition-colors"
          >
            <Upload className="h-3 w-3" />
            Add Document
          </button>
        )}
      </div>

      {/* Create KB Form */}
      {showCreateKb && viewMode === "bases" && (
        <div className="border-b border-[hsl(var(--border))] px-3 py-2 space-y-2">
          <input
            type="text"
            value={newKbName}
            onChange={(e) => setNewKbName(e.target.value)}
            placeholder="Knowledge base name..."
            className="w-full rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ring))]"
            onKeyDown={(e) => e.key === "Enter" && handleCreateKb()}
          />
          <input
            type="text"
            value={newKbDesc}
            onChange={(e) => setNewKbDesc(e.target.value)}
            placeholder="Description (optional)..."
            className="w-full rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ring))]"
            onKeyDown={(e) => e.key === "Enter" && handleCreateKb()}
          />
          <div className="flex gap-1">
            <button
              onClick={handleCreateKb}
              disabled={!newKbName.trim()}
              className="flex-1 rounded bg-[hsl(var(--primary))] px-2 py-1 text-[11px] font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:opacity-50"
            >
              Create
            </button>
            <button
              onClick={() => {
                setShowCreateKb(false);
                setNewKbName("");
                setNewKbDesc("");
              }}
              className="rounded border border-[hsl(var(--border))] px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Upload Document Form */}
      {showUpload && viewMode === "documents" && (
        <div className="border-b border-[hsl(var(--border))] px-3 py-2 space-y-2">
          {/* Mode toggle */}
          <div className="flex rounded border border-[hsl(var(--border))] overflow-hidden">
            <button
              onClick={() => setUploadMode("text")}
              className={`flex-1 flex items-center justify-center gap-1 px-2 py-1 text-[11px] transition-colors ${
                uploadMode === "text"
                  ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                  : "bg-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <FileText className="h-3 w-3" />
              Text
            </button>
            <button
              onClick={() => setUploadMode("file")}
              className={`flex-1 flex items-center justify-center gap-1 px-2 py-1 text-[11px] transition-colors ${
                uploadMode === "file"
                  ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                  : "bg-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <Upload className="h-3 w-3" />
              File
            </button>
          </div>

          {uploadMode === "text" ? (
            <>
              <input
                type="text"
                value={uploadTitle}
                onChange={(e) => setUploadTitle(e.target.value)}
                placeholder="Document title..."
                className="w-full rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ring))]"
              />
              <textarea
                value={uploadContent}
                onChange={(e) => setUploadContent(e.target.value)}
                placeholder="Document content... (paste text here)"
                rows={4}
                className="w-full rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ring))] resize-none"
              />
            </>
          ) : (
            <div className="space-y-1">
              <label className="flex flex-col items-center justify-center gap-1 rounded border border-dashed border-[hsl(var(--border))] px-3 py-3 cursor-pointer hover:bg-[hsl(var(--accent))]/50 transition-colors">
                <Upload className="h-4 w-4 text-muted-foreground" />
                <span className="text-[11px] text-muted-foreground">
                  {uploadFile ? uploadFile.name : "Click to select file"}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  .txt, .md, .json, .csv, .html, .pdf, .docx, .png, .jpg, .mp3, .wav, .mp4, .webm
                </span>
                <input
                  type="file"
                  accept=".txt,.md,.json,.csv,.html,.xml,.yaml,.yml,.log,.pdf,.docx,.png,.jpg,.jpeg,.gif,.bmp,.webp,.mp3,.wav,.m4a,.ogg,.mp4,.webm,.mov"
                  onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
                  className="hidden"
                />
              </label>
            </div>
          )}

          <div className="flex gap-1">
            <button
              onClick={handleUploadDocument}
              disabled={
                uploadMode === "text"
                  ? !uploadTitle.trim() || !uploadContent.trim()
                  : !uploadFile
              }
              className="flex-1 rounded bg-[hsl(var(--primary))] px-2 py-1 text-[11px] font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:opacity-50"
            >
              Upload
            </button>
            <button
              onClick={() => {
                setShowUpload(false);
                setUploadTitle("");
                setUploadContent("");
                setUploadFile(null);
              }}
              className="rounded border border-[hsl(var(--border))] px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="px-3 py-2">
          <p className="text-[11px] text-red-500">{error}</p>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : searchResults != null ? (
          /* Search Results */
          <div className="space-y-1.5">
            <p className="text-[10px] text-muted-foreground px-1 mb-1">
              {searchResults.length} result
              {searchResults.length !== 1 ? "s" : ""} for "{searchQuery}"
            </p>
            {searchResults.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                No results found
              </p>
            ) : (
              searchResults.map((r, i) => (
                <div
                  key={`${r.chunkId}-${i}`}
                  className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-2.5"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] font-medium text-muted-foreground truncate max-w-[180px]">
                      {r.docTitle || "Document"}
                    </span>
                    <span
                      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-mono font-medium ${scoreColor(r.score)}`}
                    >
                      {r.score.toFixed(4)}
                    </span>
                  </div>
                  <p className="text-xs leading-relaxed text-foreground line-clamp-4">
                    {r.content}
                  </p>
                </div>
              ))
            )}
          </div>
        ) : viewMode === "bases" ? (
          /* Knowledge Base List */
          knowledgeBases.length === 0 ? (
            <div className="px-3 py-8 text-center">
              <FolderOpen className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-40" />
              <p className="text-xs text-muted-foreground mb-3">
                No knowledge bases yet
              </p>
              <button
                onClick={() => setShowCreateKb(true)}
                className="inline-flex items-center gap-1 rounded bg-[hsl(var(--primary))] px-3 py-1.5 text-[11px] font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90"
              >
                <Plus className="h-3 w-3" />
                Create your first KB
              </button>
            </div>
          ) : (
            <div className="space-y-1.5">
              {knowledgeBases.map((kb) => (
                <div
                  key={kb.id}
                  onClick={() => openDocuments(kb)}
                  className="cursor-pointer rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-2.5 hover:border-[hsl(var(--ring))] hover:shadow-sm transition-all"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-foreground truncate max-w-[180px]">
                      {kb.name}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteKb(kb.id);
                      }}
                      className="rounded p-0.5 text-muted-foreground hover:text-red-400 transition-colors flex-shrink-0"
                      title="Delete"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                  {kb.description && (
                    <p className="text-[10px] text-muted-foreground mb-1 truncate">
                      {kb.description}
                    </p>
                  )}
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground">
                      {kb.document_count} document
                      {kb.document_count !== 1 ? "s" : ""}
                    </span>
                    {!kb.enabled && (
                      <span className="text-[10px] text-amber-600">
                        Disabled
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )
        ) : /* Document List */
        documents.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <FileText className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-40" />
            <p className="text-xs text-muted-foreground mb-3">
              No documents in this KB
            </p>
            <button
              onClick={() => setShowUpload(true)}
              className="inline-flex items-center gap-1 rounded bg-[hsl(var(--primary))] px-3 py-1.5 text-[11px] font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90"
            >
              <Upload className="h-3 w-3" />
              Add your first document
            </button>
          </div>
        ) : (
          <div className="space-y-1.5">
            {documents.map((doc) => (
              <div
                key={doc.id}
                onClick={() => onViewDoc(doc)}
                className={`cursor-pointer rounded-lg border p-2.5 hover:shadow-sm transition-all group ${
                  viewingDoc?.id === doc.id
                    ? "border-[hsl(var(--ring))] bg-[hsl(var(--accent))]"
                    : "border-[hsl(var(--border))] bg-[hsl(var(--background))] hover:border-[hsl(var(--ring))]"
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-foreground truncate max-w-[160px]">
                    {doc.title}
                  </span>
                  <div className="flex items-center gap-0.5 flex-shrink-0">
                    <span className="rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
                      <Eye className="h-3 w-3" />
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteDocument(doc.id);
                      }}
                      className="rounded p-0.5 text-muted-foreground hover:text-red-400 transition-colors"
                      title="Delete"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <DocumentStatus doc={doc} />
                  {doc.status === "completed" && (
                    <span className="text-[10px] text-muted-foreground flex-shrink-0">
                      {doc.chunkCount} chunk{doc.chunkCount !== 1 ? "s" : ""}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer: document stats + infrastructure status */}
      <div className="border-t border-[hsl(var(--border))] px-3 py-2 space-y-1.5">
        {/* Document stats (only in documents view) */}
        {viewMode === "documents" && selectedKb && (
          <p className="text-[10px] text-muted-foreground">
            {documents.length} 篇文档 ·{" "}
            {documents.reduce((sum, d) => sum + d.chunkCount, 0)} 个切片
          </p>
        )}

        {/* Infrastructure status indicators */}
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10px] text-muted-foreground">
          {/* ES status */}
          <span className="inline-flex items-center gap-1">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                stats?.elasticsearchAvailable ? "bg-green-500" : "bg-red-500"
              }`}
            />
            ES{stats?.elasticsearchAvailable != null
              ? stats.elasticsearchAvailable
                ? ""
                : " 离线"
              : ""}
          </span>

          {/* PGVector status */}
          <span className="inline-flex items-center gap-1">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                stats?.pgvectorEnabled ? "bg-green-500" : "bg-red-500"
              }`}
            />
            PGVector{stats?.pgvectorEnabled != null
              ? stats.pgvectorEnabled
                ? ""
                : " 离线"
              : ""}
          </span>

          {/* Neo4j graph stats */}
          {graphStats?.available ? (
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500" />
              Neo4j {graphStats.nodeCount} 节点 / {graphStats.relationCount} 关系
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500" />
              Neo4j 离线
            </span>
          )}

          {/* Chunk stats */}
          {stats?.totalChunks != null && (
            <span>
              {stats.totalChunks} 切片 / {stats.chunksWithEmbedding ?? "?"} 向量
            </span>
          )}
        </div>
      </div>

    </aside>
  );
}
