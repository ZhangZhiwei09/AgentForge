import { test, expect } from "@playwright/test";
import { loadEnv } from "vite";

const admin = { id: "admin", email: "administrator-with-a-long-email@example.test", role: "admin" };
const user = { id: "user", email: "user@example.test", role: "user" };
const adminPrefill = process.env.AGENT_FLOW_PRODUCTION_PREVIEW === "1"
  ? "" : loadEnv("development", process.cwd(), "VITE_").VITE_DEV_ADMIN_PASSWORD || "";

for (const width of [1440, 390, 320]) {
  test(`account switching and logout at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 960 });
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const identity = request.headers().authorization === "Bearer admin-token" ? admin : user;
      if (path === "/api/auth/me") {
        await route.fulfill({ json: identity });
      } else if (path === "/api/auth/signin") {
        if (request.postDataJSON().password === "wrong-password") {
          await route.fulfill({ status: 401, json: { detail: "Invalid email or password" } });
          return;
        }
        const signedIn = request.postDataJSON().email === admin.email ? admin : user;
        await route.fulfill({ json: {
          user: signedIn, accessToken: `${signedIn.id}-token`, refreshToken: `${signedIn.id}-refresh`,
        } });
      } else if (path === "/api/agent-flows") {
        await route.fulfill(identity.role === "admin"
          ? { json: { items: [{
            id: "private-flow", name: "管理员专属流程", publishedVersion: 1,
            enabled: false, updatedAt: "2026-10-07T00:00:00Z",
          }] } }
          : { status: 403, json: { detail: "仅管理员可以管理 Agent 流程" } });
      } else {
        await route.fulfill({ json: [] });
      }
    });
    await page.goto("/login");
    await page.evaluate(() => {
      localStorage.setItem("accessToken", "user-token");
      localStorage.setItem("refreshToken", "user-refresh");
    });
    await page.goto("/admin/cs/agent-flows");
    const nav = page.getByRole("navigation", { name: "账号导航" });
    await expect(nav).toContainText("普通用户");
    await expect(page.getByRole("alert")).toContainText("仅管理员可以管理 Agent 流程");
    const logout = nav.getByRole("button", { name: "退出登录" });
    await expect(logout).toBeInViewport();
    const switchAdmin = nav.getByRole("button", { name: "切换至管理员登录" });
    await expect(switchAdmin).toBeInViewport();
    expect(await nav.evaluate((element) => {
      const elements = Array.from(element.children).map((child) => child.getBoundingClientRect());
      return elements[0].right <= elements[1].left;
    })).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath(`account-${width}.png`) });
    await switchAdmin.click();
    await expect(page).toHaveURL((url) => url.pathname === "/login" &&
      url.searchParams.get("mode") === "admin" && url.searchParams.get("returnTo") === "/admin/cs/agent-flows");
    expect(await page.evaluate(() => [
      localStorage.getItem("accessToken"), localStorage.getItem("refreshToken"),
    ])).toEqual([null, null]);
    await expect(page.getByRole("tab", { name: "管理员", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel("Email", { exact: true })).toHaveValue("admin@agentforge.local");
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue(adminPrefill);
    await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "password");
    await page.getByRole("tab", { name: "普通用户" }).click();
    await expect(page.getByLabel("Email", { exact: true })).toHaveValue("default@agentforge.local");
    await page.getByRole("tab", { name: "管理员", exact: true }).click();
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue(adminPrefill);
    await page.reload();
    await expect(page).toHaveURL((url) => url.pathname === "/login" &&
      url.searchParams.get("mode") === "admin" && url.searchParams.get("returnTo") === "/admin/cs/agent-flows");
    await page.getByLabel("Password", { exact: true }).fill("wrong-password");
    await page.getByRole("button", { name: "管理员登录", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Invalid email or password");
    await page.getByLabel("Email", { exact: true }).fill(user.email);
    await page.getByLabel("Password", { exact: true }).fill("test-password");
    await page.getByRole("button", { name: "管理员登录", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("该账号不是管理员");
    expect(await page.evaluate(() => [
      localStorage.getItem("accessToken"), localStorage.getItem("refreshToken"),
    ])).toEqual([null, null]);
    await page.screenshot({ path: testInfo.outputPath(`admin-login-${width}.png`) });
    await page.getByLabel("Email", { exact: true }).fill(admin.email);
    await page.getByLabel("Password", { exact: true }).fill("test-password");
    await page.getByRole("button", { name: "管理员登录", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/cs\/agent-flows$/);
    await expect(nav).toContainText("管理员");
    await expect(switchAdmin).toHaveCount(0);
    await expect(page.getByRole("link", { name: "管理员专属流程", exact: true })).toBeVisible();
    await expect(logout).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`admin-account-${width}.png`) });

    await logout.click();
    await page.getByLabel("Email", { exact: true }).fill(user.email);
    await page.getByLabel("Password", { exact: true }).fill("test-password");
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(nav).toContainText("普通用户");
    await page.getByRole("link", { name: "Agent 流程", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("仅管理员可以管理 Agent 流程");
    await expect(page.getByRole("link", { name: "管理员专属流程", exact: true })).toHaveCount(0);
    if (width === 1440) await expect(nav).toContainText(user.email);
  });
}

test("logout remains available when identity loading fails", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({
    status: 503, json: { detail: "Temporarily unavailable" },
  }));
  await page.goto("/login");
  await page.evaluate(() => {
    localStorage.setItem("accessToken", "user-token");
    localStorage.setItem("refreshToken", "user-refresh");
  });
  await page.goto("/admin/cs/agent-flows");
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(await page.evaluate(() => [
    localStorage.getItem("accessToken"), localStorage.getItem("refreshToken"),
  ])).toEqual([null, null]);
});

for (const returnTo of ["https://example.test/admin/cs/agent-flows", "http://[invalid"]) {
  test(`admin login rejects unsafe return location: ${returnTo}`, async ({ page }) => {
    await page.route("**/api/**", async (route) => {
      if (new URL(route.request().url()).pathname === "/api/auth/signin") {
        await route.fulfill({ json: { user: admin, accessToken: "admin-token", refreshToken: "admin-refresh" } });
      } else if (new URL(route.request().url()).pathname === "/api/auth/me") {
        await route.fulfill({ json: admin });
      } else {
        await route.fulfill({ json: { items: [] } });
      }
    });
    const params = new URLSearchParams({ mode: "admin", returnTo });
    await page.goto(`/login?${params}`);
    await page.getByLabel("Password", { exact: true }).fill("test-password");
    await page.getByRole("button", { name: "管理员登录", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/cs\/agent-flows$/);
  });
}

test("real provisioned admin login from the normal-user panel", async ({ page }, testInfo) => {
  test.skip(!process.env.AGENT_FLOW_ADMIN_PASSWORD, "Set AGENT_FLOW_ADMIN_PASSWORD to test the provisioned account");
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill("default@agentforge.local");
  await page.getByLabel("Password", { exact: true }).fill("agentforge");
  await page.getByRole("button", { name: "Sign In" }).click();
  const nav = page.getByRole("navigation", { name: "账号导航" });
  await expect(nav).toContainText("普通用户");
  await page.getByRole("link", { name: "Agent 流程", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("仅管理员可以管理 Agent 流程");
  await nav.getByRole("button", { name: "切换至管理员登录" }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue(adminPrefill);
  if (!adminPrefill) await page.getByLabel("Password", { exact: true }).fill(process.env.AGENT_FLOW_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "管理员登录", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/cs\/agent-flows$/);
  await expect(nav).toContainText("admin@agentforge.local");
  await expect(nav).toContainText("管理员");
  await expect(page.getByRole("button", { name: "新建诊断流程" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("real-admin-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(nav.getByRole("button", { name: "退出登录" })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("real-admin-mobile.png") });
  await nav.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/login$/);
});
