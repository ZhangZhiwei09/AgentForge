// Launch a flow workbench without disturbing already-running development servers.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const adminRequire = createRequire(resolve(root, "apps/data-admin/package.json"));
const customerRequire = createRequire(resolve(root, "apps/customer-service/package.json"));

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
const apiPort = await availablePort(8000);
const adminPort = await availablePort(5200);
const customerPort = await availablePort(5173);
const children = [
  spawn("uv", ["run", "python", "-m", "src.dev", "--port", String(apiPort)], {
    cwd: resolve(root, "apps/server-py"), stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, PYTHONUTF8: "1" },
  }),
  spawn(process.execPath, [resolve(dirname(adminRequire.resolve("vite/package.json")), "bin/vite.js"), "--port", String(adminPort)], {
    cwd: resolve(root, "apps/data-admin"), stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, AGENTFORGE_API_URL: `http://127.0.0.1:${apiPort}` },
  }),
  spawn(process.execPath, [resolve(dirname(customerRequire.resolve("vite/package.json")), "bin/vite.js"), "--port", String(customerPort)], {
    cwd: resolve(root, "apps/customer-service"), stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, AGENTFORGE_API_URL: `http://127.0.0.1:${apiPort}` },
  }),
];
console.log(`Flow workbench: http://localhost:${adminPort}/admin/cs/agent-flows`);
console.log(`Python API: http://localhost:${apiPort} | Customer: http://localhost:${customerPort}`);
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
    if (!stopping) console.error(`${["Python", "Admin", "Customer"][index]} exited (${signal || code})`);
    stop(code || 0);
  });
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
