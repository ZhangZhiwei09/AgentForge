// DiagnosisCard —— 聊天气泡内的多 Agent 协同诊断进度卡片
//
// 展示诊断三阶段（前端排查 → 后端排查 → 综合分析）的实时进度，
// 支持快速通道（Phase 2/3 跳过）、升级通道、分歧/转人工等结果展示。

import { Stethoscope, Loader2, CheckCircle2, Circle, ChevronRight } from "lucide-react";
import type { DiagnosisProgress, DiagnosisPhase } from "@agentforge/shared-types";

interface Props {
  diagnosis: DiagnosisProgress;
}

const RESOLUTION_LABELS: Record<string, string> = {
  frontend_only: "快速通道 — 前端独立解决",
  adopt_frontend: "综合诊断完成 — 以前端结论为主",
  adopt_backend: "综合诊断完成 — 以后端结论为主",
  divergent: "前后端结论存在分歧",
  needs_human: "信息不足，建议转人工处理",
};

const RESOLUTION_ICONS: Record<string, string> = {
  frontend_only: "⚡",
  adopt_frontend: "✅",
  adopt_backend: "✅",
  divergent: "⚠️",
  needs_human: "🆘",
};

export function DiagnosisCard({ diagnosis }: Props) {
  const { status, phases, resolution, finalConclusion } = diagnosis;

  return (
    <div className="my-2 rounded-xl border border-blue-200 bg-blue-50/60 shadow-sm">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-blue-200 px-3 py-2.5">
        <Stethoscope className="h-4 w-4 text-blue-600" />
        <span className="text-xs font-semibold text-blue-700">
          多 Agent 协同诊断
        </span>
        {status === "running" && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-600">
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
            诊断中
          </span>
        )}
        {status === "done" && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700">
            <CheckCircle2 className="h-2.5 w-2.5" />
            完成
          </span>
        )}
        {status === "error" && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium text-red-600">
            异常
          </span>
        )}
      </div>

      {/* Phase List */}
      <div className="px-3 py-2.5 space-y-2">
        {phases.map((phase) => (
          <PhaseRow
            key={phase.phase}
            phase={phase}
            isSkipped={
              resolution === "frontend_only" && phase.phase > 1
            }
          />
        ))}
      </div>

      {/* Final Conclusion (when done) */}
      {(status === "done" || status === "error") && (
        <div className="border-t border-blue-200 px-3 py-2.5">
          {status === "done" && resolution && (
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium">
              <span>{RESOLUTION_ICONS[resolution] ?? "📋"}</span>
              <span
                className={
                  resolution === "needs_human"
                    ? "text-amber-700"
                    : resolution === "divergent"
                      ? "text-amber-600"
                      : "text-green-700"
                }
              >
                {RESOLUTION_LABELS[resolution] ?? "诊断完成"}
              </span>
            </div>
          )}
          {finalConclusion && (
            <p className="text-xs leading-relaxed text-slate-600">
              {finalConclusion}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function PhaseRow({
  phase,
  isSkipped,
}: {
  phase: DiagnosisPhase;
  isSkipped: boolean;
}) {
  return (
    <div
      className={`flex items-start gap-2 rounded-lg px-2.5 py-2 transition-colors ${
        phase.status === "running"
          ? "bg-blue-100/70"
          : phase.status === "done"
            ? "bg-green-50/60"
            : "bg-white/60"
      }`}
    >
      {/* Status Icon */}
      <div className="mt-0.5 shrink-0">
        {isSkipped ? (
          <ChevronRight className="h-3.5 w-3.5 text-slate-300" />
        ) : phase.status === "running" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
        ) : phase.status === "done" ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
        ) : (
          <Circle className="h-3.5 w-3.5 text-slate-300" />
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div
          className={`text-[11px] font-medium ${
            phase.status === "running"
              ? "text-blue-700"
              : phase.status === "done"
                ? "text-green-700"
                : "text-slate-400"
          }`}
        >
          Phase {phase.phase}: {phase.label}
          {isSkipped && (
            <span className="ml-1.5 text-[10px] text-slate-400">
              (已跳过 — 快速通道)
            </span>
          )}
          {phase.status === "running" && (
            <span className="ml-1.5 text-[10px] text-blue-500 animate-pulse">
              执行中...
            </span>
          )}
        </div>
        {phase.summary && (
          <p className="mt-0.5 text-[10px] leading-relaxed text-slate-500 line-clamp-3">
            {phase.summary}
          </p>
        )}
      </div>
    </div>
  );
}

export default DiagnosisCard;
