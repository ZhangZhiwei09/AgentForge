// 文档详情页面 —— 文档元数据 + 分块列表
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, FileText, Clock, Layers } from "lucide-react";
import { client } from "@agentforge/ui";
import type { KnowledgeDocumentDTO } from "@agentforge/shared-types";
import { StatusBadge } from "./StatusBadge";
import { SegmentList } from "./SegmentList";
import type { SegmentData } from "./SegmentCard";

// ── 文件大小格式化 ──────────────────────────────────

function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || bytes === 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── 日期格式化 ─────────────────────────────────────

function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dateStr;
  }
}

// ── 组件 ──────────────────────────────────────────

export function DocumentDetailPage() {
  const { kbId, docId } = useParams<{ kbId: string; docId: string }>();
  const navigate = useNavigate();

  if (!kbId || !docId) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">参数错误：缺少 kbId 或 docId</p>
      </div>
    );
  }

  return (
    <DocumentDetailView kbId={kbId} docId={docId} navigate={navigate} />
  );
}

// ── 内部视图组件（确保 kbId/docId 非空后渲染） ────

function DocumentDetailView({
  kbId,
  docId,
  navigate,
}: {
  kbId: string;
  docId: string;
  navigate: ReturnType<typeof useNavigate>;
}) {
  // 查询文档详情
  const {
    data: doc,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["knowledge", "document", docId],
    queryFn: () => client.getDocument(docId),
  });

  // ── 加载状态 ──────────────────────────────────────

  if (isLoading) {
    return (
      <div className="flex-1 flex flex-col">
        {/* 骨架屏头部 */}
        <div className="px-6 py-4 border-b border-[hsl(var(--border))] animate-pulse">
          <div className="flex items-center gap-3">
            <div className="h-4 w-16 rounded bg-[hsl(var(--muted))]" />
            <div className="h-5 w-48 rounded bg-[hsl(var(--muted))]" />
          </div>
          <div className="flex items-center gap-3 mt-2 ml-7">
            <div className="h-3 w-24 rounded bg-[hsl(var(--muted))]" />
            <div className="h-3 w-16 rounded bg-[hsl(var(--muted))]" />
            <div className="h-3 w-32 rounded bg-[hsl(var(--muted))]" />
          </div>
        </div>
        {/* 骨架屏内容 */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="rounded-lg border border-[hsl(var(--border))] p-3.5 animate-pulse"
              >
                <div className="h-4 w-24 rounded bg-[hsl(var(--muted))] mb-2" />
                <div className="h-3 w-full rounded bg-[hsl(var(--muted))] mb-1" />
                <div className="h-3 w-3/4 rounded bg-[hsl(var(--muted))]" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── 错误状态 ──────────────────────────────────────

  if (isError || !doc) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center py-16 px-6">
        <div className="rounded-full bg-red-50 p-3 mb-3">
          <FileText className="h-6 w-6 text-red-400" />
        </div>
        <p className="text-sm font-medium text-foreground mb-1">
          加载失败
        </p>
        <p className="text-xs text-muted-foreground mb-4">
          {error instanceof Error ? error.message : "无法获取文档详情"}
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => navigate(`/admin/cs/knowledge/bases/${kbId}`)}
            className="rounded-md border border-[hsl(var(--border))] px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            返回列表
          </button>
          <button
            onClick={() => refetch()}
            className="rounded-md bg-[hsl(var(--primary))] px-3 py-1.5 text-xs font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90"
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  // ── 构建分块数据（当前 API 不返回分块列表，使用占位数据） ──

  // KnowledgeDocumentDTO 可能包含额外字段，安全扩展访问
  const fullDoc = doc as KnowledgeDocumentDTO & {
    originalFilename?: string | null;
    originalFileSize?: number | null;
    errorMessage?: string | null;
    content?: string;
  };

  // 从文档内容构造简单分块展示（未来 API 提供分块列表后替换）
  const chunks: SegmentData[] = (() => {
    const docContent: string | undefined = fullDoc.content;
    if (!docContent || docContent.trim().length === 0) {
      return [];
    }
    // 简单按段落拆分作为展示
    const paragraphs = docContent
      .split(/\n\s*\n/)
      .filter((p) => p.trim().length > 0);
    return paragraphs.slice(0, 10).map((content, i) => ({
      id: `${docId}-chunk-${i}`,
      content: content.trim(),
      chunkIndex: i,
      tokenCount: Math.ceil(content.length / 2), // 粗略估算
    }));
  })();

  return (
    <div className="flex flex-col flex-1 h-full bg-[hsl(var(--background))]">
      {/* 顶部：返回 + 标题 + 元数据 */}
      <div className="px-6 py-4 border-b border-[hsl(var(--border))]">
        {/* 返回按钮 */}
        <button
          onClick={() => navigate(`/admin/cs/knowledge/bases/${kbId}`)}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-3"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          返回文档列表
        </button>

        {/* 标题 */}
        <h1 className="text-base font-semibold text-foreground mb-2">
          {doc.title}
        </h1>

        {/* 元数据行 */}
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
          {/* 状态 */}
          <StatusBadge
            status={doc.status}
            errorMessage={fullDoc.errorMessage}
          />

          {/* 分块数 */}
          {doc.chunkCount > 0 && (
            <span className="inline-flex items-center gap-1">
              <Layers className="h-3 w-3" />
              {doc.chunkCount} 个分块
            </span>
          )}

          {/* 文件大小 */}
          {fullDoc.originalFileSize != null &&
            fullDoc.originalFileSize > 0 && (
              <span className="inline-flex items-center gap-1">
                <FileText className="h-3 w-3" />
                {formatFileSize(fullDoc.originalFileSize)}
              </span>
            )}

          {/* 原始文件名 */}
          {fullDoc.originalFilename && (
            <span className="truncate max-w-[200px]">
              {fullDoc.originalFilename}
            </span>
          )}

          {/* 创建时间 */}
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatDate(doc.createdAt)}
          </span>
        </div>
      </div>

      {/* 内容区：分块列表 */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <SegmentList chunks={chunks} loading={false} />
      </div>
    </div>
  );
}
