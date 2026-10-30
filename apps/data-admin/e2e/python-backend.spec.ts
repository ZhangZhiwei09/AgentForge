import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { pythonDatabase } from "./python-db";

test("Python auth, knowledge ingestion, retrieval and persisted chat in real browsers", async ({ page, request }, info) => {
  test.skip(process.env.AGENTFORGE_E2E_EMBEDDINGS !== "1", "Start the deterministic embedding HTTP fixture");
  const db = pythonDatabase();
  const email = `cutover-${randomUUID()}@example.test`;
  const adminEmail = `cutover-admin-${randomUUID()}@example.test`;
  let userId: string | undefined;
  let adminId: string | undefined;
  let baseId: string | undefined;
  let token: string | undefined;
  try {
    await db.user.count({ where: { email } });
    const signup = await request.post("/api/auth/signup", { data: { email, password: "cutover-password" } });
    expect(signup.status()).toBe(201);
    const registered = await signup.json();
    userId = registered.user.id;
    expect(registered.user.role).toBe("user");
    const denied = await request.post("/api/knowledge/bases", {
      headers: { Authorization: `Bearer ${registered.accessToken}` },
      data: { name: "Unauthorized knowledge base" },
    });
    expect(denied.status()).toBe(403);
    adminId = (await db.createAdmin(adminEmail, "cutover-password")).id;
    await page.goto("/login?mode=admin&returnTo=/admin/cs/knowledge");
    await page.getByLabel("Email", { exact: true }).fill(adminEmail);
    await page.getByLabel("Password", { exact: true }).fill("cutover-password");
    await page.getByRole("button", { name: "管理员登录", exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === "/admin/cs/knowledge");
    token = await page.evaluate(() => localStorage.getItem("accessToken") || undefined);
    const headers = { Authorization: `Bearer ${token}` };
    const identity = await request.get("/api/auth/me", { headers });
    expect(identity.status()).toBe(200);
    expect((await identity.json()).role).toBe("admin");
    const createBase = page.getByRole("button", { name: "创建知识库", exact: true }).first();
    await expect(createBase).toBeVisible();
    await createBase.click();
    const name = `Python 验收 ${randomUUID().slice(0, 8)}`;
    await page.getByPlaceholder("输入知识库名称", { exact: true }).fill(name);
    const createdResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/knowledge/bases") && response.request().method() === "POST");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    const created = await createdResponse;
    expect(created.status()).toBe(201);
    baseId = (await created.json()).id;
    await page.getByRole("heading", { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/bases/${baseId}$`));
    const content = "CUTOVER_TIMEOUT 表示请求超时。请检查网络、服务状态和请求时间，保存错误码与调用日志后重试。".repeat(8);
    const uploaded = await request.post(`/api/knowledge/bases/${baseId}/documents/upload?process=false`, {
      headers, multipart: { file: { name: "cutover.txt", mimeType: "text/plain", buffer: Buffer.from(content) } },
    });
    expect(uploaded.status()).toBe(201);
    const doc = await uploaded.json();
    const processed = await request.post(`/api/knowledge/bases/${baseId}/process`, { headers });
    expect(processed.ok()).toBeTruthy();
    const detail = await request.get(`/api/knowledge/documents/${doc.id}`, { headers });
    expect(detail.ok()).toBeTruthy();
    expect((await detail.json()).status).toBe("completed");
    const search = await request.post("/api/knowledge/search", {
      headers, data: { query: "CUTOVER_TIMEOUT", kb_ids: [baseId], top_k: 3 },
    });
    expect(search.ok()).toBeTruthy();
    const results = (await search.json()).results;
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("CUTOVER_TIMEOUT");
    await page.reload();
    await expect(page.getByText("cutover", { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: info.outputPath("python-knowledge-desktop.png"), fullPage: true, animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: info.outputPath("python-knowledge-mobile.png"), fullPage: true, animations: "disabled" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.goto(process.env.AGENT_FLOW_CUSTOMER_URL || "http://localhost:5173");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill("cutover-password");
    await page.getByRole("button", { name: "Sign In", exact: true }).click();
    const input = page.locator("textarea").first();
    await input.fill("你好");
    await input.press("Enter");
    await expect(page.getByText(/你好，我是 AgentForge/)).toBeVisible();
    await page.reload();
    await expect(page.getByText(/你好，我是 AgentForge/)).toBeVisible();
    await page.screenshot({ path: info.outputPath("python-chat-history-mobile.png"), fullPage: true, animations: "disabled" });
    const refreshed = await request.post("/api/auth/refresh", {
      data: { refresh_token: registered.refreshToken },
    });
    expect(refreshed.ok()).toBeTruthy();
    expect((await request.post("/api/auth/signout", {
      headers: { Authorization: `Bearer ${registered.accessToken}` },
    })).ok()).toBeTruthy();
    expect((await request.post("/api/auth/refresh", { data: { refresh_token: (await refreshed.json()).refreshToken } })).status()).toBe(401);
  } finally {
    try {
      if (baseId && token) await request.delete(`/api/knowledge/bases/${baseId}`, { headers: { Authorization: `Bearer ${token}` } });
    } finally {
      try {
        const userIds = [userId, adminId].filter((id): id is string => !!id);
        if (userIds.length) {
          const conversations = await db.conversation.findMany({
            where: { userId: { in: userIds } }, select: { id: true },
          });
          await db.routeClassificationLog.deleteMany({ where: { conversationId: { in: conversations.map((row) => row.id) } } });
          await db.conversation.deleteMany({ where: { userId: { in: userIds } } });
          await db.user.deleteMany({ where: { id: { in: userIds } } });
        }
      } finally {
        await db.$disconnect();
      }
    }
  }
});
