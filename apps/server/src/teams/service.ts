// TeamService — main orchestrator for V9 Multi-Agent System
// Manages team CRUD, execution, and SSE streaming
import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import { logger } from "@agentforge/logger";
import { TeamExecutor } from "./executor.js";
import { CreateTeamSchema, TeamDefinitionSchema } from "./schema.js";
import { MessageBus } from "./message-bus.js";
import { Blackboard } from "./blackboard.js";
import { builtinTeamTemplates, getTeamTemplate } from "./templates.js";
import type {
  TeamDefinition,
  TeamDTO,
  TeamRunDTO,
  TeamTemplate,
  TeamStreamEvent,
} from "@agentforge/shared-types";
import type { ExecutionContext } from "./modes/types.js";

// ---- Types ----

interface PendingApproval {
  resolve: (decision: { action: "approved" | "rejected" | "timed_out"; modifiedArgs?: Record<string, unknown> }) => void;
  timeout: ReturnType<typeof setTimeout>;
  stepId: string;
}

// ---- TeamService ----

export class TeamService {
  private teamExecutor: TeamExecutor;
  private pendingApprovals: Map<string, PendingApproval> = new Map();

  constructor() {
    this.teamExecutor = new TeamExecutor();
  }

  // ========== CRUD ==========

  /** Create a new team */
  async create(userId: string, data: unknown): Promise<TeamDTO> {
    const parsed = CreateTeamSchema.parse(data);
    const id = randomUUID();

    const team = await prisma.agentTeam.create({
      data: {
        id,
        userId,
        name: parsed.name,
        description: parsed.description || null,
        definition: parsed.definition as object,
        status: "draft",
        tags: parsed.tags || [],
      },
    });

    return this.toDTO(team);
  }

  /** List teams for a user */
  async list(
    userId: string,
    options: { status?: string; mode?: string; page?: number; limit?: number } = {},
  ): Promise<{ items: TeamDTO[]; total: number; page: number }> {
    const page = options.page || 1;
    const limit = options.limit || 20;
    const where: Record<string, unknown> = { userId };

    if (options.status) {
      where.status = options.status;
    }

    const [teams, total] = await Promise.all([
      prisma.agentTeam.findMany({
        where: where as any,
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.agentTeam.count({ where: where as any }),
    ]);

    // Filter by mode if specified (mode is inside JSON definition)
    let items = teams.map((t) => this.toDTO(t));
    if (options.mode) {
      items = items.filter((t) => t.definition.collaborationMode === options.mode);
    }

    return { items, total, page };
  }

  /** Get a single team by ID */
  async get(teamId: string, userId: string): Promise<TeamDTO | null> {
    const team = await prisma.agentTeam.findFirst({
      where: { id: teamId, userId },
    });
    if (!team) return null;
    return this.toDTO(team);
  }

  /** Update a team definition */
  async update(
    teamId: string,
    userId: string,
    data: Record<string, unknown>,
  ): Promise<TeamDTO | null> {
    const team = await prisma.agentTeam.findFirst({
      where: { id: teamId, userId },
    });
    if (!team) return null;

    const updateData: Record<string, unknown> = {};

    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.tags !== undefined) updateData.tags = data.tags;
    if (data.status !== undefined) updateData.status = data.status;
    if (data.definition !== undefined) {
      TeamDefinitionSchema.parse(data.definition);
      updateData.definition = data.definition;
      updateData.version = { increment: 1 };
    }

    const updated = await prisma.agentTeam.update({
      where: { id: teamId },
      data: updateData,
    });

    return this.toDTO(updated);
  }

  /** Delete a team */
  async delete(teamId: string, userId: string): Promise<boolean> {
    const team = await prisma.agentTeam.findFirst({
      where: { id: teamId, userId },
    });
    if (!team) return false;

    await prisma.agentTeam.delete({ where: { id: teamId } });
    return true;
  }

  /** Validate a team definition without saving */
  validateDefinition(definition: unknown): { valid: boolean; errors?: Array<{ path: string; message: string }> } {
    const result = TeamDefinitionSchema.safeParse(definition);
    if (result.success) {
      return { valid: true };
    }
    const errors = result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    return { valid: false, errors };
  }

  // ========== Templates ==========

  /** List built-in team templates */
  listTemplates(): TeamTemplate[] {
    return [...builtinTeamTemplates];
  }

  /** Get a specific template */
  getTemplate(id: string): TeamTemplate | undefined {
    return getTeamTemplate(id);
  }

  /** Create a team from a template */
  async createFromTemplate(userId: string, templateId: string, overrides?: { name?: string; description?: string }): Promise<TeamDTO | null> {
    const template = getTeamTemplate(templateId);
    if (!template) return null;

    return this.create(userId, {
      name: overrides?.name || template.name,
      description: overrides?.description || template.description,
      definition: template.definition,
      tags: [template.category],
    });
  }

  // ========== Execution ==========

  /** Run a team and stream events */
  async *runTeam(
    teamId: string,
    userId: string,
    task: string,
    inputVariables?: Record<string, unknown>,
    conversationId?: string,
  ): AsyncGenerator<TeamStreamEvent> {
    const startTime = Date.now();
    const team = await prisma.agentTeam.findFirst({
      where: { id: teamId, userId },
    });
    if (!team) {
      yield { type: "team_failed", error: "Team not found" };
      return;
    }

    const definition = team.definition as unknown as TeamDefinition;

    // Create run record
    const runId = randomUUID();

    const run = await prisma.agentTeamRun.create({
      data: {
        id: runId,
        teamId,
        userId,
        conversationId: conversationId || null,
        task,
        status: "running",
        mode: definition.collaborationMode,
        messages: [],
        blackboard: {},
      },
    });

    // Set up context
    const bus = new MessageBus(runId);
    const bb = new Blackboard();

    const context: ExecutionContext = {
      teamRunId: runId,
      conversationId: conversationId || "",
      userId,
      definition,
      bus,
      blackboard: bb,
      variables: inputVariables || {},
    };

    // Subscribe to all messages to persist them
    let eventCount = 0;
    bus.subscribeAll((msg) => {
      eventCount++;
    });

    let roundsCount = 0;
    let failed = false;

    try {
      for await (const event of this.teamExecutor.execute(definition, task, context)) {
        // Count rounds
        if (event.type === "team_round_start") {
          roundsCount++;
        }

        // Track failure
        if (event.type === "team_failed") {
          failed = true;
        }

        // Persist checkpoint periodically (every 10 events)
        if (eventCount > 0 && eventCount % 10 === 0) {
          await this.updateRunCheckpoint(runId, bus, bb, roundsCount);
        }

        yield event;
      }
    } catch (err) {
      failed = true;
      const errorMsg = err instanceof Error ? err.message : "Unknown error";

      await prisma.agentTeamRun.update({
        where: { id: runId },
        data: {
          status: "failed",
          error: errorMsg,
          messages: bus.serialize() as object[],
          blackboard: bb.serialize() as object,
          roundsCount,
          durationMs: Date.now() - startTime,
          completedAt: new Date(),
        },
      });

      yield { type: "team_failed", error: errorMsg };
      return;
    }

    // Finalize run
    const durationMs = Date.now() - startTime;

    await prisma.agentTeamRun.update({
      where: { id: runId },
      data: {
        status: failed ? "failed" : "completed",
        messages: bus.serialize() as object[],
        blackboard: bb.serialize() as object,
        output: bb.serialize() as object,
        roundsCount,
        durationMs,
        completedAt: new Date(),
      },
    });

    await prisma.agentTeam.update({
      where: { id: teamId },
      data: { runCount: { increment: 1 }, lastRunAt: new Date() },
    });
  }

  /** Update checkpoint data during a run */
  private async updateRunCheckpoint(
    runId: string,
    bus: MessageBus,
    bb: Blackboard,
    roundsCount: number,
  ): Promise<void> {
    try {
      await prisma.agentTeamRun.update({
        where: { id: runId },
        data: {
          messages: bus.serialize() as object[],
          blackboard: bb.serialize() as object,
          roundsCount,
          checkpoint: {
            messages: bus.serialize(),
            blackboard: bb.serialize(),
            roundsCount,
            timestamp: new Date().toISOString(),
          } as object,
        },
      });
    } catch {
      // Non-critical — don't fail the run for checkpoint save failure
    }
  }

  // ========== Run Control ==========

  /** Cancel a running team */
  async cancelRun(runId: string, userId: string): Promise<TeamRunDTO | null> {
    const run = await prisma.agentTeamRun.findFirst({
      where: { id: runId, userId },
    });
    if (!run || (run.status !== "running" && run.status !== "paused")) return null;

    const updated = await prisma.agentTeamRun.update({
      where: { id: runId },
      data: {
        status: "cancelled",
        completedAt: new Date(),
      },
    });

    return this.runToDTO(updated);
  }

  /** Pause a running team */
  async pauseRun(runId: string, userId: string): Promise<TeamRunDTO | null> {
    const run = await prisma.agentTeamRun.findFirst({
      where: { id: runId, userId },
    });
    if (!run || run.status !== "running") return null;

    const updated = await prisma.agentTeamRun.update({
      where: { id: runId },
      data: { status: "paused" },
    });

    return this.runToDTO(updated);
  }

  // ========== Run History ==========

  /** List runs for a team */
  async listRuns(
    teamId: string,
    userId: string,
    options: { status?: string; page?: number; limit?: number } = {},
  ): Promise<{ items: TeamRunDTO[]; total: number; page: number }> {
    const page = options.page || 1;
    const limit = options.limit || 20;
    const where: Record<string, unknown> = { teamId, userId };

    if (options.status) {
      where.status = options.status;
    }

    const [runs, total] = await Promise.all([
      prisma.agentTeamRun.findMany({
        where: where as any,
        orderBy: { startedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.agentTeamRun.count({ where: where as any }),
    ]);

    return {
      items: runs.map((r) => this.runToDTO(r)),
      total,
      page,
    };
  }

  /** Get a single run with messages */
  async getRun(runId: string, userId: string): Promise<TeamRunDTO | null> {
    const run = await prisma.agentTeamRun.findFirst({
      where: { id: runId, userId },
    });
    if (!run) return null;
    return this.runToDTO(run);
  }

  // ========== Helpers ==========

  private toDTO(t: any): TeamDTO {
    return {
      id: t.id,
      userId: t.userId,
      name: t.name,
      description: t.description || undefined,
      definition: t.definition as unknown as TeamDefinition,
      version: t.version,
      status: t.status,
      tags: t.tags || [],
      runCount: t.runCount || 0,
      lastRunAt: t.lastRunAt?.toISOString(),
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    };
  }

  private runToDTO(r: any): TeamRunDTO {
    return {
      id: r.id,
      teamId: r.teamId,
      userId: r.userId,
      conversationId: r.conversationId || undefined,
      task: r.task,
      status: r.status,
      mode: r.mode,
      messages: (r.messages as any[]) || [],
      blackboard: (r.blackboard as Record<string, unknown>) || {},
      checkpoint: r.checkpoint || undefined,
      output: (r.output as Record<string, unknown>) || undefined,
      error: r.error || undefined,
      roundsCount: r.roundsCount || 0,
      durationMs: r.durationMs || undefined,
      startedAt: r.startedAt.toISOString(),
      completedAt: r.completedAt?.toISOString(),
    };
  }
}

// Singleton
export const teamService = new TeamService();
