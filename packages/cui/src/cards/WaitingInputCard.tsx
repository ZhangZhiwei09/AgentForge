// WaitingInputCard —— HITL（Phase 3b）等待补充信息卡片
//
// 诊断已跑完 前端/后端/综合分析 三个阶段，Leader 判定信息不足 → 诊断在阶段
// 边界暂停，等待用户补充。用户在卡片内填写补充信息并提交（或直接在聊天框
// 回复），同 conversation 再发一条消息即触发同 thread 续跑。
// 与 ClarificationCard（诊断开始前的信息预检）互补：本卡片出现在诊断**进行中**。

import { useState } from "react";
import { PauseCircle, MessageSquareText, Send } from "lucide-react";
import { cn } from "../utils/cn";
import type { WaitingInputRequest } from "@agentforge/shared-types";

interface Props {
  waitingInput: WaitingInputRequest;
  /** 提交补充信息 —— 由上层调用 sendMessage（同 conversation_id 续跑） */
  onSubmit: (text: string) => void;
  className?: string;
}

export function WaitingInputCard({ waitingInput, onSubmit, className }: Props) {
  const { message, missingFields } = waitingInput;
  const [value, setValue] = useState("");
  const [submitted, setSubmitted] = useState(false);

  function handleSubmit() {
    const trimmed = value.trim();
    if (!trimmed || submitted) return;
    setSubmitted(true);
    onSubmit(trimmed);
  }

  return (
    <div
      className={cn(
        "my-2 rounded-xl border border-indigo-200 bg-indigo-50/60 shadow-sm",
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-indigo-200 px-3 py-2.5">
        <PauseCircle className="h-4 w-4 text-indigo-600" />
        <span className="text-xs font-semibold text-indigo-700">
          诊断暂停，需要您补充信息
        </span>
      </div>

      {/* Body */}
      <div className="px-3 py-2.5 space-y-2.5">
        {message && (
          <p className="text-xs leading-relaxed text-slate-600">{message}</p>
        )}

        {/* 缺失字段标签 */}
        {missingFields.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {missingFields.map((field) => (
              <span
                key={field}
                className="inline-flex items-center rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700"
              >
                {field}
              </span>
            ))}
          </div>
        )}

        {/* 补充输入 */}
        {!submitted && (
          <div className="space-y-1.5">
            <textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              rows={2}
              placeholder="请补充以上信息，例如 traceId、失败时间、错误码..."
              className="w-full resize-none rounded-lg border border-indigo-200 bg-white px-2.5 py-2 text-xs leading-relaxed text-slate-700 outline-none placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200 transition-all"
            />
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!value.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-[11px] font-medium text-white transition-all hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Send className="h-3 w-3" />
              提交补充，继续诊断
            </button>
          </div>
        )}
      </div>

      {/* Footer */}
      {!submitted && (
        <div className="border-t border-indigo-200 px-3 py-2">
          <div className="flex items-center gap-1.5 text-[10px] text-indigo-500">
            <MessageSquareText className="h-3 w-3" />
            也可以在下方聊天框中直接回复，效果相同
          </div>
        </div>
      )}
    </div>
  );
}

export default WaitingInputCard;
