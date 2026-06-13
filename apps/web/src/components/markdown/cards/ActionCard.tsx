// ── 操作卡片 ──
// 展示一组可点击的操作按钮，用户点击后发送预设消息或触发回调

import { ChevronRight } from "lucide-react";
import type { ActionCardData } from "@agentforge/shared-types";

const STYLE_CLASSES: Record<string, string> = {
  primary:
    "bg-[hsl(var(--cs-primary))] text-white hover:opacity-90 shadow-sm",
  secondary: "bg-white border border-[hsl(var(--border))] text-gray-700 hover:bg-gray-50",
  danger:
    "bg-red-50 border border-red-200 text-red-600 hover:bg-red-100",
};

interface Props {
  data: ActionCardData;
  /** 当操作按钮被点击时调用，传入 action 和 payload */
  onAction?: (action: string, payload?: Record<string, unknown>) => void;
}

export function ActionCard({ data, onAction }: Props) {
  return (
    <div className="my-2 rounded-xl border border-[hsl(var(--border))] bg-white shadow-sm p-4">
      {data.title && (
        <p className="text-sm font-semibold text-gray-800 mb-1">
          {data.title}
        </p>
      )}
      {data.description && (
        <p className="text-xs text-gray-500 mb-3">{data.description}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {data.actions.map((act, i) => {
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
        })}
      </div>
    </div>
  );
}
