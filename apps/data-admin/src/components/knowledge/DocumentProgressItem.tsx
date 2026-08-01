// 单个文档的处理进度行 —— 显示文档名、进度条、阶段指示器
import { FileText } from "lucide-react";
import { StageProgressBar } from "./StageProgressBar";
import type { PhaseItem } from "./StageProgressBar";

// ── Props ────────────────────────────────────────

interface DocumentProgressItemProps {
  documentId: string;
  title: string;
  status: string;
  phases: PhaseItem[];
  totalProgress: number;
}

// ── 组件 ──────────────────────────────────────────

export function DocumentProgressItem({
  documentId: _documentId,
  title,
  status,
  phases,
  totalProgress,
}: DocumentProgressItemProps) {
  const isFailed = status === "failed";
  const isCompleted = status === "completed";
  const isProcessing = !isFailed && !isCompleted && status !== "pending";

  return (
    <div
      className={[
        "rounded-lg border p-4 space-y-3",
        isFailed
          ? "border-red-200 bg-red-50/50"
          : isCompleted
            ? "border-green-200 bg-green-50/30"
            : "border-[hsl(var(--border))] bg-[hsl(var(--background))]",
      ].join(" ")}
    >
      {/* 文档信息行 */}
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-[hsl(var(--accent))] flex-shrink-0">
          <FileText className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate">
            {title}
          </p>
          <StatusLabel status={status} />
        </div>
        {/* 总体进度 */}
        <span className="text-sm font-mono font-semibold text-foreground tabular-nums">
          {totalProgress}%
        </span>
      </div>

      {/* 进度条 */}
      <div className="space-y-1">
        <div className="h-1.5 w-full rounded-full bg-[hsl(var(--muted))] overflow-hidden">
          <div
            className={[
              "h-full rounded-full transition-all duration-500",
              isFailed
                ? "bg-red-400"
                : isCompleted
                  ? "bg-green-500"
                  : "bg-[hsl(var(--cs-primary))]",
            ].join(" ")}
            style={{ width: `${totalProgress}%` }}
          />
        </div>
      </div>

      {/* 阶段指示器（仅处理中显示） */}
      {isProcessing && phases.length > 0 && (
        <div className="pt-1">
          <StageProgressBar phases={phases} />
        </div>
      )}
    </div>
  );
}

// ── 状态标签 ──────────────────────────────────────

function StatusLabel({ status }: { status: string }) {
  const config: Record<string, { label: string; className: string }> = {
    completed: {
      label: "处理完成",
      className: "text-green-600 bg-green-100",
    },
    failed: {
      label: "处理失败",
      className: "text-red-600 bg-red-100",
    },
    pending: {
      label: "等待处理",
      className: "text-gray-500 bg-gray-100",
    },
  };

  const def = config[status] ?? {
    label: "处理中",
    className: "text-amber-600 bg-amber-100",
  };

  return (
    <span
      className={[
        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium",
        def.className,
      ].join(" ")}
    >
      {def.label}
    </span>
  );
}
