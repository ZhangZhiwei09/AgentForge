import { beforeEach, describe, expect, it, vi } from "vitest";
import { EntryRouteFlowService } from "../service.js";
import { emptyEntryTemplate } from "../templates.js";

const { db } = vi.hoisted(() => ({
  db: {
    entryRouteFlow: { findFirst: vi.fn() },
    entryRouteFlowRun: { create: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("../../../db.js", () => ({ prisma: db }));
const service = new EntryRouteFlowService();
const snapshot = { flowId: "flow-1", version: 1, definition: emptyEntryTemplate() };
beforeEach(() => {
  vi.resetAllMocks();
  db.entryRouteFlowRun.create.mockResolvedValue({});
  db.entryRouteFlowRun.update.mockResolvedValue({});
});
describe("entry decisions and record failures", () => {
  it("distinguishes no active flow from unavailable or corrupt configuration", async () => {
    db.entryRouteFlow.findFirst.mockResolvedValueOnce(null);
    expect(await service.activeSnapshot()).toBeNull();
    db.entryRouteFlow.findFirst.mockRejectedValueOnce(new Error("db down"));
    await expect(service.activeSnapshot()).rejects.toMatchObject({ status: 503 });
    db.entryRouteFlow.findFirst.mockResolvedValueOnce({ id: "flow-1", publishedVersion: 1, published: { bad: true } });
    await expect(service.activeSnapshot()).rejects.toMatchObject({ status: 503 });
  });
  it("saves a bounded redacted record before returning raw decision", async () => {
    const execution = await service.execute(snapshot, `password=secret ${"x".repeat(3000)}`, "actor");
    const saved = db.entryRouteFlowRun.create.mock.calls[0][0].data;
    expect(saved.inputSummary.length).toBe(2000);
    expect(saved.inputSummary).not.toContain("secret");
    expect(db.entryRouteFlowRun.update.mock.calls[0][0].data).toMatchObject({ status: "completed", output: { action: "continue" }, terminalNodeId: "fallback" });
    expect(execution.result).toEqual({ action: "continue" });
  });
  it("fails explicitly when decision persistence fails, then marks failure", async () => {
    db.entryRouteFlowRun.update.mockRejectedValueOnce(new Error("write error"));
    await expect(service.execute(snapshot, "hi", "actor")).rejects.toMatchObject({ status: 503 });
    expect(db.entryRouteFlowRun.update.mock.calls[1][0].data.status).toBe("failed");
  });
  it("does not evaluate when initial run persistence fails", async () => {
    db.entryRouteFlowRun.create.mockRejectedValueOnce(new Error("db down"));
    await expect(service.execute(snapshot, "hi", "actor")).rejects.toThrow();
    expect(db.entryRouteFlowRun.update).not.toHaveBeenCalled();
  });
  it("marks cancellation rather than a completed decision", async () => {
    const abort = new AbortController();
    db.entryRouteFlowRun.create.mockImplementationOnce(async () => { abort.abort(); return {}; });
    await expect(service.execute(snapshot, "hi", "actor", { signal: abort.signal })).rejects.toThrow();
    expect(db.entryRouteFlowRun.update.mock.calls[0][0].data.status).toBe("cancelled");
  });
});
