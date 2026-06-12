// P1-5 Human-in-the-Loop — Approval overlay card for high-risk tool execution
import { useState, useEffect, useCallback } from "react";
import { useChatStore } from "@/stores/chat";
import { Shield, Clock, Wrench, AlertTriangle } from "lucide-react";

const RISK_COLORS: Record<string, string> = {
  safe: "bg-green-900/50 text-green-400 border-green-700",
  read_only: "bg-blue-900/50 text-blue-400 border-blue-700",
  mutation: "bg-yellow-900/50 text-yellow-400 border-yellow-700",
  destructive: "bg-red-900/50 text-red-400 border-red-700",
};

const RISK_LABELS: Record<string, string> = {
  safe: "安全",
  read_only: "只读",
  mutation: "修改",
  destructive: "破坏性",
};

export function ApprovalCard() {
  const pendingApproval = useChatStore((s) => s.pendingApproval);
  const clearPendingApproval = useChatStore((s) => s.clearPendingApproval);
  const [timeRemaining, setTimeRemaining] = useState<number>(0);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!pendingApproval) {
      setTimeRemaining(0);
      return;
    }

    const deadline = Date.now() + pendingApproval.timeoutMs;
    setTimeRemaining(pendingApproval.timeoutMs);

    const interval = setInterval(() => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        setTimeRemaining(0);
        clearInterval(interval);
      } else {
        setTimeRemaining(remaining);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [pendingApproval]);

  const handleDecision = useCallback(
    async (action: "approve" | "reject") => {
      if (!pendingApproval || submitting) return;
      setSubmitting(true);

      try {
        const token = localStorage.getItem("accessToken");
        const res = await fetch("/api/agent/approve", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            session_id: pendingApproval.sessionId,
            approval_id: pendingApproval.approvalId,
            action,
            rejection_reason:
              action === "reject" ? "用户拒绝了工具执行" : undefined,
          }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ detail: "Unknown error" }));
          throw new Error(err.detail ?? `HTTP ${res.status}`);
        }
      } catch (err) {
        console.error("Approval decision failed:", err);
        setSubmitting(false);
      }
    },
    [pendingApproval, submitting],
  );

  if (!pendingApproval) return null;

  const formatTime = (ms: number) => {
    const s = Math.ceil(ms / 1000);
    const min = Math.floor(s / 60);
    const sec = s % 60;
    return `${min}:${sec.toString().padStart(2, "0")}`;
  };

  const riskKey = pendingApproval.riskLevel || "safe";
  const riskColor = RISK_COLORS[riskKey] || RISK_COLORS.safe;
  const riskLabel = RISK_LABELS[riskKey] || riskKey;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border border-gray-700 bg-gray-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-700 px-5 py-4">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-red-400" />
            <h3 className="text-sm font-semibold text-gray-200">工具执行审批</h3>
          </div>
          <span
            className={`rounded-md border px-2 py-0.5 text-xs font-medium ${riskColor}`}
          >
            {riskLabel}
          </span>
        </div>

        {/* Body */}
        <div className="space-y-4 px-5 py-4">
          {/* Tool name */}
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <Wrench className="h-3.5 w-3.5 text-gray-400" />
              <span className="text-xs font-medium text-gray-400">工具名称</span>
            </div>
            <p className="text-sm font-mono text-gray-200">
              {pendingApproval.toolName}
            </p>
          </div>

          {/* Reason */}
          <div>
            <span className="text-xs font-medium text-gray-400">执行原因</span>
            <p className="mt-1 text-sm text-gray-300">{pendingApproval.reason}</p>
          </div>

          {/* Arguments */}
          <div>
            <span className="text-xs font-medium text-gray-400">参数</span>
            <pre className="mt-1 rounded-md bg-gray-800 px-3 py-2 text-xs font-mono text-gray-300 overflow-x-auto max-h-24">
              {JSON.stringify(pendingApproval.toolArgs, null, 2)}
            </pre>
          </div>

          {/* Timer */}
          <div className="flex items-center gap-2 text-xs">
            <Clock className="h-3.5 w-3.5 text-gray-500" />
            <span
              className={
                timeRemaining < 30000 ? "text-red-400" : "text-gray-400"
              }
            >
              {timeRemaining > 0
                ? `剩余时间: ${formatTime(timeRemaining)}`
                : "已超时"}
            </span>
          </div>

          {timeRemaining === 0 && (
            <div className="flex items-center gap-2 rounded-md bg-red-900/30 p-2 text-xs text-red-400">
              <AlertTriangle className="h-3.5 w-3.5" />
              审批已超时，将自动拒绝
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-3 border-t border-gray-700 px-5 py-4">
          <button
            onClick={() => handleDecision("reject")}
            disabled={submitting || timeRemaining === 0}
            className="flex-1 rounded-lg border border-red-800 px-4 py-2.5 text-sm text-red-400 transition-colors hover:bg-red-900/30 disabled:opacity-40"
          >
            拒绝
          </button>
          <button
            onClick={() => handleDecision("approve")}
            disabled={submitting || timeRemaining === 0}
            className="flex-1 rounded-lg bg-green-600 px-4 py-2.5 text-sm text-white transition-colors hover:bg-green-700 disabled:opacity-40"
          >
            批准
          </button>
        </div>
      </div>
    </div>
  );
}
