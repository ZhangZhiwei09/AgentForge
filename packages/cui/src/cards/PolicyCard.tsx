// ── 政策卡片 ──
// 展示退换货政策、售后条款等

import { Shield, Check, AlertTriangle, Clock } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../utils/cn";
import type { PolicyCardData } from "@agentforge/shared-types";

// ── CVA ──

const cardVariants = cva(
  "my-2 rounded-xl border border-amber-200 bg-amber-50/60 shadow-sm",
  {
    variants: {
      intent: {
        default: "p-4",
        compact: "p-3",
      },
    },
    defaultVariants: {
      intent: "default",
    },
  },
);

type CardVariantProps = VariantProps<typeof cardVariants>;

// ── Props ──

interface Props extends CardVariantProps {
  data: PolicyCardData;
  isStreaming?: boolean;
  className?: string;
}

// ── 骨架 ──

function Skeleton({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-block animate-pulse rounded bg-amber-100/80", className)}
    >
      &nbsp;
    </span>
  );
}

// ── 组件 ──

export function PolicyCard({ data, intent, isStreaming, className }: Props) {
  if (isStreaming && !data.title) {
    return (
      <div className={cn(cardVariants({ intent }), className)}>
        <div className="flex items-center gap-2 mb-2">
          <Skeleton className="w-4 h-4 rounded" />
          <Skeleton className="w-20 h-3 rounded-full" />
        </div>
        <Skeleton className="w-40 h-4 mb-2" />
        <Skeleton className="w-full h-3 mb-1" />
        <Skeleton className="w-3/4 h-3 mb-1" />
        <Skeleton className="w-1/2 h-3" />
      </div>
    );
  }

  return (
    <div className={cn(cardVariants({ intent }), className)}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <Shield className="h-4 w-4 text-amber-600" />
        <span className="inline-flex items-center rounded-full bg-amber-200/80 px-2 py-0.5 text-[10px] font-medium text-amber-700">
          {data.category}
        </span>
      </div>

      <p className="text-sm font-semibold text-slate-800 mb-3">{data.title}</p>

      {/* Conditions */}
      {data.conditions.length > 0 && (
        <ul className="space-y-1.5 mb-3">
          {data.conditions.map((cond, i) => (
            <li key={i} className="flex items-start gap-1.5 text-xs text-slate-600">
              <Check className="h-3.5 w-3.5 text-green-500 mt-0.5 shrink-0" />
              <span>{cond}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Timelines */}
      <div className="space-y-1 border-t border-amber-200/60 pt-2">
        {data.returnWindow && (
          <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <Clock className="h-3 w-3" />
            <span>退货期限：{data.returnWindow}</span>
          </div>
        )}
        {data.refundTimeline && (
          <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <Clock className="h-3 w-3" />
            <span>退款时效：{data.refundTimeline}</span>
          </div>
        )}
      </div>

      {/* Exceptions */}
      {data.exceptions && data.exceptions.length > 0 && (
        <div className="border-t border-amber-200/60 pt-2 mt-2">
          <p className="text-[10px] font-medium text-amber-700 mb-1">注意事项</p>
          <ul className="space-y-0.5">
            {data.exceptions.map((ex, i) => (
              <li key={i} className="flex items-start gap-1 text-[10px] text-slate-500">
                <AlertTriangle className="h-3 w-3 text-amber-500 mt-0.5 shrink-0" />
                <span>{ex}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default PolicyCard;
