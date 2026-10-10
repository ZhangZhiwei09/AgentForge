import { test, expect, type APIRequestContext } from "@playwright/test";
import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentFlowDTO, EntryRouteFlowDTO, EntryRouteRunDTO } from "@agentforge/shared-types";

const require = createRequire(resolve(process.cwd(), "../server/package.json"));
const { PrismaClient } = require("@prisma/client");
const { parse } = require("dotenv");
const env = parse(readFileSync(resolve(process.cwd(), "../server/.env")));
const db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL || env.DATABASE_URL });
const secret = process.env.JWT_SECRET || env.JWT_SECRET || "agentforge-dev-secret-change-in-production";
const adminId = randomUUID(), userId = randomUUID();
let token: string, userToken: string;
let testIp = `entry-e2e-${randomUUID()}`;
let previous: Array<{ id: string }> = [];
let diagnosisBinding: Array<{ id: string; publishedVersion: number }>;
const flowIds: string[] = [];
const diagnosisFlowIds: string[] = [];
test.describe.configure({ mode: "serial" });

function accessToken(id: string, role: string) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ sub: id, role, type: "access", iat: now, exp: now + 1800 })).toString("base64url");
  return `${header}.${payload}.${createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url")}`;
}
const auth = () => ({ Authorization: `Bearer ${token}`, "X-Real-IP": testIp });
const userAuth = () => ({ Authorization: `Bearer ${userToken}`, "X-Real-IP": testIp });
async function activation(api: APIRequestContext, id: string, enabled: boolean) {
  const response = await api.put(`/api/entry-route-flows/${id}/activation`, { headers: auth(), data: { enabled } });
  expect(response.ok()).toBeTruthy();
}
test.beforeAll(async () => {
  await db.user.create({ data: { id: adminId, role: "admin", email: `entry-admin-${adminId}@example.test` } });
  await db.user.create({ data: { id: userId, role: "user", email: `entry-user-${userId}@example.test` } });
  token = accessToken(adminId, "admin"); userToken = accessToken(userId, "user");
  previous = await db.entryRouteFlow.findMany({ where: { enabled: true }, select: { id: true } });
  diagnosisBinding = await db.agentFlow.findMany({ where: { enabled: true }, select: { id: true, publishedVersion: true } });
});
test.beforeEach(async ({ page }) => {
  // Isolate test traffic in the existing limiter; production limits remain exercised.
  testIp = `entry-e2e-${randomUUID()}`;
  await page.setExtraHTTPHeaders({ "X-Real-IP": testIp });
});
test.afterAll(async ({ request }) => {
  testIp = `entry-e2e-cleanup-${randomUUID()}`;
  for (const id of flowIds) {
    const exists = await db.entryRouteFlow.findUnique({ where: { id } });
    if (exists && !exists.archived) await activation(request, id, false);
  }
  for (const item of previous) await activation(request, item.id, true);
  for (const id of diagnosisFlowIds) {
    await request.put(`/api/agent-flows/${id}/activation`, { headers: auth(), data: { enabled: false } });
    const runs = await db.agentFlowRun.findMany({ where: { flowId: id }, select: { id: true } });
    for (const run of runs) {
      await db.$executeRaw`DELETE FROM checkpoint_writes WHERE thread_id = ${run.id}`;
      await db.$executeRaw`DELETE FROM checkpoint_blobs WHERE thread_id = ${run.id}`;
      await db.$executeRaw`DELETE FROM checkpoints WHERE thread_id = ${run.id}`;
    }
    await db.agentFlowRun.deleteMany({ where: { flowId: id } });
    await db.agentFlow.deleteMany({ where: { id } });
  }
  if (diagnosisFlowIds.length) for (const item of diagnosisBinding) {
    await request.put(`/api/agent-flows/${item.id}/activation`, { headers: auth(), data: { enabled: true } });
  }
  await db.entryRouteFlowRun.deleteMany({ where: { flowId: { in: flowIds } } });
  await db.entryRouteFlow.deleteMany({ where: { id: { in: flowIds } } });
  await db.routeClassificationLog.deleteMany({ where: { conversationId: { in: (await db.conversation.findMany({ where: { userId }, select: { id: true } })).map((item: { id: string }) => item.id) } } });
  await db.conversation.deleteMany({ where: { userId: { in: [adminId, userId] } } });
  await db.user.deleteMany({ where: { id: { in: [adminId, userId] } } });
  await db.$disconnect();
});

test("real editor config, dry run, published chat, handoff and rollback", async ({ page, request }, info) => {
  test.setTimeout(120000);
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  expect((await request.get("/api/entry-route-flows", { headers: userAuth() })).status()).toBe(403);
  await page.addInitScript((value) => localStorage.setItem("accessToken", value), token);
  await page.goto("/admin/cs/entry-route-flows");
  await page.getByLabel("新流程名称").fill("一级流程浏览器验收");
  await page.getByRole("button", { name: "新建一级流程" }).click();
  await page.waitForURL("**/entry-route-flows/*");
  const id = page.url().split("/").at(-1)!; flowIds.push(id);
  await expect(page.locator(".react-flow__node")).toHaveCount(12);
  await expect(page.getByRole("switch", { name: "启用发布流程" })).toBeDisabled();
  await page.locator('.react-flow__node[data-id="greeting"]').click();
  await page.getByLabel("关键词", { exact: true }).fill("你好\n欢迎");
  await page.getByLabel("关键词", { exact: true }).press("End");
  await page.getByLabel("关键词", { exact: true }).press("Enter");
  await page.getByLabel("关键词", { exact: true }).pressSequentially("hello");
  await expect(page.getByLabel("关键词", { exact: true })).toHaveValue("你好\n欢迎\nhello");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已保存");
  await page.getByRole("button", { name: "关闭节点配置" }).click();
  await page.locator('.react-flow__node[data-id="greeting_result"]').click();
  await page.getByLabel("回复正文").fill("平台配置的欢迎回复");
  await page.getByLabel("建议问题", { exact: true }).fill("查知识库\n查故障");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已保存");
  await page.getByRole("button", { name: "关闭节点配置" }).click();
  await page.getByRole("link", { name: "返回流程列表" }).click();
  await page.getByRole("link", { name: "一级流程浏览器验收", exact: true }).click();
  await page.locator('.react-flow__node[data-id="greeting_result"]').click();
  await expect(page.getByLabel("回复正文")).toHaveValue("平台配置的欢迎回复");
  await page.getByRole("button", { name: "关闭节点配置" }).click();
  await page.getByRole("button", { name: "试运行", exact: true }).click();
  await page.getByLabel("试运行问题").fill("欢迎！");
  await page.getByRole("button", { name: "运行", exact: true }).click();
  await expect(page.getByLabel("最终决策")).toContainText("平台配置的欢迎回复");
  const before = await db.conversation.count({ where: { userId } });
  await page.getByLabel("试运行问题").fill("转人工");
  await page.getByRole("button", { name: "运行", exact: true }).click();
  await expect(page.getByLabel("最终决策")).toContainText("HUMAN");
  expect(await db.conversation.count({ where: { userId } })).toBe(before);
  await page.getByRole("button", { name: "关闭试运行" }).click();
  await page.screenshot({ path: info.outputPath("entry-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "发布", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已发布 v1");
  await page.getByRole("switch", { name: "启用发布流程" }).click();
  await expect(page.getByRole("status")).toContainText("已启用发布版本");
  const chat = await request.post("/api/agent/chat", { headers: userAuth(), data: { message: "欢迎！" } });
  const frames = (await chat.text()).split(/\r?\n/).filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  expect(frames.filter((event) => event.type === "token").map((event) => event.content).join("")).toBe("平台配置的欢迎回复");
  expect(frames.find((event) => event.type === "done")?.suggestions).toEqual(["查知识库", "查故障"]);
  const meta = frames.find((event) => event.type === "meta");
  expect(await db.message.count({ where: { id: meta.message_id } })).toBe(1);
  expect(await db.entryRouteFlowRun.count({ where: { flowId: id, test: false, assistantMessageId: meta.message_id } })).toBe(1);
  const history = await request.get(`/api/agent/chat/history?conversation_id=${meta.conversation_id}`, { headers: userAuth() });
  expect(await history.text()).toContain("平台配置的欢迎回复");
  // Draft updates do not affect the current published version.
  const detail: EntryRouteFlowDTO = await (await request.get(`/api/entry-route-flows/${id}`, { headers: auth() })).json();
  const reply = detail.draft.nodes.find((node) => node.id === "greeting_result")!;
  if (reply.type !== "reply") throw new Error();
  reply.answer = "尚未发布的回复";
  const human = detail.draft.nodes.find((node) => node.id === "human_result")!;
  if (human.type !== "route") throw new Error();
  human.handoff = { withinHours: "平台工作时间转接", outsideHours: "平台非工作时间转接", suggestions: ["继续咨询"] };
  const saved: EntryRouteFlowDTO = await (await request.put(`/api/entry-route-flows/${id}/draft`, { headers: auth(), data: { name: detail.name, revision: detail.draftRevision, definition: detail.draft } })).json();
  const stillV1 = await request.post("/api/agent/chat", { headers: userAuth(), data: { message: "欢迎" } });
  expect(await stillV1.text()).not.toContain("尚未发布");
  expect((await request.post(`/api/entry-route-flows/${id}/publish`, { headers: auth(), data: { revision: detail.draftRevision } })).status()).toBe(409);
  await request.post(`/api/entry-route-flows/${id}/publish`, { headers: auth(), data: { revision: saved.draftRevision } });
  const handoff = await request.post("/api/agent/chat", { headers: userAuth(), data: { message: "转人工" } });
  const handoffFrames = (await handoff.text()).split(/\r?\n/).filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  const handoffMeta = handoffFrames.find((event) => event.type === "meta");
  const handoffText = handoffFrames.filter((event) => event.type === "token").map((event) => event.content).join("");
  expect(handoffText).toBe(handoffMeta.within_service_hours ? human.handoff.withinHours : human.handoff.outsideHours);
  expect((await db.conversation.findUnique({ where: { id: handoffMeta.conversation_id } })).status).toBe("escalated");
  // Customer browser consumes the existing SSE contract without changes.
  await page.goto("http://localhost:5173");
  const input = page.locator("textarea").first();
  await expect(input).toBeVisible();
  await input.fill("欢迎");
  await input.press("Enter");
  await expect(page.getByText("尚未发布的回复", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("entry-customer-reply.png"), fullPage: true });
  await page.goto(`/admin/cs/entry-route-flows/${id}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".react-flow__node")).toHaveCount(12);
  await page.screenshot({ path: info.outputPath("entry-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.getByRole("button", { name: "试运行", exact: true }).click();
  await page.getByLabel("试运行问题").fill("普通业务");
  await page.getByRole("button", { name: "运行", exact: true }).click();
  await expect(page.getByLabel("最终决策")).toContainText("continue");
  await page.screenshot({ path: info.outputPath("entry-mobile-run.png"), fullPage: true });
  await page.getByRole("button", { name: "关闭试运行" }).click();
  await page.getByRole("switch", { name: "启用发布流程" }).click();
  await expect(page.getByRole("status")).toContainText("已停用");
  const rollback = await request.post("/api/agent/chat", { headers: userAuth(), data: { message: "你好" } });
  const rollbackFrames = (await rollback.text()).split(/\r?\n/).filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  expect(rollbackFrames.filter((event) => event.type === "token").map((event) => event.content).join("")).toContain("我是 AgentForge");
  expect(await db.agentFlow.findMany({ where: { enabled: true }, select: { id: true, publishedVersion: true } })).toEqual(diagnosisBinding);
  expect(errors).toEqual([]);
});

test("real canvas node creation, connections, graph errors and archive", async ({ page, request }) => {
  const created = await request.post("/api/entry-route-flows", { headers: auth(), data: { name: "连线验收", template: "empty" } });
  const flow: EntryRouteFlowDTO = await created.json(); flowIds.push(flow.id);
  await page.addInitScript((value) => localStorage.setItem("accessToken", value), token);
  await page.goto(`/admin/cs/entry-route-flows/${flow.id}`);
  await page.getByRole("button", { name: "添加条件" }).click();
  await page.getByRole("button", { name: "关闭节点配置" }).click();
  await page.getByRole("button", { name: "添加固定回复" }).click();
  await page.getByRole("button", { name: "关闭节点配置" }).click();
  const added = await page.locator(".react-flow__node").evaluateAll((nodes) => nodes.map((item) => item.getAttribute("data-id")!));
  const conditionId = added.find((id) => id.startsWith("condition_"))!;
  const replyId = added.find((id) => id.startsWith("reply_"))!;
  // Place new nodes in separate tracks through actual drag events.
  for (const [id, dx, dy] of [[conditionId, 120, -140], [replyId, 350, 180]] as const) {
    const box = (await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox())!;
    await page.mouse.move(box.x + 30, box.y + 45); await page.mouse.down();
    await page.mouse.move(box.x + 30 + dx, box.y + 45 + dy, { steps: 12 }); await page.mouse.up();
  }
  await page.locator(".react-flow__controls-fitview").click();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  async function connect(source: string, branch: string | null, target: string) {
    const from = page.locator(`.react-flow__node[data-id="${source}"] .react-flow__handle.source${branch ? `[data-handleid="${branch}"]` : ""}`);
    const to = page.locator(`.react-flow__node[data-id="${target}"] .react-flow__handle.target`);
    const a = (await from.boundingBox())!, b = (await to.boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 }); await page.mouse.up();
  }
  await connect("start", null, conditionId);
  await connect(conditionId, "true", replyId);
  await connect(conditionId, "false", "fallback");
  await page.getByRole("button", { name: "校验", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("校验通过");
  const detail: EntryRouteFlowDTO = await (await request.get(`/api/entry-route-flows/${flow.id}`, { headers: auth() })).json();
  expect(detail.draft.edges.find((edge) => edge.source === "start")?.target).toBe(conditionId);
  const testRun: EntryRouteRunDTO = await (await request.post(`/api/entry-route-flows/${flow.id}/test-run`, { headers: auth(), data: { revision: detail.draftRevision, message: "关键词" } })).json();
  expect(testRun.output?.action).toBe("reply");
  await page.locator(`.react-flow__node[data-id="${replyId}"]`).click();
  await page.getByRole("button", { name: "删除节点" }).click();
  await page.getByRole("button", { name: "校验", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("出口");
  await page.getByRole("button", { name: "关闭节点配置" }).click();
  await page.getByRole("link", { name: "返回流程列表" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "归档 连线验收" }).click();
  await expect(page.getByRole("link", { name: "连线验收", exact: true })).toHaveCount(0);
  expect((await db.entryRouteFlowRun.findUnique({ where: { id: testRun.id } })).status).toBe("completed");
});

test("ordinary user has no entry tab and cannot open editor directly", async ({ page }) => {
  await page.addInitScript((value) => localStorage.setItem("accessToken", value), userToken);
  await page.goto(`/admin/cs/entry-route-flows/${flowIds[0]}`);
  await expect(page.getByRole("alert")).toContainText("仅管理员");
  await expect(page.getByRole("link", { name: "一级路由流程", exact: true })).toHaveCount(0);
  await expect(page.locator(".react-flow")).toHaveCount(0);
});

test("optional live entry dispatch, diagnosis HITL and L2 continuation", async ({ request, page }, info) => {
  test.skip(process.env.AGENT_ENTRY_FLOW_LIVE_MODEL !== "1", "Set AGENT_ENTRY_FLOW_LIVE_MODEL=1 for configured model validation");
  test.setTimeout(240000);
  const created = await request.post("/api/entry-route-flows", { headers: auth(), data: { name: "一级路由模型验收" } });
  const entry: EntryRouteFlowDTO = await created.json(); flowIds.push(entry.id);
  const diagnostic = await request.post("/api/agent-flows", { headers: auth(), data: { name: "一级入口诊断验收" } });
  expect(diagnostic.ok()).toBeTruthy();
  const diagnosis: AgentFlowDTO = await diagnostic.json(); diagnosisFlowIds.push(diagnosis.id);
  for (const node of diagnosis.draft.nodes) {
    node.execution.tools = [];
    if (node.id === "frontend") node.role!.systemPrompt += "\n本次验收必须返回 need_escalation=true。当前没有监控数据，证据不足时必须如实说明。";
    if (node.id === "leader") node.role!.systemPrompt += "\n本次用于验证补充信息链路。必须返回 missing_fields=[\"发生时间\"]、message=\"请补充发生时间\"。不要虚构日志和证据。";
  }
  const saved = await request.put(`/api/agent-flows/${diagnosis.id}/draft`, { headers: auth(), data: { name: diagnosis.name, revision: diagnosis.draftRevision, definition: diagnosis.draft } });
  expect(saved.ok()).toBeTruthy();
  const savedDiagnosis: AgentFlowDTO = await saved.json();
  expect((await request.post(`/api/agent-flows/${diagnosis.id}/publish`, { headers: auth(), data: { revision: savedDiagnosis.draftRevision } })).ok()).toBeTruthy();
  expect((await request.put(`/api/agent-flows/${diagnosis.id}/activation`, { headers: auth(), data: { enabled: true } })).ok()).toBeTruthy();
  expect((await request.post(`/api/entry-route-flows/${entry.id}/publish`, { headers: auth(), data: { revision: entry.draftRevision } })).ok()).toBeTruthy();
  await activation(request, entry.id, true);
  const chat = async (message: string, conversationId?: string) => {
    const response = await request.post("/api/agent/chat", {
      headers: userAuth(),
      data: { message, ...(conversationId ? { conversation_id: conversationId } : {}) }, timeout: 200000,
    });
    expect(response.ok()).toBeTruthy();
    return (await response.text()).split(/\r?\n/).filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  };
  const events = await chat("traceId: entry-live-123，H5 刷脸失败，ACE_TIMEOUT，请诊断。");
  expect(events.filter((event) => event.type === "error")).toEqual([]);
  expect(events.some((event) => event.type === "diagnosis_waiting_input")).toBeTruthy();
  const meta = events.find((event) => event.type === "meta");
  const run = await db.agentFlowRun.findFirst({ where: { flowId: diagnosis.id, conversationId: meta.conversation_id, status: "waiting_input" } });
  expect(run).toBeTruthy();
  expect(await db.entryRouteFlowRun.count({ where: { flowId: entry.id, conversationId: meta.conversation_id } })).toBe(1);
  await page.addInitScript(({ access, conversationId }) => {
    localStorage.setItem("accessToken", access);
    localStorage.setItem("agent_chat_conversation_id", conversationId);
  }, { access: userToken, conversationId: meta.conversation_id });
  await page.goto("http://localhost:5173/");
  await expect(page.getByText("诊断暂停，需要您补充信息", { exact: true })).toBeVisible();
  await expect(page.getByText("多 Agent 协同诊断", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("entry-live-customer-waiting.png"), fullPage: true });
  // Re-publish and disable the entry while a diagnosis is waiting.
  expect((await request.post(`/api/entry-route-flows/${entry.id}/publish`, { headers: auth(), data: { revision: entry.draftRevision } })).ok()).toBeTruthy();
  await activation(request, entry.id, false);
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/agent/chat") && response.request().method() === "POST");
  await page.getByPlaceholder("请补充以上信息，例如 traceId、失败时间、错误码...").fill("你好");
  await page.getByRole("button", { name: "提交补充，继续诊断" }).click();
  const resumeResponse = await responsePromise;
  const resumed = (await resumeResponse.text()).split(/\r?\n/).filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  expect(resumed.filter((event) => event.type === "error")).toEqual([]);
  expect(resumed.some((event) => event.type === "diagnosis_completed")).toBeTruthy();
  expect(await db.entryRouteFlowRun.count({ where: { flowId: entry.id, conversationId: meta.conversation_id } })).toBe(1);
  const completed = await db.agentFlowRun.findUnique({ where: { id: run.id } });
  expect(completed.status).toBe("completed");
  expect(completed.version).toBe(run.version);
  for (const id of ["frontend", "backend", "leader"]) expect(completed.records[id]).toEqual(run.records[id]);
  await expect(page.getByText("完成", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("entry-live-customer.png"), fullPage: true });
  // Enable an empty entry so even a greeting must continue through L2-L5.
  const emptyResponse = await request.post("/api/entry-route-flows", { headers: auth(), data: { name: "后续智能路由验收", template: "empty" } });
  const empty: EntryRouteFlowDTO = await emptyResponse.json(); flowIds.push(empty.id);
  expect((await request.post(`/api/entry-route-flows/${empty.id}/publish`, { headers: auth(), data: { revision: 1 } })).ok()).toBeTruthy();
  await activation(request, empty.id, true);
  const continued = await chat("你好");
  expect(continued.filter((event) => event.type === "error")).toEqual([]);
  expect(continued.some((event) => event.type === "done")).toBeTruthy();
  const continuedMeta = continued.find((event) => event.type === "meta");
  const continuationRun = await db.entryRouteFlowRun.findFirst({ where: { flowId: empty.id, conversationId: continuedMeta.conversation_id } });
  expect(continuationRun.output).toEqual({ action: "continue" });
  const classification = await db.routeClassificationLog.findFirst({ where: { conversationId: continuedMeta.conversation_id } });
  expect(classification.source).not.toBe("keyword");
  await activation(request, empty.id, false);
});
