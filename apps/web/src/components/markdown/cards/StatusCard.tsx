// ── 状态/进度卡片 ──
// 展示多步骤进度指示器（如物流追踪、工单处理进度等）

import { Check, Clock, AlertCircle, Loader2 } from "lucide-react";
import type { StatusCardData } from "@agentforge/shared-types";

const STATUS_ICONS: Record<string, React.ReactNode> = {
  pending: <Clock className="h-4 w-4 text-amber-500" />,
  in_progress: <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />,
  success: <Check className="h-4 w-4 text-green-500" />,
  error: <AlertCircle className="h-4 w-4 text-red-500" />,
  warning: <AlertCircle className="h-4 w-4 text-amber-500" />,
};

const STEP_COLORS: Record<string, string> = {
  wait: "text-gray-300 border-gray-200",
  active: "text-blue-500 border-blue-400 bg-blue-50",
  done: "text-green-500 border-green-400 bg-green-50",
  error: "text-red-500 border-red-400 bg-red-50",
};

interface Props {
  data: StatusCardData;
}

export function StatusCard({ data }: Props) {
  return (
    <div className="my-2 rounded-xl border border-[hsl(var(--border))] bg-white shadow-sm overflow-hidden">
      {/* 头部：标题 + 状态 */}
      <div className="flex items-center justify-between px-4 py-3 bg-gray-50/50">
        <span className="text-sm font-semibold text-gray-800">
          {data.title}
        </span>
        <span className="flex items-center gap-1.5 text-xs text-gray-500">
          {STATUS_ICONS[data.status]}
          {data.message}
        </span>
      </div>

      {/* 步骤列表 */}
      {data.steps && data.steps.length > 0 && (
        <div className="px-4 py-3 space-y-0">
          {data.steps.map((step, i) => {
            const isLast = i === data.steps!.length - 1;
            const colors = STEP_COLORS[step.status] ?? STEP_COLORS.wait;

            return (
              <div key={i} className="flex items-start gap-3">
                {/* 步骤指示器（圆点 + 连接线） */}
                <div className="flex flex-col items-center">
                  <div
                    className={`flex h-6 w-6 items-center justify-center rounded-full border-2 text-[10px] font-bold ${colors}`}
                  >
                    {step.status === "done" ? (
                      <Check className="h-3 w-3" />
                    ) : step.status === "active" ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : step.status === "error" ? (
                      <AlertCircle className="h-3 w-3" />
                    ) : (
                      i + 1
                    )}
                  </div>
                  {!isLast && (
                    <div
                      className={`h-full min-h-[20px] w-0.5 ${
                        step.status === "done"
                          ? "bg-green-300"
                          : "bg-gray-200"
                      }`}
                    />
                  )}
                </div>
                {/* 步骤文字 */}
                <div className="pb-4">
                  <p
                    className={`text-xs font-medium ${
                      step.status === "wait"
                        ? "text-gray-400"
                        : "text-gray-700"
                    }`}
                  >
                    {step.label}
                  </p>
                  {step.description && (
                    <p className="text-[11px] text-gray-400 mt-0.5">
                      {step.description}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
