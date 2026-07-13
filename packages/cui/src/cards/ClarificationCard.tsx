// ClarificationCard —— 诊断信息采集提示卡片
//
// 当用户提供的诊断信息不足时，提示用户补充具体现象、traceId、错误码等信息。
// 与 DiagnosisCard（多 Agent 诊断进度）互补：ClarificationCard 出现在诊断开始之前。

import { Info, MessageSquareText } from "lucide-react";
import { cn } from "../utils/cn";
import type { ClarificationRequest } from "@agentforge/shared-types";

interface Props {
  clarification: ClarificationRequest;
  className?: string;
}

export function ClarificationCard({ clarification, className }: Props) {
  const { missingFields, promptMessage, hints } = clarification;

  return (
    <div
      className={cn(
        "my-2 rounded-xl border border-amber-200 bg-amber-50/60 shadow-sm",
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-amber-200 px-3 py-2.5">
        <Info className="h-4 w-4 text-amber-600" />
        <span className="text-xs font-semibold text-amber-700">
          需要更多信息来帮您诊断
        </span>
      </div>

      {/* Body */}
      <div className="px-3 py-2.5 space-y-2.5">
        {/* 缺失字段标签 */}
        {missingFields.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {missingFields.map((field) => (
              <span
                key={field}
                className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700"
              >
                {field}
              </span>
            ))}
          </div>
        )}

        {/* 补充提示 */}
        {hints.length > 0 && (
          <div className="space-y-1">
            {hints.map((hint, i) => (
              <p
                key={i}
                className="text-[10px] leading-relaxed text-amber-600"
              >
                💡 {hint}
              </p>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-amber-200 px-3 py-2">
        <div className="flex items-center gap-1.5 text-[10px] text-amber-500">
          <MessageSquareText className="h-3 w-3" />
          请在聊天框中直接回复以上信息
        </div>
      </div>
    </div>
  );
}

export default ClarificationCard;
