// 文件列表项 —— 单行展示：图标、文件名、大小、进度、状态、删除按钮
import { FileText, CheckCircle, XCircle, Loader2, Clock, Trash2 } from "lucide-react";

// ── 文件类型图标映射 ──────────────────────────────

const FILE_TYPE_ICONS: Record<string, typeof FileText> = {
  pdf: FileText,
  docx: FileText,
  txt: FileText,
  md: FileText,
  markdown: FileText,
};

function getFileIcon(fileName: string) {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return FILE_TYPE_ICONS[ext] ?? FileText;
}

// ── 格式化文件大小 ────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── 圆形进度环 ────────────────────────────────────

function CircularProgress({
  progress,
  size = 20,
  strokeWidth = 2,
}: {
  progress: number;
  size?: number;
  strokeWidth?: number;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (progress / 100) * circumference;

  return (
    <svg width={size} height={size} className="flex-shrink-0">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        className="text-[hsl(var(--border))]"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        className="text-[hsl(var(--primary))]"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

// ── Props ────────────────────────────────────────

interface FileListItemProps {
  file: File;
  progress?: number;
  status: "pending" | "uploading" | "done" | "error";
  onRemove: () => void;
}

// ── 组件 ──────────────────────────────────────────

export function FileListItem({
  file,
  progress = 0,
  status,
  onRemove,
}: FileListItemProps) {
  const Icon = getFileIcon(file.name);

  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] hover:border-[hsl(var(--ring))] transition-colors group">
      {/* 文件图标 */}
      <div className="flex items-center justify-center w-8 h-8 rounded bg-[hsl(var(--accent))] flex-shrink-0">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>

      {/* 文件信息 */}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-foreground truncate">
          {file.name}
        </p>
        <p className="text-[10px] text-muted-foreground">
          {formatSize(file.size)}
        </p>
      </div>

      {/* 状态指示器 */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {status === "uploading" && <CircularProgress progress={progress} />}
        {status === "done" && (
          <CheckCircle className="h-5 w-5 text-green-500" />
        )}
        {status === "error" && <XCircle className="h-5 w-5 text-red-500" />}
        {status === "pending" && (
          <Clock className="h-4 w-4 text-muted-foreground" />
        )}

        {/* 删除按钮 */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="p-1 rounded text-muted-foreground hover:text-red-400 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all"
          title="移除文件"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
