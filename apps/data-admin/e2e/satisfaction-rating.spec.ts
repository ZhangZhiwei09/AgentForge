import { test, expect, type Page, type Route } from "@playwright/test";

const customerUrl = process.env.AGENT_FLOW_CUSTOMER_URL || "http://localhost:5173/";
const conversationId = "own-conversation";
const messageId = "own-answer";
const user = { id: "user", email: "user@example.test", role: "user" };
const feedback = "请补充操作步骤";
type RatingHandler = (route: Route) => Promise<void>;

async function openOwnConversation(page: Page, handleRating: RatingHandler) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/agent/chat/rate") {
      await handleRating(route);
    } else if (url.pathname === "/api/auth/signin") {
      await route.fulfill({ json: {
        user, accessToken: "renewed-token", refreshToken: "renewed-refresh",
      } });
    } else if (url.pathname === "/api/auth/me") {
      await route.fulfill({ json: user });
    } else if (url.pathname === "/api/agent/chat/history") {
      expect(request.headers().authorization).toMatch(/^Bearer (user|renewed)-token$/);
      expect(url.searchParams.get("conversation_id")).toBe(conversationId);
      await route.fulfill({ json: {
        conversation_id: conversationId,
        messages: [
          { id: "own-question", role: "user", content: "如何排查？", timestamp: "2026-10-29T01:00:00Z" },
          { id: messageId, role: "assistant", content: "请检查错误码并重试。", timestamp: "2026-10-29T01:00:01Z" },
        ],
        has_more: false, next_cursor: null,
      } });
    } else if (url.pathname === "/api/agent/chat/conversations") {
      await route.fulfill({ json: { conversations: [] } });
    } else {
      await route.fulfill({ status: 404, json: { detail: "Unexpected API request" } });
    }
  });
  await page.goto(new URL("/login", customerUrl).href);
  await page.evaluate((id) => {
    localStorage.setItem("accessToken", "user-token");
    localStorage.setItem("agent_chat_conversation_id", id);
  }, conversationId);
  await page.goto(customerUrl);
  await expect(page.getByRole("button", { name: "有帮助", exact: true })).toBeVisible();
}

for (const width of [1440, 390]) {
  test(`authenticated feedback waits for success and prevents duplicates at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 960 });
    let requests = 0;
    let releaseResponse: () => void = () => { throw new Error("Rating request has not started"); };
    const responseReady = new Promise<void>((resolve) => { releaseResponse = resolve; });
    await openOwnConversation(page, async (route) => {
      requests++;
      expect(route.request().headers().authorization).toBe("Bearer user-token");
      expect(route.request().postDataJSON()).toMatchObject({
        session_id: conversationId, message_id: messageId, rating: "positive",
      });
      await responseReady;
      await route.fulfill({ json: { success: true } });
    });
    const helpful = page.getByRole("button", { name: "有帮助", exact: true });
    await helpful.click();
    await expect(page.getByRole("status")).toHaveText("正在提交反馈...");
    await expect(helpful).toBeDisabled();
    await expect(page.getByRole("button", { name: "没有帮助", exact: true })).toBeDisabled();
    await expect(page.getByText("感谢您的反馈！")).toHaveCount(0);
    await helpful.evaluate((button: HTMLButtonElement) => button.click());
    expect(requests).toBe(1);
    releaseResponse();
    await expect(page.getByText("感谢您的反馈！")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(requests).toBe(1);
    await page.screenshot({ path: info.outputPath(`rating-success-${width}.png`) });
  });
}

for (const failure of ["network", "server"] as const) {
  test(`${failure} errors preserve feedback and allow retry`, async ({ page }) => {
    let requests = 0;
    await openOwnConversation(page, async (route) => {
      requests++;
      expect(route.request().headers().authorization).toBe("Bearer user-token");
      expect(route.request().postDataJSON()).toMatchObject({
        session_id: conversationId, message_id: messageId, rating: "negative", comment: feedback,
      });
      if (requests === 1) {
        if (failure === "network") await route.abort("failed");
        else await route.fulfill({ status: 503, json: { detail: "Temporarily unavailable" } });
      } else {
        await route.fulfill({ json: { success: true } });
      }
    });
    await page.getByRole("button", { name: "没有帮助", exact: true }).click();
    const comment = page.getByPlaceholder("补充您的反馈（可选）...");
    await comment.fill(feedback);
    await page.getByRole("button", { name: "提交反馈", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("评价提交失败");
    await expect(page.getByText("感谢您的反馈！")).toHaveCount(0);
    await expect(comment).toHaveValue(feedback);
    await expect(page.getByRole("button", { name: "提交反馈", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "提交反馈", exact: true }).click();
    await expect(page.getByText("感谢您的反馈！")).toBeVisible();
    expect(requests).toBe(2);
  });
}

test("forbidden feedback shows denial without reporting success", async ({ page }) => {
  await openOwnConversation(page, async (route) => {
    await route.fulfill({ status: 403, json: { detail: "Forbidden" } });
  });
  await page.getByRole("button", { name: "有帮助", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("您无权评价此会话。");
  await expect(page.getByText("感谢您的反馈！")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("accessToken"))).toBe("user-token");
});

test("expired feedback credentials require login before rating the restored conversation", async ({ page }) => {
  let requests = 0;
  await openOwnConversation(page, async (route) => {
    requests++;
    if (requests === 1) {
      await route.fulfill({ status: 401, json: { detail: "Not authenticated" } });
    } else {
      expect(route.request().headers().authorization).toBe("Bearer renewed-token");
      expect(route.request().postDataJSON()).toMatchObject({
        session_id: conversationId, message_id: messageId, rating: "positive",
      });
      await route.fulfill({ json: { success: true } });
    }
  });
  await page.getByRole("button", { name: "有帮助", exact: true }).click();
  await expect(page).toHaveURL(new URL("/login", customerUrl).href);
  expect(await page.evaluate(() => localStorage.getItem("accessToken"))).toBeNull();
  await expect(page.getByText("感谢您的反馈！")).toHaveCount(0);
  await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect(page.getByRole("button", { name: "有帮助", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "有帮助", exact: true }).click();
  await expect(page.getByText("感谢您的反馈！")).toBeVisible();
  expect(requests).toBe(2);
});
