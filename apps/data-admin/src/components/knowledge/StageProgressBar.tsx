// 阶段进度指示器 —— 显示每个处理阶段的完成状态：下载→解析→清洗→分段→向量化
import { Check, Loader2 } from "lucide-react";

// ── 阶段状态类型 ──────────────────────────────────

export type PhaseStatus = "pending" | "processing" | "completed" | "failed";

export interface PhaseItem {
  name: string;
  status: PhaseStatus;
}

// ── Props ────────────────────────────────────────

interface StageProgressBarProps {
  phases: PhaseItem[];
}

// ── 组件 ──────────────────────────────────────────

export function StageProgressBar({ phases }: StageProgressBarProps) {
  return (
    <div className="flex items-center gap-0">
      {phases.map((phase, index) => (
        <div key={phase.name} className="flex items-center">
          {/* 连接线（第一个阶段前不显示） */}
          {index > 0 && (
            <div
              className={[
                "h-0.5 w-6 flex-shrink-0 transition-colors",
                phase.status === "completed" ||
                phases[index - 1]?.status === "completed"
                  ? "bg-green-400"
                  : "bg-[hsl(var(--border))]",
              ].join(" ")}
            />
          )}

          {/* 圆点 + 标签 */}
          <div className="flex flex-col items-center gap-1">
            <div
              className={[
                "flex items-center justify-center w-5 h-5 rounded-full flex-shrink-0 transition-all",
                phase.status === "completed"
                  ? "bg-green-500 text-white"
                  : phase.status === "processing"
                    ? "bg-amber-400 text-white"
                    : phase.status === "failed"
                      ? "bg-red-500 text-white"
                      : "bg-[hsl(var(--muted))] text-muted-foreground",
              ].join(" ")}
              title={
                phase.status === "completed"
                  ? `${phase.name} ✓`
                  : phase.status === "processing"
                    ? `${phase.name} ...`
                    : phase.status === "failed"
                      ? `${phase.name} ✗`
                      : phase.name
              }
            >
              {phase.status === "completed" ? (
                <Check className="h-3 w-3" />
              ) : phase.status === "processing" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : phase.status === "failed" ? (
                <span className="text-[10px] font-bold">!</span>
              ) : (
                <span className="w-1.5 h-1.5 rounded-full bg-current" />
              )}
            </div>
            <span
              className={[
                "text-[10px] whitespace-nowrap transition-colors",
                phase.status === "completed"
                  ? "text-green-600 font-medium"
                  : phase.status === "processing"
                    ? "text-amber-600 font-medium"
                    : phase.status === "failed"
                      ? "text-red-500"
                      : "text-muted-foreground",
              ].join(" ")}
            >
              {phase.name}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
