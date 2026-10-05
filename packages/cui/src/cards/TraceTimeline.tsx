// TraceTimeline —— 聊天气泡内的 Agent 过程时间轴
//
// 展示"这一轮 Agent 去查了什么"：检索知识库命中了几篇、调用了哪些工具。
// 与 DiagnosisCard 的区别：诊断是成对事件（_phase / _phase_done），
// 本组件收到的是单事件带可变 status，需按 seq 更新已存在的步骤（running → done/failed）。

import { Loader2, CheckCircle2, AlertCircle, Search, Wrench } from "lucide-react";
import { cn } from "../utils/cn";
import type { TraceStep } from "@agentforge/shared-types";

interface Props {
  steps: TraceStep[];
  /** 覆写根容器 className */
  className?: string;
}

export function TraceTimeline({ steps, className }: Props) {
  if (!steps.length) return null;
  // 后端已是顺序下发，这里再排一次以防乱序/重放
  const ordered = [...steps].sort((a, b) => a.seq - b.seq);

  return (
    <div className={cn("my-2 space-y-0", className)}>
      {ordered.map((step, i) => (
        <TraceRow
          key={step.seq}
          step={step}
          isLast={i === ordered.length - 1}
        />
      ))}
    </div>
  );
}

function TraceRow({ step, isLast }: { step: TraceStep; isLast: boolean }) {
  const Icon = step.kind === "retrieval" ? Search : Wrench;

  return (
    <div className="flex items-stretch gap-2.5">
      {/* 节点 + 竖线 */}
      <div className="flex flex-col items-center pt-0.5">
        <StatusNode status={step.status} />
        {!isLast && <div className="w-px flex-1 bg-slate-200" />}
      </div>

      {/* 内容 */}
      <div className={cn("min-w-0 flex-1", isLast ? "pb-0" : "pb-2.5")}>
        <div className="flex items-center gap-1.5">
          <Icon className="h-3 w-3 shrink-0 text-slate-400" />
          <span
            className={cn(
              "text-[11px] font-medium",
              step.status === "failed" ? "text-red-600" : "text-slate-600",
            )}
          >
            {step.status === "running" ? `${step.label}中…` : step.label}
          </span>
          {step.status === "done" && step.hitCount !== undefined && (
            <span className="text-[10px] text-slate-400">
              命中 {step.hitCount} 篇
            </span>
          )}
          {step.status === "failed" && (
            <span className="text-[10px] text-red-500">失败</span>
          )}
        </div>
        {step.detail && (
          <p className="mt-0.5 truncate text-[10px] text-slate-400" title={step.detail}>
            {step.detail}
          </p>
        )}
      </div>
    </div>
  );
}

function StatusNode({ status }: { status: TraceStep["status"] }) {
  if (status === "running") {
    return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-500" />;
  }
  if (status === "failed") {
    return <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />;
  }
  return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-500" />;
}

export default TraceTimeline;
