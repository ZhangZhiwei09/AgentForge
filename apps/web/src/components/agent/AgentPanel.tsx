import { useState, useEffect } from "react";
import type { AgentStep, AgentSessionDTO, AgentApprovalDTO } from "@agentforge/shared-types";
import { client } from "../../lib/api";
import { useAgentStream } from "../../hooks/useAgentStream";

interface AgentPanelProps {
  conversationId: string | null;
}

export function AgentPanel({ conversationId }: AgentPanelProps) {
  const [sessions, setSessions] = useState<AgentSessionDTO[]>([]);
  const [selectedSession, setSelectedSession] = useState<AgentSessionDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [agentTask, setAgentTask] = useState("");
  const [approvals, setApprovals] = useState<AgentApprovalDTO[]>([]);
  const { startAgentTask } = useAgentStream();

  useEffect(() => {
    if (conversationId) {
      loadSessions();
    } else {
      setSessions([]);
      setSelectedSession(null);
    }
  }, [conversationId]);

  const loadSessions = async () => {
    if (!conversationId) return;
    setLoading(true);
    try {
      const data = await client.request<AgentSessionDTO[]>(
        `/api/agent-sessions?conversation_id=${encodeURIComponent(conversationId)}`,
      );
      setSessions(data);
    } catch {
      // Agent sessions table may not exist yet
      setSessions([]);
    } finally {
      setLoading(false);
    }
  };

  const loadSessionDetail = async (id: string) => {
    try {
      const data = await client.request<AgentSessionDTO>(`/api/agent-sessions/${id}`);
      setSelectedSession(data);
      // Also load approval history for this session
      try {
        const approvalData = await client.request<AgentApprovalDTO[]>(
          `/api/agent/approvals?session_id=${encodeURIComponent(id)}`,
        );
        setApprovals(approvalData);
      } catch {
        setApprovals([]);
      }
    } catch {
      // Ignore
    }
  };

  const statusColor = (status: string) => {
    switch (status) {
      case "running":
        return "text-yellow-400";
      case "completed":
        return "text-green-400";
      case "failed":
        return "text-red-400";
      case "paused":
        return "text-blue-400";
      default:
        return "text-gray-400";
    }
  };

  const decisionLabel = (decision: AgentStep["decision"]) => {
    switch (decision.action) {
      case "tool_call":
        return `🔧 ${decision.tool}`;
      case "respond":
        return "💬 Respond";
      case "ask_user":
        return "❓ Ask User";
    }
  };

  return (
    <div className="h-full flex flex-col bg-gray-900 text-gray-200">
      {/* Header */}
      <div className="p-3 border-b border-gray-700 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-300">🧠 Agent Sessions</h3>
          <button
            onClick={loadSessions}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
            disabled={loading}
          >
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
        {/* Task Input */}
        <div className="flex gap-1">
          <input
            value={agentTask}
            onChange={(e) => setAgentTask(e.target.value)}
            placeholder="输入任务描述..."
            className="flex-1 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-200 placeholder:text-gray-500 focus:outline-none focus:border-blue-600"
            onKeyDown={(e) => {
              if (e.key === "Enter" && agentTask.trim()) {
                startAgentTask(agentTask.trim());
                setAgentTask("");
              }
            }}
          />
          <button
            onClick={() => {
              if (agentTask.trim()) {
                startAgentTask(agentTask.trim());
                setAgentTask("");
              }
            }}
            disabled={!agentTask.trim()}
            className="rounded bg-blue-600 px-2.5 py-1 text-xs text-white hover:bg-blue-700 disabled:opacity-40 transition-colors"
          >
            Run
          </button>
        </div>
      </div>

      {/* Session List */}
      {!selectedSession ? (
        <div className="flex-1 overflow-y-auto">
          {sessions.length === 0 ? (
            <div className="p-4 text-center text-xs text-gray-500">
              {conversationId
                ? "No agent sessions yet. Use the agent to start a task."
                : "Select a conversation to view agent sessions."}
            </div>
          ) : (
            sessions.map((session) => (
              <button
                key={session.id}
                onClick={() => loadSessionDetail(session.id)}
                className="w-full text-left p-3 border-b border-gray-800 hover:bg-gray-800/50 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <span className={`text-xs font-medium ${statusColor(session.status)}`}>
                    {session.status.toUpperCase()}
                  </span>
                  <span className="text-xs text-gray-500">
                    {session.scratchpad?.length || 0} steps
                  </span>
                </div>
                <p className="text-xs text-gray-400 mt-1 truncate">{session.task}</p>
                {session.finalSummary && (
                  <p className="text-xs text-gray-500 mt-1 truncate">{session.finalSummary}</p>
                )}
              </button>
            ))
          )}
        </div>
      ) : (
        /* Session Detail — Reasoning Chain */
        <div className="flex-1 overflow-y-auto">
          <button
            onClick={() => setSelectedSession(null)}
            className="p-2 text-xs text-blue-400 hover:text-blue-300 transition-colors flex items-center gap-1"
          >
            ← Back to sessions
          </button>

          {/* Session Info */}
          <div className="p-3 border-b border-gray-700">
            <div className="flex items-center justify-between mb-2">
              <span className={`text-xs font-medium ${statusColor(selectedSession.status)}`}>
                {selectedSession.status.toUpperCase()}
              </span>
              <span className="text-xs text-gray-500">
                {selectedSession.scratchpad?.length || 0} steps
              </span>
            </div>
            <p className="text-xs text-gray-300 mb-1"><strong>Task:</strong> {selectedSession.task}</p>
            {selectedSession.finalSummary && (
              <p className="text-xs text-green-400"><strong>Result:</strong> {selectedSession.finalSummary}</p>
            )}
          </div>

          {/* Reasoning Chain */}
          <div className="p-2">
            <h4 className="text-xs font-semibold text-gray-400 mb-2 px-1">Reasoning Chain</h4>
            {selectedSession.scratchpad?.map((step: AgentStep, i: number) => (
              <div key={i} className="mb-2 border border-gray-700 rounded bg-gray-800/50 overflow-hidden">
                {/* Step Header */}
                <div className="px-2 py-1 bg-gray-800 border-b border-gray-700 flex items-center justify-between">
                  <span className="text-xs font-bold text-gray-400">Step {step.step}</span>
                  <span className="text-xs text-gray-500">{decisionLabel(step.decision)}</span>
                </div>

                {/* Step Details */}
                <div className="p-2 space-y-1.5 text-xs">
                  {step.observation && (
                    <div>
                      <span className="text-blue-400 font-medium">👁 Observation:</span>
                      <p className="text-gray-400 mt-0.5 ml-1">{step.observation}</p>
                    </div>
                  )}
                  {step.analysis && (
                    <div>
                      <span className="text-yellow-400 font-medium">🧠 Analysis:</span>
                      <p className="text-gray-400 mt-0.5 ml-1">{step.analysis}</p>
                    </div>
                  )}
                  {step.plan && (
                    <div>
                      <span className="text-purple-400 font-medium">📋 Plan:</span>
                      <p className="text-gray-400 mt-0.5 ml-1">{step.plan}</p>
                    </div>
                  )}
                  {step.decision.action === "tool_call" && (
                    <div>
                      <span className="text-green-400 font-medium">🔧 Tool Call:</span>
                      <p className="text-gray-400 mt-0.5 ml-1">
                        {step.decision.tool}({JSON.stringify(step.decision.args)})
                      </p>
                      <p className="text-gray-500 ml-1">Reason: {step.decision.reason}</p>
                    </div>
                  )}
                  {step.result && (
                    <div>
                      <span className="text-cyan-400 font-medium">📤 Result:</span>
                      <p className="text-gray-400 mt-0.5 ml-1 truncate">{step.result}</p>
                    </div>
                  )}
                </div>
              </div>
            ))}
            {(!selectedSession.scratchpad || selectedSession.scratchpad.length === 0) && (
              <p className="text-xs text-gray-500 text-center py-4">
                No reasoning steps recorded.
              </p>
            )}

            {/* P1-5 Approval History */}
            {approvals.length > 0 && (
              <div className="mt-4 border-t border-gray-700 pt-2">
                <h4 className="text-xs font-semibold text-gray-400 mb-2 px-1">🛡️ Approval History</h4>
                {approvals.map((approval) => (
                  <div
                    key={approval.id}
                    className="mb-2 border border-gray-700 rounded bg-gray-800/50 p-2"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-gray-300">
                        Step {approval.stepNumber}: {approval.toolName}
                      </span>
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded ${
                          approval.status === "approved"
                            ? "bg-green-900/50 text-green-400"
                            : approval.status === "rejected"
                              ? "bg-red-900/50 text-red-400"
                              : approval.status === "timed_out"
                                ? "bg-gray-700 text-gray-400"
                                : "bg-yellow-900/50 text-yellow-400"
                        }`}
                      >
                        {approval.status}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500">Risk: {approval.riskLevel} | Reason: {approval.reason}</p>
                    {approval.rejectionReason && (
                      <p className="text-xs text-red-400 mt-0.5">Rejection: {approval.rejectionReason}</p>
                    )}
                    {approval.decidedAt && (
                      <p className="text-xs text-gray-600 mt-0.5">
                        Decided: {new Date(approval.decidedAt).toLocaleString()}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
