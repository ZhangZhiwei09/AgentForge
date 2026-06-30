// 文档列表工具栏 —— 搜索输入框 + 上传按钮 + 可选状态筛选
import { Search, Upload, Filter, X } from "lucide-react";

// ── 文档状态筛选选项 ──────────────────────────────

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "全部状态" },
  { value: "pending", label: "等待中" },
  { value: "processing", label: "处理中" },
  { value: "completed", label: "已完成" },
  { value: "failed", label: "失败" },
];

// ── Props ────────────────────────────────────────

interface DocumentToolbarProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onUploadClick: () => void;
  statusFilter?: string;
  onStatusFilterChange?: (status: string) => void;
  uploading?: boolean;
}

// ── 组件 ──────────────────────────────────────────

export function DocumentToolbar({
  searchQuery,
  onSearchChange,
  onUploadClick,
  statusFilter,
  onStatusFilterChange,
  uploading,
}: DocumentToolbarProps) {
  return (
    <div className="flex items-center gap-3 px-6 py-3 border-b border-[hsl(var(--border))]">
      {/* 搜索输入框 */}
      <div className="relative flex-1 max-w-xs">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="搜索文档标题..."
          className="w-full rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] pl-8 pr-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ring))]"
        />
        {searchQuery && (
          <button
            onClick={() => onSearchChange("")}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted-foreground hover:text-foreground"
            title="清除搜索"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* 状态筛选下拉框（可选） */}
      {onStatusFilterChange && statusFilter !== undefined && (
        <div className="relative flex items-center gap-1.5">
          <Filter className="h-3 w-3 text-muted-foreground" />
          <select
            value={statusFilter}
            onChange={(e) => onStatusFilterChange(e.target.value)}
            className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ring))] appearance-none cursor-pointer"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* 弹性空间 */}
      <div className="flex-1" />

      {/* 上传按钮 */}
      <button
        onClick={onUploadClick}
        disabled={uploading}
        className="inline-flex items-center gap-1.5 rounded-md bg-[hsl(var(--primary))] px-3 py-1.5 text-xs font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        <Upload className="h-3.5 w-3.5" />
        上传文档
      </button>
    </div>
  );
}
