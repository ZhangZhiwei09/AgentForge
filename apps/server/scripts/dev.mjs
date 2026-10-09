import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cli = require.resolve("tsx/cli");
const children = ["src/worker.ts", "src/index.ts"].map((entry) =>
  spawn(process.execPath, [cli, "watch", entry], { stdio: "inherit" }),
);
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill();
}

for (const child of children) {
  child.on("error", (error) => {
    console.error(error);
    stop(1);
  });
  child.on("exit", (code, signal) => stop(code ?? (signal ? 1 : 0)));
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
