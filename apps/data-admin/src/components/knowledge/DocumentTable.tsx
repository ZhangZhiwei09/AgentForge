// 文档列表容器 —— 加载 / 空 / 错误 / 列表四种状态
import { useQuery } from "@tanstack/react-query";
import { FileText, RefreshCw, Loader2, Upload } from "lucide-react";
import type { KnowledgeDocumentDTO } from "@agentforge/shared-types";
import { client } from "@agentforge/ui";
import { DocumentTableRow } from "./DocumentTableRow";

// ── 骨架屏行 ──────────────────────────────────────

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-[hsl(var(--border))] animate-pulse">
      <div className="h-4 w-4 rounded bg-[hsl(var(--muted))]" />
      <div className="flex-1 space-y-2">
        <div className="h-3.5 w-48 rounded bg-[hsl(var(--muted))]" />
        <div className="h-2.5 w-32 rounded bg-[hsl(var(--muted))]" />
      </div>
      <div className="h-3 w-12 rounded bg-[hsl(var(--muted))]" />
    </div>
  );
}

// ── 骨架屏列表 ──────────────────────────────────────

function SkeletonTable() {
  return (
    <div className="divide-y divide-[hsl(var(--border))]">
      {Array.from({ length: 5 }).map((_, i) => (
        <SkeletonRow key={i} />
      ))}
    </div>
  );
}

// ── Props ──────────────────────────────────────────

interface DocumentTableProps {
  kbId: string;
  searchQuery: string;
  statusFilter?: string;
  uploading: boolean;
  onUploadClick: () => void;
}

// ── 组件 ──────────────────────────────────────────

export function DocumentTable({
  kbId,
  searchQuery,
  statusFilter,
  uploading,
  onUploadClick,
}: DocumentTableProps) {
  // 查询文档列表
  const {
    data: documents,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["knowledge", "documents", kbId],
    queryFn: () => client.listDocuments(kbId),
  });

  // 客户端搜索筛选
  const filteredDocs: KnowledgeDocumentDTO[] = (() => {
    if (!documents) return [];
    let result = documents;

    // 按标题搜索
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (d) =>
          d.title.toLowerCase().includes(q) ||
          (d.originalFilename ?? "").toLowerCase().includes(q),
      );
    }

    // 按状态筛选
    if (statusFilter) {
      result = result.filter((d) => d.status === statusFilter);
    }

    return result;
  })();

  // ── 加载状态 ──────────────────────────────────────

  if (isLoading) {
    return (
      <div className="flex-1 overflow-y-auto">
        <SkeletonTable />
      </div>
    );
  }

  // ── 错误状态 ──────────────────────────────────────

  if (isError) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center py-16 px-6">
        <div className="rounded-full bg-red-50 p-3 mb-3">
          <RefreshCw className="h-6 w-6 text-red-400" />
        </div>
        <p className="text-sm font-medium text-foreground mb-1">
          加载失败
        </p>
        <p className="text-xs text-muted-foreground mb-4 max-w-md text-center">
          {error instanceof Error ? error.message : "无法获取文档列表，请检查网络连接后重试"}
        </p>
        <button
          onClick={() => refetch()}
          className="inline-flex items-center gap-1.5 rounded-md bg-[hsl(var(--primary))] px-3 py-1.5 text-xs font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90"
        >
          <RefreshCw className="h-3 w-3" />
          重试
        </button>
      </div>
    );
  }

  // ── 空状态（KB 无文档） ──────────────────────────

  if (!documents || documents.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center py-16 px-6">
        <div className="rounded-full bg-[hsl(var(--muted))]/50 p-3 mb-3">
          <FileText className="h-6 w-6 text-muted-foreground opacity-40" />
        </div>
        <p className="text-sm font-medium text-foreground mb-1">
          暂无文档
        </p>
        <p className="text-xs text-muted-foreground mb-4">
          点击上传第一个文档，开始构建你的知识库
        </p>
        <button
          onClick={onUploadClick}
          disabled={uploading}
          className="inline-flex items-center gap-1.5 rounded-md bg-[hsl(var(--primary))] px-3 py-1.5 text-xs font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:opacity-50"
        >
          <Upload className="h-3.5 w-3.5" />
          上传文档
        </button>
      </div>
    );
  }

  // ── 搜索无结果 ──────────────────────────────────

  if (filteredDocs.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center py-16 px-6">
        <div className="rounded-full bg-[hsl(var(--muted))]/50 p-3 mb-3">
          <FileText className="h-6 w-6 text-muted-foreground opacity-40" />
        </div>
        <p className="text-sm font-medium text-foreground mb-1">
          无匹配文档
        </p>
        <p className="text-xs text-muted-foreground">
          尝试调整搜索条件或清除筛选
        </p>
      </div>
    );
  }

  // ── 文档列表 ─────────────────────────────────────

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="divide-y divide-[hsl(var(--border))]">
        {filteredDocs.map((doc) => (
          <DocumentTableRow
            key={doc.id}
            document={doc}
            kbId={kbId}
            onDelete={async (docId) => {
              try {
                await client.deleteDocument(docId);
                refetch();
              } catch {
                // 删除失败，静默忽略（后续可添加 toast 提示）
                refetch();
              }
            }}
          />
        ))}
      </div>

      {/* 底部统计 */}
      <div className="px-4 py-2 border-t border-[hsl(var(--border))]">
        <p className="text-[10px] text-muted-foreground">
          共 {filteredDocs.length} 篇文档
          {filteredDocs.length !== documents.length &&
            `（共 ${documents.length} 篇，已筛选）`}
          {" · "}
          {documents.reduce((sum, d) => sum + d.chunkCount, 0)} 个分块
        </p>
      </div>
    </div>
  );
}
