// Agent session persistence — save/load/get agent sessions to/from the database
import { prisma } from "../../db.js";
import { Prisma } from "@agentforge/database";
import { logger } from "@agentforge/logger";
import type { AgentStep } from "@agentforge/shared-types";

/**
 * Type-narrow Prisma error codes without relying on any-casted error shapes.
 * P2021 = table does not exist (migration not yet applied — graceful degrade).
 */
function isPrismaErrorCode(err: unknown, code: string): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === code;
}

/**
 * Represents an in-memory session record used for tracking during a ReAct loop.
 * Mirrors the AgentSession DB model fields that are used in business logic.
 */
export interface SessionRecord {
  id: string;
  conversationId: string;
  task: string;
  status: string;
  scratchpad: AgentStep[];
  finalSummary: string | null;
  startedAt: Date;
  completedAt: Date | null;
}

/**
 * Create a new session record object used by saveSession across all loop methods.
 */
export function createSessionRecord(
  id: string,
  conversationId: string,
  task: string,
): SessionRecord {
  return {
    id,
    conversationId,
    task,
    status: "running",
    scratchpad: [],
    finalSummary: null,
    startedAt: new Date(),
    completedAt: null,
  };
}

/**
 * Save the agent session to the database (upsert pattern).
 * Also syncs the in-memory record for external tracking.
 */
export async function saveSession(
  record: SessionRecord,
  scratchpad: AgentStep[],
  status: "running" | "paused" | "completed" | "failed",
  finalSummary: string | null,
  compressedSummary?: string,
): Promise<void> {
  try {
    const completedAt =
      status === "completed" || status === "failed" ? new Date() : null;

    await prisma.agentSession.upsert({
      where: { id: record.id },
      create: {
        id: record.id,
        conversationId: record.conversationId,
        task: record.task,
        status,
        scratchpad: scratchpad as unknown as object,
        finalSummary,
        compressedSummary: compressedSummary ?? null,
        startedAt: record.startedAt,
        completedAt,
      },
      update: {
        status,
        scratchpad: scratchpad as unknown as object,
        finalSummary,
        compressedSummary: compressedSummary ?? null,
        completedAt,
      },
    });

    // Sync the in-memory record for external tracking
    record.status = status;
    record.scratchpad = scratchpad;
    record.finalSummary = finalSummary;
    record.completedAt = completedAt;
  } catch (err) {
    if (isPrismaErrorCode(err, "P2021")) {
      logger.warn({ err }, "AgentSession table does not exist yet, skipping save");
    } else {
      logger.error({ err }, "Failed to save agent session");
    }
  }
}

/**
 * Get agent sessions for a conversation.
 */
export async function getSessions(conversationId: string): Promise<
  Array<{
    id: string;
    conversationId: string;
    task: string;
    status: string;
    scratchpad: AgentStep[];
    finalSummary: string | null;
    startedAt: Date;
    completedAt: Date | null;
  }>
> {
  try {
    const sessions = await prisma.agentSession.findMany({
      where: { conversationId },
      orderBy: { startedAt: "desc" },
    });

    return sessions.map((s) => ({
      id: s.id,
      conversationId: s.conversationId,
      task: s.task,
      status: s.status,
      scratchpad: (s.scratchpad as unknown as AgentStep[]) || [],
      finalSummary: s.finalSummary,
      startedAt: s.startedAt,
      completedAt: s.completedAt,
    }));
  } catch (err: unknown) {
    if (isPrismaErrorCode(err, "P2021")) {
      logger.warn({ err }, "AgentSession table does not exist yet");
      return [];
    }
    logger.error({ err }, "Failed to query agent sessions");
    throw err;
  }
}

/**
 * Get a single agent session by ID.
 */
export async function getSession(id: string): Promise<{
  id: string;
  conversationId: string;
  task: string;
  status: string;
  scratchpad: AgentStep[];
  finalSummary: string | null;
  startedAt: Date;
  completedAt: Date | null;
} | null> {
  try {
    const s = await prisma.agentSession.findUnique({ where: { id } });
    if (!s) return null;

    return {
      id: s.id,
      conversationId: s.conversationId,
      task: s.task,
      status: s.status,
      scratchpad: (s.scratchpad as unknown as AgentStep[]) || [],
      finalSummary: s.finalSummary,
      startedAt: s.startedAt,
      completedAt: s.completedAt,
    };
  } catch (err: unknown) {
    if (isPrismaErrorCode(err, "P2021")) {
      logger.warn({ err, sessionId: id }, "AgentSession table does not exist yet");
      return null;
    }
    logger.error({ err, sessionId: id }, "Failed to query agent session");
    throw err;
  }
}
