import { test, expect } from "@playwright/test";
import type { AgentFlowDefinition } from "@agentforge/shared-types";
import { flowFixture } from "./fixtures/agent-flow";

type VisibilityResult = { hiddenTransitions: number; blankFrames: number; detachedNodes: number; frames: number };
type MonitoredWindow = Window & { stopCanvasMonitor: () => VisibilityResult };

for (const width of [1440, 390]) {
  test(`dragging retains visible nodes and persists coordinates at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 960 });
    let flow = flowFixture();
    const original = structuredClone(flow.draft);
    let saved: AgentFlowDefinition | undefined;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/auth/me") {
        await route.fulfill({ json: { id: "canvas-admin", email: "canvas@example.test", role: "admin" } });
      } else if (path === "/api/agent-flows/tools") {
        await route.fulfill({ json: { tools: [] } });
      } else if (path === `/api/agent-flows/${flow.id}/draft` && request.method() === "PUT") {
        const body = request.postDataJSON() as { name: string; definition: AgentFlowDefinition };
        saved = body.definition;
        flow = { ...flow, name: body.name, draft: saved, draftRevision: flow.draftRevision + 1 };
        await route.fulfill({ json: flow });
      } else if (path === `/api/agent-flows/${flow.id}`) {
        await route.fulfill({ json: flow });
      } else {
        await route.fulfill({ json: { items: [] } });
      }
    });
    await page.addInitScript(() => localStorage.setItem("accessToken", "canvas-admin"));
    await page.goto(`/admin/cs/agent-flows/${flow.id}`);
    const nodes = page.locator(".react-flow__node");
    const backend = page.locator('.react-flow__node[data-id="backend"]');
    await expect(nodes).toHaveCount(original.nodes.length);
    for (const node of await nodes.all()) await expect(node).toBeVisible();
    await page.evaluate(() => new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

    await page.evaluate(() => {
      const canvas = document.querySelector(".af-canvas")!;
      const originalNodes = Array.from(canvas.querySelectorAll<HTMLElement>(".react-flow__node"));
      let active = true;
      let frame = 0;
      const result: VisibilityResult = { hiddenTransitions: 0, blankFrames: 0, detachedNodes: 0, frames: 0 };
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          const node = mutation.target as HTMLElement;
          if (node.matches(".react-flow__node") &&
              (node.style.visibility === "hidden" || /visibility:\s*hidden/.test(mutation.oldValue || ""))) {
            result.hiddenTransitions++;
          }
        }
      });
      observer.observe(canvas, {
        subtree: true, attributes: true, attributeFilter: ["style"], attributeOldValue: true,
      });
      function sample() {
        if (!active) return;
        result.frames++;
        const visible = originalNodes.filter((node) =>
          node.isConnected && getComputedStyle(node).visibility !== "hidden");
        if (!visible.length) result.blankFrames++;
        if (originalNodes.some((node) => !node.isConnected)) result.detachedNodes++;
        frame = requestAnimationFrame(sample);
      }
      frame = requestAnimationFrame(sample);
      (window as MonitoredWindow).stopCanvasMonitor = () => {
        active = false;
        cancelAnimationFrame(frame);
        observer.disconnect();
        return result;
      };
    });

    for (let drag = 0; drag < 3; drag++) {
      const box = (await backend.boundingBox())!;
      const bounds = (await page.locator(".af-canvas").boundingBox())!;
      const viewport = await page.locator(".react-flow__viewport").getAttribute("style");
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      const direction = x > bounds.x + bounds.width / 2 ? -1 : 1;
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let step = 1; step <= 12; step++) {
        await page.mouse.move(x + direction * step * 2, y);
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      }
      await expect(page.locator(".react-flow__viewport")).toHaveAttribute("style", viewport!);
      await page.mouse.up();
      await expect(backend).toBeVisible();
    }
    await expect(page.getByText("未保存", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("已保存");
    await page.evaluate(() => new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const visibility = await page.evaluate(() => (window as MonitoredWindow).stopCanvasMonitor());
    expect(visibility.hiddenTransitions).toBe(0);
    expect(visibility.blankFrames).toBe(0);
    expect(visibility.detachedNodes).toBe(0);
    expect(visibility.frames).toBeGreaterThan(12);
    expect(saved).toBeDefined();
    const moved = saved!.nodes.find((node) => node.id === "backend")!;
    expect(moved.position).not.toEqual(original.nodes.find((node) => node.id === "backend")!.position);
    expect(saved!.nodes.filter((node) => node.id !== "backend")).toEqual(original.nodes.filter((node) => node.id !== "backend"));
    expect(moved.role).toEqual(original.nodes.find((node) => node.id === "backend")!.role);
    expect(saved!.nodes.every((node) => !("measured" in node) && !("dragging" in node))).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath(`drag-${width}.png`), fullPage: true });

    await page.reload();
    await expect(backend).toBeVisible();
    await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
    await expect(page.getByText("未保存", { exact: true })).toHaveCount(0);
    const persisted = { ...moved.position };
    await backend.press("Space");
    await expect(backend).toHaveClass(/selected/);
    await backend.press("ArrowRight");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("已保存");
    expect(saved!.nodes.find((node) => node.id === "backend")!.position.x).toBeGreaterThan(persisted.x);
    expect(errors).toEqual([]);
  });
}
