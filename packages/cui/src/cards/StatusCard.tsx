// ── 状态追踪卡片 ──
// 展示多步骤进度追踪（如物流、工单处理）

import {
  Circle,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
} from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../utils/cn";
import type { StatusCardData } from "@agentforge/shared-types";

// ── CVA ──

const cardVariants = cva(
  "my-2 rounded-xl border shadow-sm",
  {
    variants: {
      status: {
        pending: "border-slate-200 bg-white",
        in_progress: "border-blue-200 bg-blue-50/50",
        success: "border-green-200 bg-green-50/50",
        error: "border-red-200 bg-red-50/50",
        warning: "border-amber-200 bg-amber-50/50",
      },
    },
    defaultVariants: {
      status: "pending",
    },
  },
);

const statusIconVariants = cva("h-3.5 w-3.5 shrink-0 mt-0.5", {
  variants: {
    stepStatus: {
      wait: "text-slate-300",
      active: "text-blue-500 animate-spin",
      done: "text-green-500",
      error: "text-red-500",
    },
  },
  defaultVariants: {
    stepStatus: "wait",
  },
});

type CardVariantProps = VariantProps<typeof cardVariants>;

// ── Props ──

interface Props extends CardVariantProps {
  data: StatusCardData;
  isStreaming?: boolean;
  className?: string;
}

// ── 骨架 ──

function Skeleton({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-block animate-pulse rounded bg-slate-200", className)}
    >
      &nbsp;
    </span>
  );
}

// ── Status → Header 映射 ──

const STATUS_HEADER_ICONS: Record<string, React.ReactNode> = {
  pending: <Circle className="h-4 w-4 text-slate-400" />,
  in_progress: <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />,
  success: <CheckCircle2 className="h-4 w-4 text-green-500" />,
  error: <XCircle className="h-4 w-4 text-red-500" />,
  warning: <AlertTriangle className="h-4 w-4 text-amber-500" />,
};

const STATUS_LABELS: Record<string, string> = {
  pending: "等待中",
  in_progress: "进行中",
  success: "已完成",
  error: "异常",
  warning: "注意",
};

// ── 组件 ──

export function StatusCard({ data, isStreaming, className }: Props) {
  if (isStreaming && !data.title) {
    return (
      <div className={cn(cardVariants({ status: "pending" }), "p-4", className)}>
        <div className="flex items-center gap-2 mb-3">
          <Skeleton className="w-4 h-4 rounded-full" />
          <Skeleton className="w-32 h-4" />
        </div>
        <Skeleton className="w-full h-3 mb-1.5" />
        <Skeleton className="w-3/4 h-3 mb-1.5" />
        <Skeleton className="w-1/2 h-3" />
      </div>
    );
  }

  const s = data.status;

  return (
    <div
      className={cn(cardVariants({ status: s }), "p-4", className)}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        {STATUS_HEADER_ICONS[s] ?? STATUS_HEADER_ICONS.pending}
        <span className="text-sm font-semibold text-slate-800">
          {data.title}
        </span>
        <span
          className={cn(
            "ml-auto inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium",
            s === "pending" && "bg-slate-100 text-slate-600",
            s === "in_progress" && "bg-blue-100 text-blue-700",
            s === "success" && "bg-green-100 text-green-700",
            s === "error" && "bg-red-100 text-red-700",
            s === "warning" && "bg-amber-100 text-amber-700",
          )}
        >
          {STATUS_LABELS[s] ?? s}
        </span>
      </div>

      {/* Steps */}
      {data.steps && data.steps.length > 0 && (
        <div className="space-y-2 mb-2">
          {data.steps.map((step, i) => (
            <StepRow key={i} step={step} />
          ))}
        </div>
      )}

      {/* Message */}
      {data.message && (
        <p className="text-xs text-slate-500 mt-2">{data.message}</p>
      )}
    </div>
  );
}

function StepRow({
  step,
}: {
  step: {
    label: string;
    status: "wait" | "active" | "done" | "error";
    description?: string;
  };
}) {
  const IconComponent =
    step.status === "active"
      ? Loader2
      : step.status === "done"
        ? CheckCircle2
        : step.status === "error"
          ? XCircle
          : Circle;

  return (
    <div className="flex items-start gap-2">
      <IconComponent className={statusIconVariants({ stepStatus: step.status })} />
      <div className="min-w-0 flex-1">
        <span
          className={cn(
            "text-xs font-medium",
            step.status === "active" && "text-blue-700",
            step.status === "done" && "text-green-700",
            step.status === "error" && "text-red-600",
            step.status === "wait" && "text-slate-400",
          )}
        >
          {step.label}
        </span>
        {step.description && (
          <p className="text-[10px] text-slate-400 mt-0.5">
            {step.description}
          </p>
        )}
      </div>
    </div>
  );
}

export default StatusCard;
