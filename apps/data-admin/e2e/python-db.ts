import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

type FixtureArgs = {
  where?: Record<string, unknown>;
  select?: Record<string, boolean>;
  data?: Record<string, unknown>;
};
type Row = { id: string };
type Conversation = Row & { status: string };
type Flow = Row & { archived: boolean; publishedVersion: number };
type Run = Row & { status: string; version: number; records: Record<string, unknown>; output: unknown };
type Message = Row & {
  metadata: {
    diagnosis: { phases: unknown[]; status: string };
    waitingInput: { missingFields: string[] };
  };
};

function createPythonDatabase() {
  if (!process.env.AGENTFORGE_E2E_DATABASE_URL || !process.env.JWT_SECRET) {
    throw new Error("Real browser tests require AGENTFORGE_E2E_DATABASE_URL (agentforge_test_*) and JWT_SECRET");
  }
  const child = spawn("uv", ["run", "--locked", "python", "-m", "tests.browser_db"], {
    cwd: resolve(process.cwd(), "../server-py"),
    env: { ...process.env, PYTHONUTF8: "1" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const lines = createInterface({ input: child.stdout });
  const fail = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  lines.on("line", (line) => {
    try {
      const response: unknown = JSON.parse(line);
      if (!response || typeof response !== "object" || !("id" in response) || typeof response.id !== "number") {
        throw new Error("Invalid Python fixture response");
      }
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      if ("error" in response) request.reject(new Error(String(response.error)));
      else if ("result" in response) request.resolve(response.result);
      else request.reject(new Error("Missing Python fixture result"));
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
  child.on("error", fail);
  child.on("exit", (code) => fail(new Error(`Python fixture exited (${code})`)));
  function call<T>(model: string, action: string, args: FixtureArgs = {}, extra = {}): Promise<T> {
    if (child.exitCode !== null || child.stdin.destroyed) return Promise.reject(new Error("Python fixture is closed"));
    const id = ++nextId;
    return new Promise<T>((resolveResult, reject) => {
      // This typed bridge is test-only; rows are serialized from the fixed ORM model allowlist.
      pending.set(id, { resolve: (value) => resolveResult(value as T), reject });
      child.stdin.write(JSON.stringify({ id, model, action, args, ...extra }) + "\n");
    });
  }
  function model<T extends Row>(name: string) {
    return {
      create: (args: FixtureArgs) => call<T>(name, "create", args),
      count: (args: FixtureArgs) => call<number>(name, "count", args),
      findMany: (args: FixtureArgs) => call<T[]>(name, "findMany", args),
      findFirst: (args: FixtureArgs) => call<T | null>(name, "findFirst", args),
      findUnique: (args: FixtureArgs) => call<T | null>(name, "findUnique", args),
      deleteMany: (args: FixtureArgs) => call<number>(name, "deleteMany", args),
    };
  }
  return {
    user: model<Row>("user"), conversation: model<Conversation>("conversation"), message: model<Message>("message"),
    agentFlow: model<Flow>("agentFlow"), agentFlowRun: model<Run>("agentFlowRun"),
    entryRouteFlow: model<Flow>("entryRouteFlow"), entryRouteFlowRun: model<Run>("entryRouteFlowRun"),
    routeClassificationLog: model<Row & { source: string }>("routeClassificationLog"),
    cleanupFlow: (flowId: string) => call<null>("", "cleanupFlow", {}, { flowId }),
    $disconnect: () => new Promise<void>((done) => {
      if (child.exitCode !== null) { lines.close(); done(); return; }
      child.once("exit", () => { lines.close(); done(); });
      child.stdin.end();
    }),
  };
}

export function pythonDatabase() {
  let client: ReturnType<typeof createPythonDatabase> | undefined;
  const get = () => client ??= createPythonDatabase();
  return {
    get user() { return get().user; },
    get conversation() { return get().conversation; },
    get message() { return get().message; },
    get agentFlow() { return get().agentFlow; },
    get agentFlowRun() { return get().agentFlowRun; },
    get entryRouteFlow() { return get().entryRouteFlow; },
    get entryRouteFlowRun() { return get().entryRouteFlowRun; },
    get routeClassificationLog() { return get().routeClassificationLog; },
    cleanupFlow: (id: string) => get().cleanupFlow(id),
    $disconnect: () => client?.$disconnect() ?? Promise.resolve(),
  };
}
