// ── 操作卡片 ──
// 展示一组可点击的操作按钮，用户点击后发送预设消息或触发回调
// 支持流式渐进渲染：未到达的按钮显示骨架

import { ChevronRight } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../utils/cn";
import type { ActionCardData } from "@agentforge/shared-types";

// ── CVA 按钮变体 ──

const actionButtonVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
  {
    variants: {
      intent: {
        primary: "bg-blue-600 text-white hover:bg-blue-700 shadow-sm",
        secondary:
          "bg-white border border-slate-200 text-slate-700 hover:bg-slate-50",
        danger:
          "bg-red-50 border border-red-200 text-red-600 hover:bg-red-100",
      },
    },
    defaultVariants: {
      intent: "secondary",
    },
  },
);

type ActionButtonProps = VariantProps<typeof actionButtonVariants>;

// ── Props ──

interface Props {
  data: ActionCardData;
  /** 流式构建中：未到达的按钮显示骨架 */
  isStreaming?: boolean;
  /** 当操作按钮被点击时调用，传入 action 和 payload */
  onAction?: (action: string, payload?: Record<string, unknown>) => void;
  /** 覆写根容器 className */
  className?: string;
}

// ── 骨架 ──

function Skeleton({ className = "" }: { className?: string }) {
  return (
    <span
      className={cn("inline-block animate-pulse rounded bg-slate-200", className)}
    >
      &nbsp;
    </span>
  );
}

// ── 组件 ──

export function ActionCard({ data, onAction, isStreaming, className }: Props) {
  const hasTitle = !!data.title;
  const hasActions = data.actions && data.actions.length > 0;

  return (
    <div
      className={cn(
        "my-2 rounded-xl border border-slate-200 bg-white shadow-sm p-4",
        className,
      )}
    >
      {hasTitle ? (
        <p className="text-sm font-semibold text-slate-800 mb-1">
          {data.title}
        </p>
      ) : isStreaming ? (
        <Skeleton className="w-40 h-4 mb-1" />
      ) : null}
      {data.description ? (
        <p className="text-xs text-slate-500 mb-3">{data.description}</p>
      ) : isStreaming && hasTitle ? (
        <Skeleton className="w-56 h-3 mb-3" />
      ) : null}
      <div className="flex flex-wrap gap-2">
        {hasActions ? (
          data.actions.map((act, i) => {
            const intent = (act.style as ActionButtonProps["intent"]) ?? "secondary";
            return (
              <button
                key={i}
                onClick={() => onAction?.(act.action, act.payload)}
                className={actionButtonVariants({ intent })}
              >
                {act.label}
                <ChevronRight className="h-3 w-3" />
              </button>
            );
          })
        ) : isStreaming ? (
          <>
            <Skeleton className="w-24 h-7 rounded-full" />
            <Skeleton className="w-20 h-7 rounded-full" />
            <Skeleton className="w-28 h-7 rounded-full" />
          </>
        ) : null}
      </div>
    </div>
  );
}

export default ActionCard;
