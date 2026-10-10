import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { EntryRouteFlowService } from "../service.js";

const url = process.env.ENTRY_FLOW_TEST_DATABASE_URL;
const db = new PrismaClient({ datasourceUrl: url ?? process.env.DATABASE_URL });
const service = new EntryRouteFlowService(db);
const actor = randomUUID();

describe.skipIf(!url)("entry flow isolated database invariants", () => {
  beforeEach(async () => {
    await db.entryRouteFlowRun.deleteMany();
    await db.entryRouteFlow.deleteMany();
  });
  afterAll(async () => { await db.$disconnect(); });

  it("creates inactive drafts, requires publication, archives without losing history", async () => {
    const flow = await service.create("test", actor);
    expect(flow.enabled).toBe(false); expect(flow.published).toBeNull();
    await expect(service.activate(flow.id, true, actor)).rejects.toMatchObject({ status: 400 });
    const run = await service.testRun(flow.id, 1, "你好", actor);
    expect(run.test).toBe(true); expect(run.status).toBe("completed"); expect(run.output?.action).toBe("reply");
    expect(await service.activeSnapshot()).toBeNull();
    await service.archive(flow.id, actor);
    expect((await service.list()).items).toHaveLength(0);
    expect((await service.getRun(flow.id, run.id)).status).toBe("completed");
    await expect(service.publish(flow.id, 1, actor)).rejects.toMatchObject({ status: 404 });
  });
  it("serializes concurrent saves and rejects every stale operation", async () => {
    const flow = await service.create("save", actor, "empty");
    const saved = await Promise.allSettled([
      service.save(flow.id, "tab one", 1, flow.draft, actor),
      service.save(flow.id, "tab two", 1, flow.draft, actor),
    ]);
    expect(saved.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failed = saved.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason.status).toBe(409);
    await expect(service.validate(flow.id, 1)).rejects.toMatchObject({ status: 409 });
    await expect(service.testRun(flow.id, 1, "hello", actor)).rejects.toMatchObject({ status: 409 });
    await expect(service.publish(flow.id, 1, actor)).rejects.toMatchObject({ status: 409 });
    const latest = await service.get(flow.id);
    expect(latest.draftRevision).toBe(2);
  });
  it("enforces one global binding under concurrent activation", async () => {
    const a = await service.create("a", actor, "empty");
    const b = await service.create("b", actor, "empty");
    await service.publish(a.id, 1, actor); await service.publish(b.id, 1, actor);
    await Promise.all([service.activate(a.id, true, actor), service.activate(b.id, true, actor)]);
    const active = await db.entryRouteFlow.findMany({ where: { enabled: true } });
    expect(active).toHaveLength(1);
    const other = active[0].id === a.id ? b.id : a.id;
    await expect(db.entryRouteFlow.update({ where: { id: other }, data: { enabled: true } })).rejects.toMatchObject({ code: "P2002" });
  });
  it("freezes published snapshots across saves, republish and disable", async () => {
    const flow = await service.create("snapshots", actor);
    await service.publish(flow.id, 1, actor); await service.activate(flow.id, true, actor);
    const first = (await service.activeSnapshot())!;
    const draft = structuredClone(flow.draft);
    const node = draft.nodes.find((item) => item.id === "greeting_result");
    if (node?.type !== "reply") throw new Error();
    node.answer = "published version two";
    const saved = await service.save(flow.id, flow.name, 1, draft, actor);
    expect((await service.activeSnapshot())?.version).toBe(1);
    await service.publish(flow.id, saved.draftRevision, actor);
    const second = (await service.activeSnapshot())!;
    expect(second.version).toBe(2);
    await service.activate(flow.id, false, actor);
    expect(await service.activeSnapshot()).toBeNull();
    const old = await service.execute(first, "你好", actor, { conversationId: randomUUID() });
    const next = await service.execute(second, "你好", actor);
    expect(old.result).toMatchObject({ action: "reply", answer: expect.stringContaining("AgentForge") });
    expect(next.result).toMatchObject({ action: "reply", answer: "published version two" });
    const oldRun = await service.getRun(flow.id, old.runId);
    expect(oldRun.version).toBe(1); expect(oldRun.snapshot).toEqual(first.definition);
    expect(oldRun.test).toBe(false);
    const messageId = randomUUID(); await service.linkAssistant(old.runId, messageId);
    expect((await service.getRun(flow.id, old.runId)).assistantMessageId).toBe(messageId);
  });
  it("does not enable another flow by publishing and supports bounded pagination and run ownership", async () => {
    const a = await service.create("a", actor, "empty");
    const b = await service.create("b", actor, "empty");
    await service.publish(a.id, 1, actor); await service.activate(a.id, true, actor);
    await service.publish(b.id, 1, actor);
    expect((await service.activeSnapshot())?.flowId).toBe(a.id);
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await service.testRun(b.id, 1, `test ${i}`, actor));
    expect((await service.runs(b.id, 1, 2)).items).toHaveLength(2);
    expect((await service.runs(b.id, 2, 2)).items).toHaveLength(1);
    expect((await service.runs(b.id, 1, 2)).total).toBe(3);
    await expect(service.getRun(a.id, runs[0].id)).rejects.toMatchObject({ status: 404 });
  });
  it("permits incomplete draft saves but rejects publication and test execution", async () => {
    const flow = await service.create("incomplete", actor);
    const draft = structuredClone(flow.draft); draft.edges.pop();
    const saved = await service.save(flow.id, flow.name, 1, draft, actor);
    expect((await service.validate(flow.id, saved.draftRevision)).valid).toBe(false);
    await expect(service.publish(flow.id, saved.draftRevision, actor)).rejects.toMatchObject({ status: 400 });
    await expect(service.testRun(flow.id, saved.draftRevision, "hello", actor)).rejects.toMatchObject({ status: 400 });
    expect(await db.entryRouteFlowRun.count()).toBe(0);
  });
});
