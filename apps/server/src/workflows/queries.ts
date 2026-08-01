// Workflow queries — Prisma query encapsulation for WorkflowService
import { prisma } from "../db.js";
import type { Prisma } from "@agentforge/database";

// ---- Type Aliases ----

type WorkflowRecord = Prisma.WorkflowGetPayload<Record<string, never>>;
type WorkflowRunRecord = Prisma.WorkflowRunGetPayload<Record<string, never>>;
type WorkflowStepLogRecord = Prisma.WorkflowStepLogGetPayload<Record<string, never>>;

// ---- Single-Record Lookups ----

/** Find a workflow by ID, scoped to a user */
export async function findWorkflowById(
  id: string,
  userId: string,
): Promise<WorkflowRecord | null> {
  return prisma.workflow.findFirst({ where: { id, userId } });
}

/** Find a workflow run by ID, scoped to a user */
export async function findRunById(
  runId: string,
  userId: string,
): Promise<WorkflowRunRecord | null> {
  return prisma.workflowRun.findFirst({ where: { id: runId, userId } });
}

// ---- Paginated List Queries ----

/** List workflows with pagination — `where` must already include `userId` */
export async function listWorkflows(
  where: Prisma.WorkflowWhereInput,
  page: number,
  limit: number,
): Promise<[WorkflowRecord[], number]> {
  const offset = (page - 1) * limit;
  return Promise.all([
    prisma.workflow.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: offset,
      take: limit,
    }),
    prisma.workflow.count({ where }),
  ]);
}

/** List runs for a workflow with pagination — `where` must already include `workflowId` and `userId` */
export async function listRunsForWorkflow(
  where: Prisma.WorkflowRunWhereInput,
  page: number,
  limit: number,
): Promise<[WorkflowRunRecord[], number]> {
  const offset = (page - 1) * limit;
  return Promise.all([
    prisma.workflowRun.findMany({
      where,
      orderBy: { startedAt: "desc" },
      skip: offset,
      take: limit,
    }),
    prisma.workflowRun.count({ where }),
  ]);
}

// ---- Composite Queries ----

/** Find a run and its step logs, scoped to a user */
export async function findRunWithLogs(
  runId: string,
  userId: string,
): Promise<{
  run: WorkflowRunRecord;
  stepLogs: WorkflowStepLogRecord[];
} | null> {
  const run = await prisma.workflowRun.findFirst({
    where: { id: runId, userId },
  });
  if (!run) return null;

  const stepLogs = await prisma.workflowStepLog.findMany({
    where: { runId },
    orderBy: { startedAt: "asc" },
  });

  return { run, stepLogs };
}
