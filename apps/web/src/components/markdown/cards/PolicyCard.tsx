// ── 政策卡片 ──
// 展示退货/退款/保修政策的要点：条件清单、时间线、例外说明

import { Shield, Clock, AlertCircle, Check } from "lucide-react";
import type { PolicyCardData } from "@agentforge/shared-types";

interface Props {
  data: PolicyCardData;
}

export function PolicyCard({ data }: Props) {
  return (
    <div className="my-2 rounded-xl border border-[hsl(var(--border))] bg-white shadow-sm overflow-hidden">
      {/* 头部 */}
      <div className="flex items-center gap-2 px-4 py-3 bg-blue-50/50">
        <Shield className="h-4 w-4 text-blue-600" />
        <span className="text-xs font-medium text-blue-700">
          {data.category}
        </span>
        <span className="text-sm font-semibold text-gray-800 ml-1">
          {data.title}
        </span>
      </div>

      {/* 条件清单 */}
      <div className="px-4 py-3 space-y-2">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
          适用条件
        </p>
        {data.conditions.map((cond, i) => (
          <div key={i} className="flex items-start gap-2 text-xs text-gray-700">
            <Check className="h-3.5 w-3.5 text-green-500 mt-0.5 shrink-0" />
            <span>{cond}</span>
          </div>
        ))}
      </div>

      {/* 时间信息 */}
      {(data.returnWindow || data.refundTimeline) && (
        <div className="px-4 py-2 border-t border-gray-100 bg-gray-50/30 space-y-1.5">
          {data.returnWindow && (
            <div className="flex items-center gap-1.5 text-xs text-gray-600">
              <Clock className="h-3 w-3 text-gray-400" />
              <span>退换货期限：{data.returnWindow}</span>
            </div>
          )}
          {data.refundTimeline && (
            <div className="flex items-center gap-1.5 text-xs text-gray-600">
              <Clock className="h-3 w-3 text-gray-400" />
              <span>退款时效：{data.refundTimeline}</span>
            </div>
          )}
        </div>
      )}

      {/* 例外说明 */}
      {data.exceptions && data.exceptions.length > 0 && (
        <div className="px-4 py-2 border-t border-gray-100 space-y-1">
          <p className="text-xs font-medium text-amber-600 flex items-center gap-1">
            <AlertCircle className="h-3 w-3" />
            注意事项
          </p>
          {data.exceptions.map((exc, i) => (
            <p key={i} className="text-xs text-gray-500 pl-5">
              · {exc}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
