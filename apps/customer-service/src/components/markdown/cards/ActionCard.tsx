// ── 操作卡片 ──
// 展示一组可点击的操作按钮，用户点击后发送预设消息或触发回调
// 支持流式渐进渲染：未到达的按钮显示骨架

import { ChevronRight } from "lucide-react";
import type { ActionCardData } from "@agentforge/shared-types";

const STYLE_CLASSES: Record<string, string> = {
  primary: "bg-[hsl(var(--cs-primary))] text-white hover:opacity-90 shadow-sm",
  secondary:
    "bg-white border border-[hsl(var(--border))] text-gray-700 hover:bg-gray-50",
  danger: "bg-red-50 border border-red-200 text-red-600 hover:bg-red-100",
};

interface Props {
  data: ActionCardData;
  /** 流式构建中：未到达的按钮显示骨架 */
  isStreaming?: boolean;
  /** 当操作按钮被点击时调用，传入 action 和 payload */
  onAction?: (action: string, payload?: Record<string, unknown>) => void;
}

function Skeleton({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-block animate-pulse rounded bg-gray-200 ${className}`}
    >
      &nbsp;
    </span>
  );
}

export function ActionCard({ data, onAction, isStreaming }: Props) {
  const hasTitle = !!data.title;
  const hasActions = data.actions && data.actions.length > 0;

  return (
    <div className="my-2 rounded-xl border border-[hsl(var(--border))] bg-white shadow-sm p-4">
      {hasTitle ? (
        <p className="text-sm font-semibold text-gray-800 mb-1">{data.title}</p>
      ) : isStreaming ? (
        <Skeleton className="w-40 h-4 mb-1" />
      ) : null}
      {data.description ? (
        <p className="text-xs text-gray-500 mb-3">{data.description}</p>
      ) : isStreaming && hasTitle ? (
        <Skeleton className="w-56 h-3 mb-3" />
      ) : null}
      <div className="flex flex-wrap gap-2">
        {hasActions ? (
          data.actions.map((act, i) => {
            const styleClass =
              STYLE_CLASSES[act.style ?? "secondary"] ??
              STYLE_CLASSES.secondary;
            return (
              <button
                key={i}
                onClick={() => onAction?.(act.action, act.payload)}
                className={`inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${styleClass}`}
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
