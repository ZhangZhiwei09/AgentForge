// Debug Route: DiagnosisMode Visual Verification Page
//
// Serves a self-contained HTML page for visually verifying the
// DiagnosisMode multi-agent flow in a browser. No frontend build needed.
//
// Access: GET /debug/diagnosis
//
// The page uses fetch + ReadableStream to consume the SSE stream from
// POST /api/teams/:id/run and renders each phase as a color-coded card.

import { createHono } from "../lib/hono.js";

export const debugDiagnosisRoutes = createHono();

debugDiagnosisRoutes.get("/debug/diagnosis", (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DiagnosisMode 调试面板</title>
<style>
  :root {
    --bg: #0f1117;
    --card: #1a1d27;
    --border: #2a2d3a;
    --text: #d4d6dc;
    --muted: #6b7280;
    --green: #10b981;
    --red: #ef4444;
    --amber: #f59e0b;
    --blue: #3b82f6;
    --purple: #8b5cf6;
    --cyan: #06b6d4;
    --radius: 8px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    padding: 24px;
  }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .subtitle { color: var(--muted); font-size: 13px; margin-bottom: 24px; }

  /* Controls */
  .controls {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    margin-bottom: 24px;
    padding: 20px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .controls.full { grid-template-columns: 1fr; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .field input, .field select, .field textarea {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    padding: 10px 12px;
    font-size: 14px;
    font-family: inherit;
  }
  .field textarea { resize: vertical; min-height: 60px; }
  .field input:focus, .field select:focus, .field textarea:focus {
    outline: none;
    border-color: var(--blue);
  }

  /* Buttons */
  .btn-row { display: flex; gap: 8px; align-items: end; }
  .btn {
    padding: 10px 20px;
    border: none;
    border-radius: 6px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.15s;
  }
  .btn:hover { opacity: 0.85; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-primary { background: var(--blue); color: #fff; }
  .btn-danger { background: var(--red); color: #fff; }
  .btn-ghost { background: var(--border); color: var(--text); }

  /* Scenarios */
  .scenarios { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
  .scenario {
    padding: 6px 14px;
    border: 1px solid var(--border);
    border-radius: 20px;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
    color: var(--muted);
  }
  .scenario:hover { border-color: var(--purple); color: var(--text); }
  .scenario.active { background: var(--purple); border-color: var(--purple); color: #fff; }

  /* Status Bar */
  .status-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 20px;
    font-size: 13px;
  }
  .status-dot {
    width: 10px; height: 10px; border-radius: 50%;
    background: var(--muted);
    transition: background 0.3s;
  }
  .status-dot.running { background: var(--amber); animation: pulse 1s infinite; }
  .status-dot.done { background: var(--green); }
  .status-dot.error { background: var(--red); }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

  /* Phase Indicator */
  .phases {
    display: flex;
    gap: 4px;
    margin-bottom: 20px;
  }
  .phase-pill {
    flex: 1;
    text-align: center;
    padding: 8px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    background: var(--card);
    border: 1px solid var(--border);
    color: var(--muted);
    transition: all 0.3s;
  }
  .phase-pill.active { border-color: var(--blue); color: var(--blue); background: rgba(59,130,246,0.1); }
  .phase-pill.completed { border-color: var(--green); color: var(--green); background: rgba(16,185,129,0.1); }

  /* Event Log */
  .events { display: flex; flex-direction: column; gap: 8px; }
  .event-card {
    padding: 14px 16px;
    border-radius: var(--radius);
    border-left: 3px solid var(--border);
    background: var(--card);
    font-size: 13px;
    animation: slideIn 0.2s ease-out;
  }
  @keyframes slideIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }

  .event-card.team_started { border-left-color: var(--purple); }
  .event-card.agent_started { border-left-color: var(--blue); }
  .event-card.agent_think { border-left-color: var(--cyan); font-style: italic; }
  .event-card.agent_plan, .event-card.agent_act, .event-card.agent_observe { border-left-color: var(--cyan); }
  .event-card.agent_completed { border-left-color: var(--green); }
  .event-card.agent_error { border-left-color: var(--red); background: rgba(239,68,68,0.08); }
  .event-card.team_completed { border-left-color: var(--green); background: rgba(16,185,129,0.08); }
  .event-card.team_failed { border-left-color: var(--red); background: rgba(239,68,68,0.08); }

  .event-header { display: flex; justify-content: space-between; align-items: start; margin-bottom: 6px; }
  .event-type { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .event-agent { font-weight: 600; }
  .event-body { color: var(--muted); font-size: 12px; max-height: 120px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; }

  /* Final Output */
  .final-output {
    margin-top: 20px;
    padding: 20px;
    background: var(--card);
    border: 2px solid var(--green);
    border-radius: var(--radius);
    display: none;
  }
  .final-output.visible { display: block; }
  .final-output h3 { color: var(--green); margin-bottom: 12px; }
  .final-output pre {
    background: var(--bg);
    border-radius: 6px;
    padding: 14px;
    font-size: 12px;
    overflow-x: auto;
    max-height: 500px;
    overflow-y: auto;
  }
</style>
</head>
<body>

<h1>🔍 DiagnosisMode 调试面板</h1>
<p class="subtitle">前端先行排查 → 后端按需介入 → 领导评分汇总。SSE 实时流式渲染。</p>

<!-- Scenario Presets -->
<div class="scenarios" id="scenarios">
  <div class="scenario active" data-scenario="fast">⚡ 快速通道：前端独立解决（摄像头权限）</div>
  <div class="scenario" data-scenario="escalate">🔴 升级通道：发现后端错误码</div>
  <div class="scenario" data-scenario="unclear">❓ 模糊问题：双方证据都不足</div>
  <div class="scenario" data-scenario="custom">✏️ 自定义问题</div>
</div>

<!-- Controls -->
<div class="controls" id="controls">
  <div class="field">
    <label>Server Base URL</label>
    <input id="baseUrl" value="http://localhost:8000" placeholder="http://localhost:8000">
  </div>
  <div class="field" id="tokenField">
    <label>Auth Token (从浏览器登录后复制)</label>
    <input id="authToken" placeholder="Bearer eyJ..." autocomplete="off">
  </div>
  <div class="field full" id="taskField">
    <label>排查问题</label>
    <textarea id="task" placeholder="描述用户遇到的问题...">H5 摄像头打不开怎么办，浏览器提示 NotAllowedError</textarea>
  </div>
  <div class="btn-row full">
    <button class="btn btn-primary" id="btnRun" onclick="runDiagnosis()">▶ 开始诊断</button>
    <button class="btn btn-danger" id="btnCancel" onclick="cancelDiagnosis()" disabled>⏹ 取消</button>
    <button class="btn btn-ghost" onclick="clearEvents()">🗑 清空</button>
  </div>
</div>

<!-- Status -->
<div class="status-bar">
  <div class="status-dot" id="statusDot"></div>
  <span id="statusText" style="flex:1">就绪 — 选择一个场景并点击"开始诊断"</span>
  <span id="statusTimer" style="color:var(--muted)"></span>
</div>

<!-- Phase Indicators -->
<div class="phases" id="phaseIndicators">
  <div class="phase-pill" data-phase="1">Phase 1: 前端 Agent 排查</div>
  <div class="phase-pill" data-phase="2">Phase 2: 后端 Agent 排查</div>
  <div class="phase-pill" data-phase="3">Phase 3: 领导评分汇总</div>
</div>

<!-- Event Stream -->
<div class="events" id="events"></div>

<!-- Final Output -->
<div class="final-output" id="finalOutput">
  <h3>📋 最终诊断结果</h3>
  <pre id="finalContent"></pre>
</div>

<script>
const SCENARIOS = {
  fast: "H5 摄像头打不开怎么办，浏览器提示 NotAllowedError",
  escalate: "traceId abc123 用户活体刷脸失败，WebSocket 在采集阶段断开",
  unclear: "用户反馈刷脸失败但不清楚具体错误码和时间",
  custom: "",
};

let currentPhase = 0;
let startTime = 0;
let timerInterval = null;
let abortController = null;
let teamId = null;

// Scenario switching
document.getElementById("scenarios").addEventListener("click", (e) => {
  const el = e.target.closest(".scenario");
  if (!el) return;
  document.querySelectorAll(".scenario").forEach(s => s.classList.remove("active"));
  el.classList.add("active");
  const key = el.dataset.scenario;
  if (key !== "custom") {
    document.getElementById("task").value = SCENARIOS[key];
  }
});

// Preset detection: if task matches a scenario, highlight it
document.getElementById("task").addEventListener("input", () => {
  const val = document.getElementById("task").value;
  const match = Object.entries(SCENARIOS).find(([, v]) => v === val);
  document.querySelectorAll(".scenario").forEach(s => s.classList.remove("active"));
  if (match) {
    document.querySelector(\`[data-scenario="\${match[0]}"]\`)?.classList.add("active");
  } else {
    document.querySelector('[data-scenario="custom"]')?.classList.add("active");
  }
});

function setStatus(state, text) {
  const dot = document.getElementById("statusDot");
  dot.className = "status-dot " + state;
  document.getElementById("statusText").textContent = text;
}

function updatePhase(phaseNum) {
  if (phaseNum === currentPhase) return;
  currentPhase = phaseNum;
  document.querySelectorAll(".phase-pill").forEach(p => {
    const pn = parseInt(p.dataset.phase);
    p.classList.remove("active", "completed");
    if (pn < phaseNum) p.classList.add("completed");
    if (pn === phaseNum) p.classList.add("active");
  });
}

function startTimer() {
  startTime = Date.now();
  document.getElementById("statusTimer").textContent = "0.0s";
  timerInterval = setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    document.getElementById("statusTimer").textContent = elapsed + "s";
  }, 200);
}

function stopTimer() {
  clearInterval(timerInterval);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  document.getElementById("statusTimer").textContent = elapsed + "s (完成)";
}

function addEventCard(event) {
  const container = document.getElementById("events");
  const card = document.createElement("div");
  card.className = "event-card " + event.type;

  let body = "";
  if (event.type === "team_started") {
    body = \`模式: \${event.mode || "?"} | Agent: \${(event.agents || []).map(a => a.name).join(", ")}\`;
  } else if (event.type === "agent_started") {
    body = \`\${event.role || ""} (\${event.agentName})\`;
    if (event.task) body += \`\\n任务: \${event.task.slice(0, 200)}\`;
  } else if (event.type === "agent_think" || event.type === "agent_plan" || event.type === "agent_act" || event.type === "agent_observe") {
    body = event.content || event.plan || event.action || event.observation || JSON.stringify(event).slice(0, 200);
  } else if (event.type === "agent_completed") {
    body = typeof event.output === "string" ? event.output.slice(0, 300) : JSON.stringify(event.output).slice(0, 300);
  } else if (event.type === "agent_error") {
    body = \`❌ \${event.error}\`;
  } else if (event.type === "team_completed") {
    const output = event.output || {};
    body = \`Resolution: \${output.resolution || "?"}\\nEscalated: \${output.escalated}\`;
    if (output.resolution === "frontend_only") body += \`\\n✅ 快速通道：前端独立解决\`;
    if (output.resolution === "adopt_backend") body += \`\\n🔴 升级 + 后端结论为主\`;
    if (output.resolution === "divergent") body += \`\\n⚠️ 双方观点分歧\`;
    if (output.resolution === "needs_human") body += \`\\n🆘 转人工\`;
  } else {
    body = JSON.stringify(event).slice(0, 300);
  }

  card.innerHTML = \`
    <div class="event-header">
      <span class="event-agent">\${event.agentName || ""}</span>
      <span class="event-type">\${event.type}</span>
    </div>
    <div class="event-body">\${escapeHtml(body)}</div>
  \`;
  container.appendChild(card);
  card.scrollIntoView({ behavior: "smooth", block: "end" });
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clearEvents() {
  document.getElementById("events").innerHTML = "";
  document.getElementById("finalOutput").classList.remove("visible");
  document.getElementById("finalContent").textContent = "";
  document.querySelectorAll(".phase-pill").forEach(p => p.classList.remove("active", "completed"));
  currentPhase = 0;
}

async function runDiagnosis() {
  clearEvents();
  const baseUrl = document.getElementById("baseUrl").value.replace(/\\/$/, "");
  const token = document.getElementById("authToken").value.trim();
  const task = document.getElementById("task").value.trim();

  if (!task) { alert("请输入排查问题"); return; }

  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = token.startsWith("Bearer ") ? token : \`Bearer \${token}\`;
  const fetchOpts = (body) => ({ method: "POST", headers, body: JSON.stringify(body) });

  setStatus("running", "正在从模板创建诊断团队...");
  document.getElementById("btnRun").disabled = true;
  document.getElementById("btnCancel").disabled = false;
  startTimer();

  try {
    // Step 1: Instantiate diagnosis team from template
    const createResp = await fetch(\`\${baseUrl}/api/teams/templates/identity-diagnosis/instantiate\`, fetchOpts({}));

    if (!createResp.ok) {
      const err = await createResp.text();
      throw new Error(\`创建团队失败 (\${createResp.status}): \${err}\`);
    }

    const team = await createResp.json();
    teamId = team.id;
    setStatus("running", \`团队已创建 (id=\${teamId.slice(0, 8)}...)，开始诊断...\`);

    // Step 2: Run diagnosis with SSE stream
    abortController = new AbortController();
    const runResp = await fetch(\`\${baseUrl}/api/teams/\${teamId}/run\`, {
      method: "POST",
      headers: { ...headers, Accept: "text/event-stream" },
      body: JSON.stringify({ task, conversationId: "debug-" + Date.now() }),
      signal: abortController.signal,
    });

    if (!runResp.ok) {
      const err = await runResp.text();
      throw new Error(\`执行诊断失败 (\${runResp.status}): \${err}\`);
    }

    setStatus("running", "诊断执行中...");
    updatePhase(1);

    // Step 3: Consume SSE stream
    const reader = runResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\\n");
      buffer = lines.pop() || ""; // keep incomplete line

      let currentEventType = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEventType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (data === "[DONE]") break;

          try {
            const event = JSON.parse(data);

            // Track phases
            if (event.type === "agent_started") {
              if (event.agentName === "backend_agent") updatePhase(2);
              if (event.agentName === "leader") updatePhase(3);
            }

            addEventCard(event);

            // Show final output
            if (event.type === "team_completed") {
              updatePhase(3);
              document.getElementById("finalOutput").classList.add("visible");
              document.getElementById("finalContent").textContent = JSON.stringify(event.output, null, 2);
              setStatus("done", getResolutionLabel(event.output?.resolution));
              stopTimer();
            }

            if (event.type === "team_failed") {
              document.getElementById("finalOutput").classList.add("visible");
              document.getElementById("finalContent").textContent = \`❌ \${event.error}\`;
              setStatus("error", \`失败: \${event.error}\`);
              stopTimer();
            }
          } catch {
            // non-JSON data line — ignore
          }
        }
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      setStatus("error", "已取消");
      stopTimer();
    } else {
      setStatus("error", \`错误: \${err.message}\`);
      stopTimer();
      document.getElementById("finalOutput").classList.add("visible");
      document.getElementById("finalContent").textContent = \`❌ \${err.message}\`;
    }
  } finally {
    document.getElementById("btnRun").disabled = false;
    document.getElementById("btnCancel").disabled = true;
    abortController = null;
  }
}

function cancelDiagnosis() {
  if (abortController) {
    abortController.abort();
  }
}

function getResolutionLabel(resolution) {
  if (!resolution) return "诊断完成";
  const labels = {
    "frontend_only": "✅ 快速通道：前端独立解决，未升级",
    "adopt_frontend": "✅ 前端结论为主",
    "adopt_backend": "✅ 后端结论为主（升级后确定根因）",
    "divergent": "⚠️ 双方观点分歧，需人工判断",
    "needs_human": "🆘 证据不足，已转人工",
  };
  return labels[resolution] || \`完成: \${resolution}\`;
}
</script>
</body>
</html>`);
});
