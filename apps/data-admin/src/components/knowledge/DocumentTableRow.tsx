// 文档列表单行 —— 显示文档标题、状态、分块数、文件大小、阶段进度、操作按钮
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Eye, Trash2, FileText, File } from "lucide-react";
import type { KnowledgeDocumentDTO } from "@agentforge/shared-types";
import { StatusBadge } from "./StatusBadge";
import { StageProgressBar } from "./StageProgressBar";
import type { PhaseItem } from "./StageProgressBar";

// ── 文件类型图标映射 ──────────────────────────────

function getFileTypeIcon(
  fileType: string | null | undefined,
  filename: string | null | undefined,
) {
  const ext = (filename ?? "")
    .split(".")
    .pop()
    ?.toLowerCase();
  const type = fileType?.toLowerCase() ?? ext ?? "";

  // 所有文档类型统一使用 FileText 图标，仅特殊类型区分
  if (
    type === "pdf" ||
    type === "docx" ||
    type === "doc" ||
    type === "txt" ||
    type === "md" ||
    type === "markdown" ||
    type === "csv" ||
    type === "json" ||
    type === "html" ||
    type === "xml"
  ) {
    return <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />;
  }
  return <File className="h-4 w-4 text-muted-foreground flex-shrink-0" />;
}

// ── 文件大小格式化 ────────────────────────────────

function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || bytes === 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── 相对时间格式化 ────────────────────────────────

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const diffMs = now - date;

  if (Number.isNaN(diffMs)) return "";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  const years = Math.floor(months / 12);
  return `${years} 年前`;
}

// ── 根据文档计算阶段状态（复用 KnowledgePanel 逻辑） ──

function getProcessingPhases(doc: KnowledgeDocumentDTO): PhaseItem[] {
  // API 返回字段多于 KnowledgeDocumentDTO 定义，安全扩展访问
  const fullDoc = doc as KnowledgeDocumentDTO & {
    downloadingCompletedAt?: string | null;
    parsingCompletedAt?: string | null;
    normalizingCompletedAt?: string | null;
    chunkingCompletedAt?: string | null;
    embeddingCompletedAt?: string | null;
    processingDetail?: {
      phase: string;
      progress: number;
      total: number;
      message: string;
    } | null;
  };

  const hasFile = !!fullDoc.originalFilename;
  if (hasFile) {
    return [
      {
        name: "下载",
        status: fullDoc.downloadingCompletedAt
          ? "completed"
          : fullDoc.processingDetail?.phase === "download"
            ? "processing"
            : "pending",
      },
      {
        name: "解析",
        status: fullDoc.parsingCompletedAt
          ? "completed"
          : fullDoc.processingDetail?.phase === "parse"
            ? "processing"
            : "pending",
      },
      {
        name: "清洗",
        status: fullDoc.normalizingCompletedAt
          ? "completed"
          : fullDoc.processingDetail?.phase === "clean"
            ? "processing"
            : "pending",
      },
      {
        name: "分段",
        status: fullDoc.chunkingCompletedAt
          ? "completed"
          : fullDoc.processingDetail?.phase === "chunk"
            ? "processing"
            : "pending",
      },
      {
        name: "向量化",
        status: fullDoc.embeddingCompletedAt
          ? "completed"
          : fullDoc.processingDetail?.phase === "embed"
            ? "processing"
            : "pending",
      },
    ];
  }
  return [
    {
      name: "清洗",
      status: fullDoc.normalizingCompletedAt
        ? "completed"
        : fullDoc.processingDetail?.phase === "clean"
          ? "processing"
          : "pending",
    },
    {
      name: "分段",
      status: fullDoc.chunkingCompletedAt
        ? "completed"
        : fullDoc.processingDetail?.phase === "chunk"
          ? "processing"
          : "pending",
    },
    {
      name: "向量化",
      status: fullDoc.embeddingCompletedAt
        ? "completed"
        : fullDoc.processingDetail?.phase === "embed"
          ? "processing"
          : "pending",
    },
  ];
}

// ── 确认删除对话框（内联组件） ────────────────────

function ConfirmDeleteModal({
  open,
  docTitle,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  docTitle: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[360px] rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-6 shadow-2xl">
        <h3 className="text-sm font-semibold text-foreground mb-2">
          确认删除
        </h3>
        <p className="text-xs text-muted-foreground mb-5">
          确定要删除文档「{docTitle}」吗？此操作不可撤销，所有分块数据将被永久删除。
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-[hsl(var(--border))] px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            className="rounded-md bg-red-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600 transition-colors"
          >
            删除
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Props ──────────────────────────────────────────

interface DocumentTableRowProps {
  document: KnowledgeDocumentDTO;
  kbId: string;
  onDelete: (docId: string) => void;
}

// ── 组件 ──────────────────────────────────────────

export function DocumentTableRow({
  document: doc,
  kbId,
  onDelete,
}: DocumentTableRowProps) {
  const navigate = useNavigate();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const isProcessing = doc.status === "processing";
  const phases = isProcessing ? getProcessingPhases(doc) : null;

  const handleViewDetail = () => {
    navigate(`/admin/cs/knowledge/bases/${kbId}/documents/${doc.id}`);
  };

  const handleDelete = () => {
    onDelete(doc.id);
    setShowDeleteConfirm(false);
  };

  const canViewDetail =
    doc.status === "completed" || doc.status === "failed";

  return (
    <>
      <div
        className={`group flex items-center gap-3 px-4 py-3 border-b border-[hsl(var(--border))] transition-colors ${
          canViewDetail
            ? "cursor-pointer hover:bg-[hsl(var(--accent))]/50"
            : ""
        }`}
        onClick={canViewDetail ? handleViewDetail : undefined}
      >
        {/* 文件类型图标 */}
        <div className="flex-shrink-0">
          {getFileTypeIcon(doc.originalFileType, doc.originalFilename)}
        </div>

        {/* 文档信息 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground truncate">
              {doc.title}
            </span>
            <StatusBadge
              status={doc.status}
              errorMessage={doc.errorMessage}
            />
          </div>

          {/* 阶段进度条（仅处理中显示） */}
          {isProcessing && phases && (
            <div className="mt-1.5">
              <StageProgressBar phases={phases} />
            </div>
          )}

          {/* 元数据行 */}
          <div className="flex items-center gap-3 mt-1">
            {doc.chunkCount > 0 && (
              <span className="text-[10px] text-muted-foreground">
                {doc.chunkCount} 个分块
              </span>
            )}
            {doc.originalFileSize != null && doc.originalFileSize > 0 && (
              <span className="text-[10px] text-muted-foreground">
                {formatFileSize(doc.originalFileSize)}
              </span>
            )}
            {doc.originalFilename && (
              <span className="text-[10px] text-muted-foreground truncate max-w-[160px]">
                {doc.originalFilename}
              </span>
            )}
            <span className="text-[10px] text-muted-foreground">
              {relativeTime(doc.createdAt)}
            </span>
          </div>
        </div>

        {/* 操作按钮（悬停显示） */}
        <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          {canViewDetail && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleViewDetail();
              }}
              className="rounded p-1.5 text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--accent))] transition-colors"
              title="查看详情"
            >
              <Eye className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowDeleteConfirm(true);
            }}
            className="rounded p-1.5 text-muted-foreground hover:text-red-500 hover:bg-red-50 transition-colors"
            title="删除"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 删除确认对话框 */}
      <ConfirmDeleteModal
        open={showDeleteConfirm}
        docTitle={doc.title}
        onConfirm={handleDelete}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </>
  );
}
