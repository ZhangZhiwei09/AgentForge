import { test, expect } from "@playwright/test";
import { applyNodeChanges } from "@xyflow/react";
import { syncEntryCanvas, commitEntryPositions } from "../src/components/entry-route-flows/canvas-state";
import { entryFlowFixture } from "./fixtures/entry-route-flow";

test("entry drag state preserves dimensions and commits only finished positions", () => {
  const definition = entryFlowFixture().draft;
  const nodes = applyNodeChanges(definition.nodes.map((node) => ({
    type: "dimensions" as const, id: node.id, dimensions: { width: 210, height: 112 },
  })), syncEntryCanvas([], definition, null, new Set(), new Set()));
  expect(syncEntryCanvas(nodes, definition, null, new Set(), new Set())).toBe(nodes);
  const changes = [{ type: "position" as const, id: "condition", position: { x: 300, y: 200 }, dragging: true }];
  expect(commitEntryPositions(definition, changes)).toBe(definition);
  const moved = syncEntryCanvas(applyNodeChanges(changes, nodes), definition, "condition", new Set(), new Set());
  expect(moved.find((node) => node.id === "condition")?.position).toEqual({ x: 300, y: 200 });
  expect(moved.every((node) => node.measured?.width === 210)).toBeTruthy();
  const committed = commitEntryPositions(definition, [{ ...changes[0], dragging: false }]);
  expect(committed.nodes[1].position).toEqual({ x: 300, y: 200 });
  expect(committed.nodes[0]).toBe(definition.nodes[0]);
  expect(committed.edges).toBe(definition.edges);
  expect(committed.nodes.every((node) => !("measured" in node) && !("dragging" in node))).toBeTruthy();
});

for (const width of [1440, 390]) {
  test(`entry canvas remains visible and viewport stable during drag at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 960 });
    let flow = entryFlowFixture();
    const original = structuredClone(flow.draft);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/auth/me") await route.fulfill({ json: { id: "admin", role: "admin", email: "admin@example.test" } });
      else if (path.endsWith("/draft")) {
        const body = route.request().postDataJSON();
        flow = { ...flow, draft: body.definition, name: body.name, draftRevision: flow.draftRevision + 1 };
        await route.fulfill({ json: flow });
      } else if (path === `/api/entry-route-flows/${flow.id}`) await route.fulfill({ json: flow });
      else await route.fulfill({ json: { items: [] } });
    });
    await page.addInitScript(() => localStorage.setItem("accessToken", "admin"));
    await page.goto(`/admin/cs/entry-route-flows/${flow.id}`);
    const node = page.locator('.react-flow__node[data-id="condition"]');
    await expect(page.locator(".react-flow__node")).toHaveCount(4);
    await expect(node).toBeVisible();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(".react-flow__node"));
      const monitor = { frames: 0, hidden: 0, detached: 0, stop: false };
      Object.assign(window, { entryDragMonitor: monitor });
      function sample() {
        if (monitor.stop) return;
        monitor.frames++;
        if (nodes.some((item) => getComputedStyle(item).visibility === "hidden")) monitor.hidden++;
        if (nodes.some((item) => !item.isConnected)) monitor.detached++;
        requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    });
    for (let drag = 0; drag < 3; drag++) {
      const box = (await node.boundingBox())!;
      const viewport = await page.locator(".react-flow__viewport").getAttribute("style");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      for (let step = 1; step <= 12; step++) {
        await page.mouse.move(box.x + box.width / 2 + step * 2, box.y + box.height / 2);
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      }
      await page.mouse.up();
      await expect(page.locator(".react-flow__viewport")).toHaveAttribute("style", viewport!);
      await expect(node).toBeVisible();
    }
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("已保存");
    const monitor = await page.evaluate(() => {
      const state = (window as unknown as { entryDragMonitor: { frames: number; hidden: number; detached: number; stop: boolean } }).entryDragMonitor;
      state.stop = true; return state;
    });
    expect(monitor.frames).toBeGreaterThan(12); expect(monitor.hidden).toBe(0); expect(monitor.detached).toBe(0);
    expect(flow.draft.nodes[1].position).not.toEqual(original.nodes[1].position);
    expect(flow.draft.edges).toEqual(original.edges);
    await page.screenshot({ path: info.outputPath(`entry-drag-${width}.png`) });
    await page.reload(); await expect(node).toBeVisible();
    expect(errors).toEqual([]);
  });
}
