// DiagnosisSection — Inline DiagnosisMode test panel for DebugPanel
//
// Calls POST /api/teams templates/.../instantiate → POST /api/teams/:id/run
// and renders the SSE multi-agent stream inline.

import { useState, useRef } from "react";
import {
  Play,
  Square,
  Stethoscope,
  ChevronRight,
  Loader2,
  CheckCircle2,
  XCircle,
  User,
  Server,
  Gavel,
} from "lucide-react";

// ---- Preset Scenarios ----

const SCENARIOS = [
  {
    label: "快速通道",
    desc: "前端独立解决",
    task: "H5 摄像头打不开怎么办，浏览器提示 NotAllowedError",
    icon: "⚡",
  },
  {
    label: "升级通道",
    desc: "后端错误码→升级",
    task: "traceId abc123 用户活体刷脸失败，WebSocket 在采集阶段断开",
    icon: "🔴",
  },
  {
    label: "信息不足",
    desc: "双方证据弱→转人工",
    task: "用户反馈刷脸失败但不清楚具体错误码和时间",
    icon: "❓",
  },
];

// ---- Types ----

interface TeamSSEEvent {
  type: string;
  agentName?: string;
  role?: string;
  content?: string;
  output?: unknown;
  error?: string;
  mode?: string;
  agents?: Array<{ name: string; role: string }>;
}

interface DiagnosisRun {
  events: TeamSSEEvent[];
  finalOutput: Record<string, unknown> | null;
  phase: number;
  status: "idle" | "creating" | "running" | "done" | "error";
  error: string | null;
}

// ---- Agent Icons ----

const AGENT_ICONS: Record<string, React.ReactNode> = {
  frontend_agent: <User className="h-3 w-3" />,
  backend_agent: <Server className="h-3 w-3" />,
  leader: <Gavel className="h-3 w-3" />,
};

const PHASE_LABELS = ["", "Phase 1: 前端排查", "Phase 2: 后端排查", "Phase 3: 领导评分"];

const RESOLUTION_LABELS: Record<string, string> = {
  frontend_only: "✅ 快速通道 — 前端独立解决",
  adopt_frontend: "✅ 前端结论为主",
  adopt_backend: "✅ 后端结论为主",
  divergent: "⚠️ 双方观点分歧",
  needs_human: "🆘 证据不足，转人工",
};

export function DiagnosisSection() {
  const [run, setRun] = useState<DiagnosisRun>({
    events: [],
    finalOutput: null,
    phase: 0,
    status: "idle",
    error: null,
  });
  const [customTask, setCustomTask] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const isRunning = run.status === "creating" || run.status === "running";

  async function startDiagnosis(task: string) {
    // Reset
    const ac = new AbortController();
    abortRef.current = ac;
    setRun({ events: [], finalOutput: null, phase: 0, status: "creating", error: null });

    const token = localStorage.getItem("accessToken");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    try {
      // Step 1: Create team from template
      const createResp = await fetch("/api/teams/templates/identity-diagnosis/instantiate", {
        method: "POST",
        headers,
        signal: ac.signal,
      });

      if (!createResp.ok) {
        const err = await createResp.text();
        throw new Error(`创建团队失败 (${createResp.status})`);
      }

      const team = await createResp.json();
      const teamId = team.id;

      setRun((r) => ({ ...r, status: "running", phase: 1 }));

      // Step 2: Run diagnosis with SSE
      const runResp = await fetch(`/api/teams/${teamId}/run`, {
        method: "POST",
        headers: { ...headers, Accept: "text/event-stream" },
        body: JSON.stringify({
          task,
          conversationId: "diag-debug-" + Date.now(),
        }),
        signal: ac.signal,
      });

      if (!runResp.ok) {
        const err = await runResp.text();
        throw new Error(`执行诊断失败 (${runResp.status})`);
      }

      // Step 3: Consume SSE stream
      const reader = runResp.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data === "[DONE]") break;
            try {
              const event: TeamSSEEvent = JSON.parse(data);
              setRun((r) => {
                const next = { ...r, events: [...r.events, event] };
                // Track phases
                if (event.type === "agent_started") {
                  if (event.agentName === "backend_agent") next.phase = 2;
                  if (event.agentName === "leader") next.phase = 3;
                }
                if (event.type === "team_completed") {
                  next.finalOutput = (event.output as Record<string, unknown>) || null;
                  next.status = "done";
                  next.phase = 3;
                }
                if (event.type === "team_failed") {
                  next.error = event.error || "Unknown error";
                  next.status = "error";
                }
                return next;
              });
            } catch {
              // non-JSON line
            }
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") return;
      setRun((r) => ({
        ...r,
        status: "error",
        error: err instanceof Error ? err.message : "Unknown error",
      }));
    }
  }

  function cancel() {
    abortRef.current?.abort();
    setRun((r) => ({ ...r, status: "idle" }));
  }

  return (
    <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))]">
      {/* Header */}
      <div className="flex items-center gap-1.5 border-b border-[hsl(var(--border))] px-3 py-2 text-xs font-medium text-muted-foreground">
        <Stethoscope className="h-3.5 w-3.5" />
        DiagnosisMode 测试
      </div>

      <div className="space-y-2 px-3 py-2">
        {/* Preset Buttons */}
        <div className="flex flex-col gap-1">
          {SCENARIOS.map((s) => (
            <button
              key={s.label}
              disabled={isRunning}
              onClick={() => startDiagnosis(s.task)}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-[hsl(var(--muted))] disabled:opacity-40 border border-transparent hover:border-[hsl(var(--border))]"
            >
              <span className="text-sm">{s.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="font-medium">{s.label}</div>
                <div className="text-[10px] text-muted-foreground truncate">{s.desc}</div>
              </div>
              {!isRunning && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
            </button>
          ))}
        </div>

        {/* Custom Input */}
        <div className="flex gap-1">
          <input
            type="text"
            value={customTask}
            onChange={(e) => setCustomTask(e.target.value)}
            disabled={isRunning}
            onKeyDown={(e) => {
              if (e.key === "Enter" && customTask.trim() && !isRunning) {
                startDiagnosis(customTask.trim());
              }
            }}
            placeholder="自定义排查问题..."
            className="flex-1 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 py-1 text-[11px] placeholder:text-muted-foreground disabled:opacity-40"
          />
          {isRunning ? (
            <button
              onClick={cancel}
              className="rounded bg-red-500 p-1.5 text-white hover:bg-red-600"
            >
              <Square className="h-3 w-3" />
            </button>
          ) : (
            <button
              onClick={() => customTask.trim() && startDiagnosis(customTask.trim())}
              disabled={!customTask.trim()}
              className="rounded bg-[hsl(var(--cs-primary))] p-1.5 text-white hover:opacity-85 disabled:opacity-30"
            >
              <Play className="h-3 w-3" />
            </button>
          )}
        </div>

        {/* Progress */}
        {run.status !== "idle" && (
          <div className="space-y-1.5">
            {/* Phase indicator */}
            <div className="flex gap-1">
              {[1, 2, 3].map((p) => (
                <div
                  key={p}
                  className={`flex-1 rounded px-1 py-0.5 text-center text-[9px] font-medium transition-colors ${
                    p < run.phase
                      ? "bg-green-100 text-green-700"
                      : p === run.phase
                        ? "bg-blue-100 text-blue-700"
                        : "bg-gray-100 text-gray-400"
                  }`}
                >
                  {p === run.phase && isRunning ? (
                    <Loader2 className="h-2.5 w-2.5 inline animate-spin mr-0.5" />
                  ) : null}
                  P{p}
                </div>
              ))}
            </div>

            {/* Event log (last 4 events) */}
            <div className="space-y-0.5 max-h-24 overflow-y-auto">
              {run.events.slice(-4).map((ev, i) => (
                <div
                  key={i}
                  className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${
                    ev.type === "agent_error" || ev.type === "team_failed"
                      ? "bg-red-50 text-red-600"
                      : ev.type === "agent_completed" || ev.type === "team_completed"
                        ? "bg-green-50 text-green-700"
                        : "bg-[hsl(var(--muted))]/50 text-muted-foreground"
                  }`}
                >
                  {ev.type === "agent_error" || ev.type === "team_failed" ? (
                    <XCircle className="h-2.5 w-2.5" />
                  ) : ev.type === "agent_completed" ? (
                    <CheckCircle2 className="h-2.5 w-2.5" />
                  ) : (
                    AGENT_ICONS[ev.agentName || ""] ?? null
                  )}
                  <span className="font-mono text-[9px]">{ev.type}</span>
                  <span className="truncate">
                    {ev.agentName || ev.role || ""}
                  </span>
                </div>
              ))}
            </div>

            {/* Status text */}
            {run.status === "creating" && (
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                创建诊断团队...
              </div>
            )}
            {run.status === "running" && (
              <div className="flex items-center gap-1 text-[10px] text-blue-600">
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                {PHASE_LABELS[run.phase]}
              </div>
            )}
            {run.status === "done" && run.finalOutput && (() => {
              const out = run.finalOutput as Record<string, unknown>;
              const resolution = String(out.resolution ?? "");
              return (
              <div className="rounded bg-green-50 px-1.5 py-1 text-[10px] text-green-800">
                <span className="font-medium">
                  {RESOLUTION_LABELS[resolution] || "完成"}
                </span>
                {resolution === "adopt_backend" && out.final_diagnosis && typeof out.final_diagnosis === "object" ? (
                    <p className="mt-0.5 text-[9px] text-green-700 truncate">
                      {String((out.final_diagnosis as Record<string, unknown>).conclusion ?? "").slice(0, 120)}
                    </p>
                  ) : null}
                {resolution === "frontend_only" && out.conclusion ? (
                    <p className="mt-0.5 text-[9px] text-green-700 truncate">
                      {String(out.conclusion).slice(0, 120)}
                    </p>
                  ) : null}
                {resolution === "needs_human" ? (
                  <p className="mt-0.5 text-[9px] text-amber-700">
                    🆘 信息不足，建议转人工
                  </p>
                ) : null}
              </div>
              );
            })()}
            {run.status === "error" && (
              <div className="rounded bg-red-50 px-1.5 py-1 text-[10px] text-red-600 break-all">
                ❌ {run.error}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
