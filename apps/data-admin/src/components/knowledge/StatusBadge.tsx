// 文档状态标签 —— 显示文档处理状态，处理中时带旋转动画
import { Loader2 } from "lucide-react";

// ── 状态映射 ──────────────────────────────────────

const STATUS_CONFIG: Record<
  string,
  { label: string; color: string; dot: string }
> = {
  pending: {
    label: "等待中",
    color: "bg-gray-100 text-gray-500 border-gray-200",
    dot: "bg-gray-400",
  },
  processing: {
    label: "处理中",
    color: "bg-blue-100 text-blue-700 border-blue-200",
    dot: "bg-blue-500",
  },
  completed: {
    label: "已完成",
    color: "bg-green-100 text-green-700 border-green-200",
    dot: "bg-green-500",
  },
  failed: {
    label: "失败",
    color: "bg-red-100 text-red-700 border-red-200",
    dot: "bg-red-500",
  },
};

// ── Props ────────────────────────────────────────

interface StatusBadgeProps {
  status: string;
  errorMessage?: string | null;
}

// ── 组件 ──────────────────────────────────────────

export function StatusBadge({ status, errorMessage }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.pending;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${config.color}`}
      title={status === "failed" && errorMessage ? errorMessage : undefined}
    >
      {/* 状态指示点 / 旋转图标 */}
      {status === "processing" ? (
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
      ) : (
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${config.dot}`} />
      )}
      <span>{config.label}</span>
    </span>
  );
}
