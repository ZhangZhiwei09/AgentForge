import { useState, useEffect } from "react";
import type { AgentStep, AgentSessionDTO } from "@agentforge/shared-types";
import { client } from "../../lib/api";

interface AgentPanelProps {
  conversationId: string | null;
}

export function AgentPanel({ conversationId }: AgentPanelProps) {
  const [sessions, setSessions] = useState<AgentSessionDTO[]>([]);
  const [selectedSession, setSelectedSession] = useState<AgentSessionDTO | null>(null);
  const [loading, setLoading] = useState(false);

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
      <div className="p-3 border-b border-gray-700 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-300">🧠 Agent Sessions</h3>
        <button
          onClick={loadSessions}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          disabled={loading}
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
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
          </div>
        </div>
      )}
    </div>
  );
}
