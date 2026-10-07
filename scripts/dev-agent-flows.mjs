// Launch a flow workbench without disturbing already-running development servers.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverRequire = createRequire(resolve(root, "apps/server/package.json"));
const adminRequire = createRequire(resolve(root, "apps/data-admin/package.json"));
const { parse } = serverRequire("dotenv");
let configured = {};
try {
  configured = parse(readFileSync(resolve(root, "apps/server/.env")));
} catch {
  // Normal defaults remain available when a local .env has not been created.
}
const shared = { ...configured, ...process.env };
const database = shared.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5434/agentforge";
const jwt = shared.JWT_SECRET || "agentforge-dev-secret-change-in-production";

async function availablePort(start) {
  for (let port = start; port < start + 100; port++) {
    const free = await new Promise((done) => {
      const probe = createServer();
      probe.once("error", () => done(false));
      probe.listen(port, () => probe.close(() => done(true)));
    });
    if (free) return port;
  }
  throw new Error("No available development port");
}
const pythonPort = await availablePort(8005);
const apiPort = await availablePort(8001);
const adminPort = await availablePort(5201);
const model = shared.DEFAULT_MODEL || "gpt-4o-mini";
const deepseek = model.startsWith("deepseek") && shared.DEEPSEEK_API_KEY;
const children = [
  spawn("uv", ["run", "python", "-c",
    "from src.main import app; from src.config import settings; import uvicorn; uvicorn.run(app, host='127.0.0.1', port=settings.port, loop='none')"], {
    cwd: resolve(root, "apps/server-py"), stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env, PYTHONUTF8: "1", DEBUG: shared.DEBUG || "false",
      DATABASE_URL: database.replace(/^postgres(?:ql)?(?:\+asyncpg)?:/, "postgresql+asyncpg:"),
      JWT_SECRET: jwt, PORT: String(pythonPort), DEFAULT_MODEL: model,
      ...(deepseek ? {
        OPENAI_API_KEY: shared.DEEPSEEK_API_KEY,
        OPENAI_BASE_URL: shared.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
      } : {
        OPENAI_API_KEY: shared.OPENAI_API_KEY || "",
        OPENAI_BASE_URL: shared.OPENAI_BASE_URL || "https://api.openai.com/v1",
      }),
    },
  }),
  spawn(process.execPath, [serverRequire.resolve("tsx/cli"), "src/index.ts"], {
    cwd: resolve(root, "apps/server"), stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...shared, DATABASE_URL: database.replace("+asyncpg", ""), JWT_SECRET: jwt,
      PORT: String(apiPort), AGENT_FLOW_BACKEND_URL: `http://127.0.0.1:${pythonPort}`,
    },
  }),
  spawn(process.execPath, [resolve(dirname(adminRequire.resolve("vite/package.json")), "bin/vite.js"), "--port", String(adminPort)], {
    cwd: resolve(root, "apps/data-admin"), stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, AGENTFORGE_API_URL: `http://127.0.0.1:${apiPort}` },
  }),
];
console.log(`Flow workbench: http://localhost:${adminPort}/admin/cs/agent-flows`);
console.log(`Flow API: http://localhost:${apiPort} | Python: http://localhost:${pythonPort}`);
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    if (!child.pid) continue;
    if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill();
  }
}
for (const [index, child] of children.entries()) {
  child.on("error", (error) => { console.error(error.message); stop(1); });
  child.on("exit", (code, signal) => {
    if (!stopping) console.error(`${["Python", "API", "Admin"][index]} exited (${signal || code})`);
    stop(code || 0);
  });
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
