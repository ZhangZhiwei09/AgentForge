import { test, expect, type Page } from "@playwright/test";
import { flowFixture } from "./fixtures/agent-flow";
import { entryFlowFixture } from "./fixtures/entry-route-flow";

async function mockFlows(page: Page, options: { role?: string; agentError?: boolean } = {}) {
  const agent = { ...flowFixture(), name: "核身诊断流程" };
  const entry = { ...entryFlowFixture(), name: "问候与业务分流" };
  const requests: Array<{ path: string; method: string; data?: unknown }> = [];
  let agents = [agent], entries = [entry];
  await page.addInitScript(() => localStorage.setItem("accessToken", "flow-management-token"));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    requests.push({ path, method, data: request.postData() ? request.postDataJSON() : undefined });
    if (path === "/api/auth/me") {
      await route.fulfill({ json: { id: "flow-management-admin", email: "admin@example.test", role: options.role ?? "admin" } });
    } else if (path === "/api/agent-flows" || path === "/api/entry-route-flows") {
      const isEntry = path === "/api/entry-route-flows";
      if (method === "POST") {
        const created = { ...(isEntry ? entry : agent), name: request.postDataJSON().name };
        if (isEntry) entries = [{ ...entry, name: created.name }];
        else agents = [{ ...agent, name: created.name }];
        await route.fulfill({ json: created });
      } else if (!isEntry && options.agentError) {
        await route.fulfill({ status: 502, json: { detail: "诊断后端暂不可用" } });
      } else {
        await route.fulfill({ json: { items: isEntry ? entries : agents } });
      }
    } else if (path === `/api/agent-flows/${agent.id}`) {
      await route.fulfill({ json: agents[0] });
    } else if (path === `/api/entry-route-flows/${entry.id}`) {
      await route.fulfill({ json: entries[0] });
    } else {
      await route.fulfill({ json: { items: [] } });
    }
  });
  return { agent, entry, requests };
}

for (const width of [1440, 390, 320]) {
  test(`unified flow list, editor navigation and layout at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 960 });
    const { agent, entry } = await mockFlows(page);
    await page.goto("/admin/cs/entry-route-flows");
    await expect(page).toHaveURL(/\/admin\/cs\/agent-flows$/);
    const navigation = page.getByRole("navigation", { name: "管理模块" });
    const flowLink = navigation.getByRole("link", { name: "Agent 流程", exact: true });
    await expect(flowLink).toHaveAttribute("aria-current", "page");
    await expect(navigation.getByRole("link", { name: "一级路由流程" })).toHaveCount(0);
    await expect(page.locator(".af-table .af-flow-kind")).toHaveText(["一级路由流程", "Agent 流程"]);
    await expect(page.getByRole("link", { name: agent.name, exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: entry.name, exact: true })).toBeVisible();
    await expect(page.getByLabel("流程类型", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "新建诊断流程" })).toBeInViewport();
    if (width <= 390) {
      const nameBox = (await page.getByRole("link", { name: entry.name, exact: true }).boundingBox())!;
      expect(nameBox.width).toBeGreaterThan(150);
      expect(nameBox.height).toBeLessThan(40);
    }
    await page.screenshot({ path: info.outputPath(`flow-management-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await page.getByRole("link", { name: entry.name, exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(4);
    await expect(flowLink).toHaveAttribute("aria-current", "page");
    await page.getByRole("link", { name: "返回流程列表" }).click();
    await expect(page).toHaveURL(/\/admin\/cs\/agent-flows$/);
    await page.getByRole("link", { name: agent.name, exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(7);
    await page.getByRole("link", { name: "返回流程列表" }).click();
    await expect(page.getByRole("link", { name: entry.name, exact: true })).toBeVisible();
  });
}

test("one creation form selects the correct flow API and entry template", async ({ page }) => {
  const { requests } = await mockFlows(page);
  await page.goto("/admin/cs/agent-flows");
  await page.getByLabel("流程类型", { exact: true }).selectOption("entry");
  await expect(page.getByLabel("新流程名称")).toHaveValue("一级路由流程");
  await page.getByLabel("初始模板").selectOption("empty");
  await page.getByLabel("新流程名称").fill("新的一级路由");
  await page.getByRole("button", { name: "新建一级流程" }).click();
  await expect(page).toHaveURL(/\/entry-route-flows\/[^/]+$/);
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  expect(requests.find((item) => item.path === "/api/entry-route-flows" && item.method === "POST")?.data)
    .toEqual({ name: "新的一级路由", template: "empty" });
  await page.getByRole("link", { name: "返回流程列表" }).click();
  await expect(page.getByLabel("流程类型", { exact: true })).toHaveValue("agent");
  await page.getByLabel("新流程名称").fill("新的诊断流程");
  await page.getByRole("button", { name: "新建诊断流程" }).click();
  await expect(page).toHaveURL(/\/agent-flows\/[^/]+$/);
  await expect(page.locator(".react-flow__node")).toHaveCount(7);
  expect(requests.find((item) => item.path === "/api/agent-flows" && item.method === "POST")?.data)
    .toEqual({ name: "新的诊断流程" });
});

test("entry flows remain usable when the diagnosis listing fails", async ({ page }) => {
  const { entry } = await mockFlows(page, { agentError: true });
  await page.goto("/admin/cs/agent-flows");
  await expect(page.getByRole("alert")).toContainText("Agent 流程：诊断后端暂不可用");
  await expect(page.getByRole("link", { name: entry.name, exact: true })).toBeVisible();
  await page.getByRole("link", { name: entry.name, exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
});

test("ordinary users cannot load either flow collection or create flows", async ({ page }) => {
  const { requests } = await mockFlows(page, { role: "user" });
  for (const path of ["/admin/cs/agent-flows", "/admin/cs/entry-route-flows"]) {
    await page.goto(path);
    await expect(page.getByRole("alert")).toHaveText("仅管理员可以访问管理页面");
    await expect(page.getByRole("navigation", { name: "管理模块" })).toHaveCount(0);
    await expect(page.getByLabel("流程类型", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /新建(诊断|一级)流程/ })).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
  }
  expect(requests.filter((item) =>
    item.path === "/api/agent-flows" || item.path === "/api/entry-route-flows")).toEqual([]);
});
