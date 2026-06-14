// ── 政策卡片 ──
// 展示退货/退款/保修政策的要点：条件清单、时间线、例外说明
// 支持流式渐进渲染：未到达的字段显示骨架脉冲动画

import { Shield, Clock, AlertCircle, Check } from "lucide-react";
import type { PolicyCardData } from "@agentforge/shared-types";

interface Props {
  data: PolicyCardData;
  /** 流式构建中：未到达的字段显示骨架 */
  isStreaming?: boolean;
}

function Skeleton({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-block animate-pulse rounded bg-gray-200 ${className}`}>
      &nbsp;
    </span>
  );
}

export function PolicyCard({ data, isStreaming }: Props) {
  const hasCategory = !!data.category;
  const hasTitle = !!data.title;
  const hasConditions = data.conditions && data.conditions.length > 0;
  const hasTimeline = !!(data.returnWindow || data.refundTimeline);
  const hasExceptions = data.exceptions && data.exceptions.length > 0;

  return (
    <div className="my-2 rounded-xl border border-[hsl(var(--border))] bg-white shadow-sm overflow-hidden">
      {/* 头部 */}
      <div className="flex items-center gap-2 px-4 py-3 bg-blue-50/50">
        <Shield className="h-4 w-4 text-blue-600" />
        {hasCategory ? (
          <span className="text-xs font-medium text-blue-700">
            {data.category}
          </span>
        ) : (
          <Skeleton className="w-16 h-3" />
        )}
        {hasTitle ? (
          <span className="text-sm font-semibold text-gray-800 ml-1">
            {data.title}
          </span>
        ) : (
          <Skeleton className="w-48 h-4 ml-1" />
        )}
      </div>

      {/* 条件清单 */}
      <div className="px-4 py-3 space-y-2">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
          适用条件
        </p>
        {hasConditions ? (
          data.conditions.map((cond, i) => (
            <div key={i} className="flex items-start gap-2 text-xs text-gray-700">
              <Check className="h-3.5 w-3.5 text-green-500 mt-0.5 shrink-0" />
              <span>{cond}</span>
            </div>
          ))
        ) : (
          <>
            <div className="flex items-start gap-2">
              <Check className="h-3.5 w-3.5 text-gray-300 mt-0.5 shrink-0" />
              <Skeleton className="w-full h-3" />
            </div>
            <div className="flex items-start gap-2">
              <Check className="h-3.5 w-3.5 text-gray-300 mt-0.5 shrink-0" />
              <Skeleton className="w-3/4 h-3" />
            </div>
          </>
        )}
      </div>

      {/* 时间信息 */}
      {(hasTimeline || isStreaming) && (
        <div className="px-4 py-2 border-t border-gray-100 bg-gray-50/30 space-y-1.5">
          {data.returnWindow ? (
            <div className="flex items-center gap-1.5 text-xs text-gray-600">
              <Clock className="h-3 w-3 text-gray-400" />
              <span>退换货期限：{data.returnWindow}</span>
            </div>
          ) : isStreaming ? (
            <div className="flex items-center gap-1.5">
              <Clock className="h-3 w-3 text-gray-300" />
              <Skeleton className="w-40 h-3" />
            </div>
          ) : null}
          {data.refundTimeline ? (
            <div className="flex items-center gap-1.5 text-xs text-gray-600">
              <Clock className="h-3 w-3 text-gray-400" />
              <span>退款时效：{data.refundTimeline}</span>
            </div>
          ) : isStreaming && data.returnWindow ? (
            <div className="flex items-center gap-1.5">
              <Clock className="h-3 w-3 text-gray-300" />
              <Skeleton className="w-52 h-3" />
            </div>
          ) : null}
        </div>
      )}

      {/* 例外说明 */}
      {(hasExceptions || isStreaming) && (
        <div className="px-4 py-2 border-t border-gray-100 space-y-1">
          <p className="text-xs font-medium text-amber-600 flex items-center gap-1">
            <AlertCircle className="h-3 w-3" />
            注意事项
          </p>
          {hasExceptions ? (
            data.exceptions!.map((exc, i) => (
              <p key={i} className="text-xs text-gray-500 pl-5">
                · {exc}
              </p>
            ))
          ) : (
            <p className="text-xs text-gray-400 pl-5 animate-pulse">
              · 等待数据...
            </p>
          )}
        </div>
      )}
    </div>
  );
}
