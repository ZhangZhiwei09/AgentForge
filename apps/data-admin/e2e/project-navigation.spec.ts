import { test, expect, type Page } from "@playwright/test";

async function mockWorkbench(page: Page, failFirst = false) {
  const requests: URL[] = [];
  let shouldFail = failFirst;
  await page.addInitScript(() => localStorage.setItem("accessToken", "workbench-token"));
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({ json: { id: "admin", email: "admin@example.test", role: "admin" } });
    } else if (url.pathname === "/api/knowledge/bases") {
      await route.fulfill({ json: [] });
    } else if (url.pathname === "/api/agent/chat/feedback") {
      if (shouldFail) {
        shouldFail = false;
        await route.fulfill({ status: 503, json: { detail: "反馈服务暂不可用" } });
        return;
      }
      const pageNumber = Number(url.searchParams.get("page"));
      const rating = url.searchParams.get("type") === "positive" ? "positive" : "negative";
      await route.fulfill({ json: {
        feedback: [{
          id: `feedback-${pageNumber}`, rating, comment: "缺少排查数据库连接池的步骤",
          created_at: "2026-10-11T08:00:00Z", conversation_id: "conversation-1",
          session_id: "session-1", intent: "diagnosis", message_id: "message-1",
          user_message: `第 ${pageNumber} 页：登录超时，错误信息 ${"connection_timeout_".repeat(15)}`,
          assistant_message: "检查服务日志和连接池状态，确认请求是否到达数据库。",
        }],
        pagination: { page: pageNumber, limit: 15, total: 16, totalPages: 2 },
      } });
    } else {
      await route.fulfill({ json: { items: [] } });
    }
  });
  return requests;
}

for (const width of [1440, 390, 320]) {
  test(`knowledge feedback navigation and filtering at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 960 });
    const requests = await mockWorkbench(page);
    await page.goto("/admin/cs/knowledge");
    const navigation = page.getByRole("navigation", { name: "管理模块" });
    await expect(navigation.getByRole("link")).toHaveCount(3);
    await expect(navigation.getByRole("link", { name: "数据分析", exact: true })).toHaveCount(0);
    await expect(navigation.getByRole("link", { name: "知识库管理" })).toHaveAttribute("aria-current", "page");
    await expect(navigation.getByRole("link", { name: "打开 Langfuse 追踪" })).toHaveAttribute("target", "_blank");
    await page.getByRole("link", { name: "用户反馈", exact: true }).click();
    await expect(page).toHaveURL(/\/knowledge\/feedback$/);
    const filters = page.getByRole("group", { name: "反馈筛选" });
    await expect(filters.getByRole("button", { name: "负面", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("缺少排查数据库连接池的步骤", { exact: false })).toBeVisible();
    await page.getByText("诊断回复", { exact: true }).click();
    await expect(page.getByText("检查服务日志和连接池状态，确认请求是否到达数据库。")).toBeVisible();
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(page.getByText("第 2 页：登录超时", { exact: false })).toBeVisible();
    await filters.getByRole("button", { name: "正面", exact: true }).click();
    await expect(page.getByText("第 1 页：登录超时", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "上一页", exact: true })).toBeDisabled();
    expect(requests.some((url) => url.searchParams.get("type") === "positive" && url.searchParams.get("page") === "1")).toBeTruthy();
    expect(requests.some((url) => url.pathname.endsWith("/analytics"))).toBeFalsy();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await page.screenshot({ path: info.outputPath(`feedback-${width}.png`), fullPage: true });
    await page.getByRole("link", { name: "返回知识库" }).click();
    await expect(page).toHaveURL(/\/knowledge$/);
  });
}

test("legacy analytics URL redirects to feedback and failed requests can be retried", async ({ page }) => {
  await mockWorkbench(page, true);
  await page.goto("/admin/cs/analytics");
  await expect(page).toHaveURL(/\/knowledge\/feedback$/);
  await expect(page.getByRole("alert")).toContainText("反馈服务暂不可用");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByText("第 1 页：登录超时", { exact: false })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.goto("/admin/cs/observability");
  await expect(page).toHaveURL(/\/knowledge$/);
});

test("empty feedback has a clear result and the filters remain usable", async ({ page }) => {
  await mockWorkbench(page);
  await page.route("**/api/agent/chat/feedback?**", (route) => route.fulfill({
    json: { feedback: [], pagination: { page: 1, limit: 15, total: 0, totalPages: 0 } },
  }));
  await page.goto("/admin/cs/knowledge/feedback");
  await expect(page.getByText("暂无反馈数据")).toBeVisible();
  await expect(page.getByRole("button", { name: "下一页", exact: true })).toHaveCount(0);
  await page.getByRole("group", { name: "反馈筛选" }).getByRole("button", { name: "全部", exact: true }).click();
  await expect(page.getByText("共 0 条")).toBeVisible();
});
