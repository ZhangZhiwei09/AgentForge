import { test, expect, type APIRequestContext } from "@playwright/test";
import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentFlowDTO } from "@agentforge/shared-types";

const serverRequire = createRequire(resolve(process.cwd(), "../server/package.json"));
const { PrismaClient } = serverRequire("@prisma/client");
const { parse } = serverRequire("dotenv");
const configured = parse(readFileSync(resolve(process.cwd(), "../server/.env")));
const databaseUrl = (process.env.DATABASE_URL || configured.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5434/agentforge").replace("+asyncpg", "");
const secret = process.env.JWT_SECRET || configured.JWT_SECRET || "agentforge-dev-secret-change-in-production";
const db = new PrismaClient({ datasourceUrl: databaseUrl });
let flowId: string | undefined;
let adminId: string;
let userId: string;
let token: string;
let userToken: string;
let previous: Array<{ id: string }> = [];
test.describe.configure({ mode: "serial" });

function accessToken(id: string, role: string) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    sub: id, email: `${id}@example.test`, role, type: "access", iat: now, exp: now + 600,
  })).toString("base64url");
  return `${header}.${payload}.${createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url")}`;
}

async function activate(api: APIRequestContext, id: string, enabled: boolean) {
  const response = await api.put(`/api/agent-flows/${id}/activation`, {
    headers: { Authorization: `Bearer ${token}` }, data: { enabled },
  });
  expect(response.ok()).toBeTruthy();
}

test.beforeAll(async () => {
  adminId = randomUUID(); userId = randomUUID();
  await db.user.create({ data: { id: adminId, email: `flow-browser-${adminId}@example.test`, role: "admin" } });
  await db.user.create({ data: { id: userId, email: `flow-browser-${userId}@example.test`, role: "user" } });
  token = accessToken(adminId, "admin"); userToken = accessToken(userId, "user");
  previous = await db.$queryRaw`SELECT id FROM agent_flows WHERE enabled = true`;
});

test.afterAll(async ({ request }) => {
  if (flowId) {
    await activate(request, flowId, false);
    const threads: Array<{ id: string }> = await db.$queryRaw`SELECT id FROM agent_flow_runs WHERE flow_id = ${flowId}`;
    for (const thread of threads) {
      await db.$executeRaw`DELETE FROM checkpoint_writes WHERE thread_id = ${thread.id}`;
      await db.$executeRaw`DELETE FROM checkpoint_blobs WHERE thread_id = ${thread.id}`;
      await db.$executeRaw`DELETE FROM checkpoints WHERE thread_id = ${thread.id}`;
    }
    await db.$executeRaw`DELETE FROM agent_flow_runs WHERE flow_id = ${flowId}`;
    await db.$executeRaw`DELETE FROM agent_flows WHERE id = ${flowId}`;
  }
  for (const flow of previous) await activate(request, flow.id, true);
  await db.conversation.deleteMany({ where: { userId: { in: [adminId, userId].filter(Boolean) } } });
  await db.user.deleteMany({ where: { id: { in: [adminId, userId].filter(Boolean) } } });
  await db.$disconnect();
});

test("real API, node editing, publishing and desktop/mobile layout", async ({ page, request }, testInfo) => {
  const denied = await request.get("/api/agent-flows", { headers: { Authorization: `Bearer ${userToken}` } });
  expect(denied.status()).toBe(403);
  const forged = await request.post("/api/agent/chat", {
    headers: { Authorization: `Bearer ${token.slice(0, -4)}fake` }, data: { message: "你好" },
  });
  expect(forged.status()).toBe(401);
  const owned = await db.conversation.create({
    data: { id: randomUUID(), userId: adminId, title: "Flow ownership test", type: "agent_chat" },
  });
  const otherUser = await request.post("/api/agent/chat", {
    headers: { Authorization: `Bearer ${userToken}` },
    data: { conversation_id: owned.id, message: "你好" },
  });
  expect(await otherUser.text()).toContain("无权访问该会话");
  await page.addInitScript((token) => localStorage.setItem("accessToken", token), token);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/admin/cs/agent-flows");
  await page.getByRole("textbox", { name: "新流程名称" }).fill("浏览器流程回归");
  await page.getByRole("button", { name: "新建诊断流程" }).click();
  await page.waitForURL("**/agent-flows/*");
  flowId = page.url().split("/").at(-1);
  await expect(page.locator(".react-flow__node")).toHaveCount(7);
  await expect(page.locator('.react-flow__node[data-id="backend"]')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("flow-desktop.png"), fullPage: true });
  await page.locator('.react-flow__node[data-id="backend"]').click();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(8);
  expect(await page.locator(".react-flow__node").evaluateAll((nodes) => {
    const rectangles = nodes.map((node) => node.getBoundingClientRect());
    return rectangles.every((a, index) => rectangles.slice(index + 1).every((b) =>
      Math.min(a.right, b.right) - Math.max(a.left, b.left) < 1 ||
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) < 1));
  })).toBeTruthy();
  await page.getByLabel("节点名称", { exact: true }).fill("数据库专家");
  await page.getByLabel("角色名称", { exact: true }).fill("数据库排查专家");
  await page.getByLabel("系统提示词", { exact: true }).fill("你是数据库排查专家。仅根据事实给出结论和证据，不猜测根因。");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已保存");
  const headers = { Authorization: `Bearer ${token}` };
  const detail = await request.get(`/api/agent-flows/${flowId}`, { headers });
  const saved: AgentFlowDTO = await detail.json();
  const expert = saved.draft.nodes.find((node) => node.name === "数据库专家")!;
  expect(expert.role?.name).toBe("数据库排查专家");
  expect(saved.draft.edges.find((edge) => edge.source === "backend")?.target).toBe(expert.id);
  expect(saved.draft.nodes.find((node) => node.id === "leader")?.inputs[expert.id].nodeId).toBe(expert.id);
  await page.getByRole("button", { name: "发布", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已发布 v1");
  await page.getByRole("switch", { name: "启用发布流程" }).click();
  await expect(page.getByRole("status")).toContainText("已启用发布版本");
  await expect(page.getByRole("switch", { name: "启用发布流程" })).toBeChecked();
  await page.getByLabel("职责", { exact: true }).fill("验证数据库证据和异常时间线");
  await expect(page.getByText("未保存", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已保存");
  await expect(page.getByText("未发布", { exact: true })).toBeVisible();
  const unpublished = await request.get(`/api/agent-flows/${flowId}`, { headers });
  expect((await unpublished.json()).publishedVersion).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("flow-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.getByRole("button", { name: "关闭节点配置" }).click();
  await page.getByRole("button", { name: "试运行", exact: true }).click();
  await expect(page.locator('.react-flow__node[data-id="frontend"]')).toBeInViewport();
  await expect(page.getByRole("textbox", { name: "试运行问题" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("flow-mobile-run.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("optional live model smoke run", async ({ page, request }, testInfo) => {
  test.skip(process.env.AGENT_FLOW_LIVE_MODEL !== "1", "Set AGENT_FLOW_LIVE_MODEL=1 to call the configured model");
  test.setTimeout(240000);
  const headers = { Authorization: `Bearer ${token}` };
  const detail = await request.get(`/api/agent-flows/${flowId}`, { headers });
  const flow: AgentFlowDTO = await detail.json();
  for (const node of flow.draft.nodes) node.execution.tools = [];
  const saved = await request.put(`/api/agent-flows/${flowId}/draft`, {
    headers, data: { name: flow.name, revision: flow.draftRevision, definition: flow.draft },
  });
  expect(saved.ok()).toBeTruthy();
  await page.addInitScript((token) => localStorage.setItem("accessToken", token), token);
  await page.goto(`/admin/cs/agent-flows/${flowId}`);
  await page.getByRole("button", { name: "试运行", exact: true }).click();
  await page.getByRole("textbox", { name: "试运行问题" }).fill("traceId: live-test-123，H5 刷脸失败返回 ACE_TIMEOUT。当前没有监控数据，请明确证据不足。");
  await page.getByRole("button", { name: "运行", exact: true }).click();
  await expect(page.locator(".af-run-controls")).toContainText("完成", { timeout: 190000 });
  await expect(page.locator('.react-flow__node[data-id="frontend"]')).toBeInViewport();
  const history = await request.get(`/api/agent-flows/${flowId}/runs`, { headers });
  const trial = (await history.json()).items.find((run: { test: boolean }) => run.test);
  expect(trial.status, trial.error || "").toBe("completed");
  const completed: string[] = Object.values(trial.records)
    .filter((record) => (record as { status: string }).status === "completed")
    .map((record) => (record as { nodeId: string }).nodeId);
  expect(completed).toContain("frontend");
  expect(completed).toContain("backend");
  expect(completed).toContain("leader");
  expect(completed.some((id) => id.startsWith("agent_"))).toBeTruthy();
  await page.locator(".af-run-node").filter({ hasText: "数据库专家" }).click();
  await expect(page.locator(".af-record-detail").first()).toContainText("conclusion");
  await page.screenshot({ path: testInfo.outputPath("flow-live-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("flow-live-mobile.png"), fullPage: true });
  const publish = await request.post(`/api/agent-flows/${flowId}/publish`, {
    headers, data: { revision: (await saved.json()).draftRevision },
  });
  expect(publish.ok()).toBeTruthy();
  const production = await request.post("/api/agent/chat", {
    headers: { Authorization: `Bearer ${userToken}` },
    data: { message: "traceId: live-test-123，H5 刷脸失败返回 ACE_TIMEOUT，请定位核身失败原因。当前没有监控数据，请明确证据不足。" },
    timeout: 200000,
  });
  expect(production.ok()).toBeTruthy();
  const publicEvents = (await production.text()).split("\n\n").filter((frame) => frame.startsWith("data:"))
    .map((frame) => frame.slice(5).trim()).filter((data) => data !== "[DONE]").map((data) => JSON.parse(data));
  const phases = publicEvents.filter((event) => event.type === "diagnosis_phase_done");
  expect(new Set(phases.map((event) => event.agent))).toEqual(new Set(completed.filter((id) =>
    flow.draft.nodes.find((node) => node.id === id)?.type === "agent")));
  expect(publicEvents.some((event) => event.type === "diagnosis_completed" || event.type === "diagnosis_waiting_input")).toBeTruthy();
  expect(publicEvents.filter((event) => event.type === "error")).toEqual([]);
  expect(publicEvents.at(-1)?.type).toBe("done");
  expect(publicEvents.some((event) => event.type.startsWith("node_"))).toBeFalsy();
  const persisted = await db.message.findUnique({ where: { id: publicEvents.find((event) => event.type === "meta").message_id } });
  expect(persisted.metadata.diagnosis.phases).toHaveLength(4);
  if (publicEvents.some((event) => event.type === "diagnosis_waiting_input")) {
    expect(persisted.metadata.diagnosis.status).toBe("waiting_input");
    expect(persisted.metadata.waitingInput.missingFields.length).toBeGreaterThan(0);
    const continuation = await request.post("/api/agent/chat", {
      headers: { Authorization: `Bearer ${userToken}` },
      data: { conversation_id: publicEvents.find((event) => event.type === "meta").conversation_id,
        message: "10:30，H5 手机端，只有返回错误码，暂时无法取得监控日志。" },
    });
    expect(await continuation.text()).toContain("diagnosis_completed");
  }
});
