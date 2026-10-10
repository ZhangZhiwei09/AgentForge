import { randomUUID } from "node:crypto";
import { Prisma, type EntryRouteFlow, type EntryRouteFlowRun } from "@prisma/client";
import type {
  EntryRouteDefinition, EntryRouteFlowDTO, EntryRouteRunDTO, EntryRouteRunPage,
} from "@agentforge/shared-types";
import { prisma } from "../../db.js";
import { logger } from "@agentforge/logger";
import { entryDefinitionSchema, EntryFlowError, parseEntryDefinition, validateEntryDefinition } from "./schema.js";
import { executeEntryFlow, type EntryExecution } from "./runtime.js";
import { defaultEntryTemplate, emptyEntryTemplate } from "./templates.js";
import { redactEntryText, redactEntryValue } from "./privacy.js";

type Database = typeof prisma;
export interface EntryPublishedSnapshot {
  flowId: string;
  version: number;
  definition: EntryRouteDefinition;
}
export interface EntryRunExecution extends EntryExecution {
  runId: string;
  flowId: string;
  version: number;
}

const json = (value: unknown) => value as Prisma.InputJsonValue;
const flowDTO = (flow: EntryRouteFlow): EntryRouteFlowDTO => ({
  ...flow, draft: flow.draft as unknown as EntryRouteDefinition,
  published: flow.published as unknown as EntryRouteDefinition | null,
  createdAt: flow.createdAt.toISOString(), updatedAt: flow.updatedAt.toISOString(),
});
const runDTO = (run: EntryRouteFlowRun): EntryRouteRunDTO => ({
  ...run,
  snapshot: redactEntryValue(run.snapshot) as EntryRouteDefinition,
  records: redactEntryValue(run.records) as EntryRouteRunDTO["records"],
  output: redactEntryValue(run.output) as EntryRouteRunDTO["output"],
  inputSummary: redactEntryText(run.inputSummary).slice(0, 2000),
  error: run.error ? redactEntryText(run.error).slice(0, 1000) : null,
  status: run.status as EntryRouteRunDTO["status"],
  createdAt: run.createdAt.toISOString(), updatedAt: run.updatedAt.toISOString(),
});

export class EntryRouteFlowService {
  constructor(private readonly db: Database = prisma) {}

  async list() {
    const items = await this.db.entryRouteFlow.findMany({ where: { archived: false }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }] });
    return { items: items.map(flowDTO) };
  }

  async create(name: string, actorId: string, template: "default" | "empty" = "default") {
    return flowDTO(await this.db.entryRouteFlow.create({
      data: { id: randomUUID(), name, draft: json(template === "default" ? defaultEntryTemplate() : emptyEntryTemplate()), updatedBy: actorId },
    }));
  }

  async get(id: string) {
    const flow = await this.db.entryRouteFlow.findUnique({ where: { id } });
    if (!flow) throw new EntryFlowError("流程不存在", 404);
    return flowDTO(flow);
  }

  private async locked<T>(
    id: string, change: (tx: Prisma.TransactionClient, flow: EntryRouteFlow) => Promise<T>, global = false,
  ): Promise<T> {
    return this.db.$transaction(async (tx) => {
      // Serialize global binding changes even when there is no active row to lock.
      if (global) await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('entry_route_flows_activation'))::text`;
      await tx.$queryRaw`SELECT id FROM entry_route_flows WHERE id = ${id} FOR UPDATE`;
      const flow = await tx.entryRouteFlow.findUnique({ where: { id } });
      if (!flow || flow.archived) throw new EntryFlowError("流程不存在或已归档", 404);
      return change(tx, flow);
    });
  }

  private checkRevision(flow: { draftRevision: number }, revision: number) {
    if (flow.draftRevision !== revision) throw new EntryFlowError("草稿已被其他页面修改，请重新加载后再操作", 409);
  }

  async save(id: string, name: string, revision: number, definition: unknown, actorId: string) {
    // Drafts may have incomplete connections. Structural bounds still apply.
    const parsed = entryDefinitionSchema.safeParse(definition);
    if (!parsed.success) throw new EntryFlowError("草稿字段校验失败", 400,
      parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })));
    return this.locked(id, async (tx, flow) => {
      this.checkRevision(flow, revision);
      return flowDTO(await tx.entryRouteFlow.update({
        where: { id }, data: { name, draft: json(parsed.data), draftRevision: { increment: 1 }, updatedBy: actorId },
      }));
    });
  }

  async validate(id: string, revision: number) {
    const flow = await this.get(id);
    if (flow.archived) throw new EntryFlowError("流程已归档", 404);
    this.checkRevision(flow, revision);
    return validateEntryDefinition(flow.draft);
  }

  async publish(id: string, revision: number, actorId: string) {
    return this.locked(id, async (tx, flow) => {
      this.checkRevision(flow, revision);
      const definition = parseEntryDefinition(flow.draft);
      return flowDTO(await tx.entryRouteFlow.update({
        where: { id }, data: {
          published: json(definition), publishedVersion: { increment: 1 },
          publishedRevision: revision, updatedBy: actorId,
        },
      }));
    });
  }

  async activate(id: string, enabled: boolean, actorId: string) {
    return this.locked(id, async (tx, flow) => {
      if (enabled) {
        if (!flow.published || !flow.publishedVersion) throw new EntryFlowError("请先发布流程", 400);
        parseEntryDefinition(flow.published);
        await tx.entryRouteFlow.updateMany({ where: { enabled: true, id: { not: id } }, data: { enabled: false, updatedBy: actorId } });
      }
      return flowDTO(await tx.entryRouteFlow.update({ where: { id }, data: { enabled, updatedBy: actorId } }));
    }, true);
  }

  async archive(id: string, actorId: string) {
    await this.locked(id, (tx) => tx.entryRouteFlow.update({
      where: { id }, data: { archived: true, enabled: false, updatedBy: actorId },
    }), true);
    return { ok: true };
  }

  async activeSnapshot(): Promise<EntryPublishedSnapshot | null> {
    try {
      const flow = await this.db.entryRouteFlow.findFirst({ where: { enabled: true } });
      if (!flow) return null;
      if (flow.archived || !flow.published || flow.publishedVersion < 1) throw new Error("Invalid active entry flow");
      return { flowId: flow.id, version: flow.publishedVersion, definition: parseEntryDefinition(flow.published) };
    } catch {
      throw new EntryFlowError("一级路由流程加载失败，请联系管理员检查配置或停用流程", 503);
    }
  }

  async execute(
    snapshot: EntryPublishedSnapshot,
    message: string,
    actorId: string,
    options: { signal?: AbortSignal; draftRevision?: number; conversationId?: string } = {},
  ): Promise<EntryRunExecution> {
    const started = Date.now();
    const runId = randomUUID();
    try {
      await this.db.entryRouteFlowRun.create({
        data: {
          id: runId, flowId: snapshot.flowId, version: snapshot.version,
          draftRevision: options.draftRevision, snapshot: json(redactEntryValue(snapshot.definition)),
          actorId, conversationId: options.conversationId, test: options.draftRevision !== undefined,
          inputSummary: redactEntryText(message).slice(0, 2000),
        },
      });
    } catch {
      throw new EntryFlowError("一级路由运行记录创建失败，请联系管理员", 503);
    }
    try {
      const execution = executeEntryFlow(snapshot.definition, message, options.signal);
      options.signal?.throwIfAborted();
      // Persist the decision before any downstream side effect.
      await this.db.entryRouteFlowRun.update({
        where: { id: runId }, data: {
          status: "completed", records: json(redactEntryValue(execution.records)),
          output: json(redactEntryValue(execution.result)), terminalNodeId: execution.terminalNodeId,
          durationMs: Date.now() - started,
        },
      });
      return { ...execution, flowId: snapshot.flowId, version: snapshot.version, runId };
    } catch (error) {
      try {
        await this.db.entryRouteFlowRun.update({
          where: { id: runId }, data: {
            status: options.signal?.aborted ? "cancelled" : "failed",
            error: redactEntryText(error instanceof Error ? error.message : "执行失败").slice(0, 1000),
            durationMs: Date.now() - started,
          },
        });
      } catch {
        logger.error({ runId }, "Failed to persist entry flow failure");
      }
      if (options.signal?.aborted) options.signal.throwIfAborted();
      if (error instanceof EntryFlowError) throw error;
      throw new EntryFlowError("一级路由决策或记录保存失败，请联系管理员", 503);
    }
  }

  async testRun(id: string, revision: number, message: string, actorId: string, signal?: AbortSignal) {
    // One DB read freezes the revision and graph together; publication can proceed independently.
    const flow = await this.get(id);
    if (flow.archived) throw new EntryFlowError("流程已归档", 404);
    this.checkRevision(flow, revision);
    const definition = parseEntryDefinition(flow.draft);
    const execution = await this.execute(
      { flowId: id, version: flow.publishedVersion, definition }, message, actorId,
      { draftRevision: revision, signal },
    );
    return this.getRun(id, execution.runId);
  }

  async linkAssistant(runId: string, assistantMessageId: string) {
    await this.db.entryRouteFlowRun.update({ where: { id: runId }, data: { assistantMessageId } });
  }

  async runs(id: string, page = 1, pageSize = 20): Promise<EntryRouteRunPage> {
    await this.get(id);
    const where = { flowId: id };
    const [items, total] = await this.db.$transaction([
      this.db.entryRouteFlowRun.findMany({
        where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize,
      }),
      this.db.entryRouteFlowRun.count({ where }),
    ]);
    return { items: items.map(runDTO), total, page, pageSize };
  }

  async getRun(id: string, runId: string) {
    const run = await this.db.entryRouteFlowRun.findFirst({ where: { id: runId, flowId: id } });
    if (!run) throw new EntryFlowError("运行记录不存在", 404);
    return runDTO(run);
  }
}

export const entryRouteFlowService = new EntryRouteFlowService();
