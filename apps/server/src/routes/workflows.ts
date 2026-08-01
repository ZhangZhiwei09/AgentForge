// Workflow Routes — CRUD, run, control, and SSE streaming endpoints for V6 Workflow Engine
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../db.js";
import { logger } from "@agentforge/logger";
import { createHono } from "../lib/hono.js";
import { createExecutionScope } from "../runtime/scope.js";
import { workflowService } from "../workflows/service.js";
import {
  CreateWorkflowSchema,
  UpdateWorkflowSchema,
  RunWorkflowSchema,
  WorkflowDefinitionSchema,
  ApprovalDecisionSchema,
} from "../workflows/schema.js";
import { listTemplates, getTemplate } from "../workflows/templates.js";

export const workflowRoutes = createHono();

// ===== Workflow CRUD =====

// POST /api/workflows — Create a new workflow
workflowRoutes.post(
  "/api/workflows",
  zValidator("json", CreateWorkflowSchema),
  async (c) => {
    const user = c.get("user");
    const data = c.req.valid("json");

    const workflow = await workflowService.create(user.id, data);

    logger.info(
      { workflowId: workflow.id, name: workflow.name },
      "Workflow created",
    );
    return c.json(workflow, 201);
  },
);

// GET /api/workflows — List workflows
workflowRoutes.get("/api/workflows", async (c) => {
  const user = c.get("user");
  const status = c.req.query("status");
  const tag = c.req.query("tag");
  const page = parseInt(c.req.query("page") || "1", 10);
  const limit = parseInt(c.req.query("limit") || "20", 10);

  const result = await workflowService.list(user.id, {
    status,
    tag,
    page,
    limit,
  });
  return c.json(result);
});

// GET /api/workflows/templates — List built-in templates
workflowRoutes.get("/api/workflows/templates", async (c) => {
  const templates = listTemplates();
  return c.json({ templates });
});

// POST /api/workflows/templates/:template_id/instantiate — Create from template
workflowRoutes.post(
  "/api/workflows/templates/:template_id/instantiate",
  async (c) => {
    const user = c.get("user");
    const templateId = c.req.param("template_id");
    const body = await c.req.json().catch(() => ({}));
    const name = body.name;

    const template = getTemplate(templateId);
    if (!template) {
      return c.json({ detail: "Template not found" }, 404);
    }

    const definition = { ...template.definition };
    if (name) definition.name = name;

    const workflow = await workflowService.create(user.id, {
      name: definition.name,
      description: definition.description,
      definition,
      tags: [template.category],
    });

    logger.info(
      { workflowId: workflow.id, templateId },
      "Workflow instantiated from template",
    );
    return c.json(workflow, 201);
  },
);

// POST /api/workflows/validate — Validate a workflow definition
workflowRoutes.post("/api/workflows/validate", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const result = workflowService.validateDefinition(body.definition || body);
  return c.json(result);
});

// GET /api/workflows/:id — Get workflow details
workflowRoutes.get("/api/workflows/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");

  const workflow = await workflowService.get(id, user.id);
  if (!workflow) {
    return c.json({ detail: "Workflow not found or access denied" }, 404);
  }

  return c.json(workflow);
});

// PUT /api/workflows/:id — Update a workflow
workflowRoutes.put(
  "/api/workflows/:id",
  zValidator("json", UpdateWorkflowSchema),
  async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const data = c.req.valid("json");

    const workflow = await workflowService.update(
      id,
      user.id,
      data as Record<string, unknown>,
    );
    if (!workflow) {
      return c.json({ detail: "Workflow not found or access denied" }, 404);
    }

    logger.info({ workflowId: id }, "Workflow updated");
    return c.json(workflow);
  },
);

// DELETE /api/workflows/:id — Delete a workflow
workflowRoutes.delete("/api/workflows/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");

  const deleted = await workflowService.delete(id, user.id);
  if (!deleted) {
    return c.json({ detail: "Workflow not found or access denied" }, 404);
  }

  logger.info({ workflowId: id }, "Workflow deleted");
  return c.body(null, 204);
});

// ===== Workflow Execution =====

// POST /api/workflows/:id/run — Execute a workflow (SSE stream)
workflowRoutes.post(
  "/api/workflows/:id/run",
  zValidator("json", RunWorkflowSchema),
  async (c) => {
    const user = c.get("user");
    const workflowId = c.req.param("id");
    const { variables } = c.req.valid("json");

    // Verify workflow exists and belongs to user
    const workflow = await workflowService.get(workflowId, user.id);
    if (!workflow) {
      return c.json({ detail: "Workflow not found or access denied" }, 404);
    }
    if (workflow.status !== "ready" && workflow.status !== "draft") {
      return c.json(
        { detail: `Workflow is ${workflow.status}, cannot execute` },
        400,
      );
    }

    logger.info(
      { workflowId, variables: JSON.stringify(variables).slice(0, 100) },
      "Workflow run started",
    );

    return streamSSE(c, async (stream) => {
      const scope = createExecutionScope({ signal: c.req.raw.signal });
      try {
        for await (const event of workflowService.runWorkflow(
          workflowId,
          user.id,
          variables,
          undefined, // conversationId
          scope,
        )) {
          await stream.writeSSE({ data: JSON.stringify(event) });
        }
        await stream.writeSSE({ data: "[DONE]" });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : "Unknown error";
        logger.error({ error: errMsg, workflowId }, "Workflow run failed");
        await stream.writeSSE({
          data: JSON.stringify({ type: "workflow_failed", error: errMsg }),
        });
      }
    });
  },
);

// GET /api/workflows/:id/runs — List runs for a workflow
workflowRoutes.get("/api/workflows/:id/runs", async (c) => {
  const user = c.get("user");
  const workflowId = c.req.param("id");
  const status = c.req.query("status");
  const page = parseInt(c.req.query("page") || "1", 10);
  const limit = parseInt(c.req.query("limit") || "20", 10);

  // Verify workflow belongs to user
  const workflow = await workflowService.get(workflowId, user.id);
  if (!workflow) {
    return c.json({ detail: "Workflow not found or access denied" }, 404);
  }

  const result = await workflowService.listRuns(workflowId, user.id, {
    status,
    page,
    limit,
  });
  return c.json(result);
});

// GET /api/workflows/runs/:run_id — Get run details with step logs
workflowRoutes.get("/api/workflows/runs/:run_id", async (c) => {
  const user = c.get("user");
  const runId = c.req.param("run_id");

  const result = await workflowService.getRun(runId, user.id);
  if (!result) {
    return c.json({ detail: "Run not found or access denied" }, 404);
  }

  return c.json(result);
});

// GET /api/workflows/runs/:run_id/stream — SSE stream for a running workflow
workflowRoutes.get("/api/workflows/runs/:run_id/stream", async (c) => {
  const user = c.get("user");
  const runId = c.req.param("run_id");

  // Verify run belongs to user
  const result = await workflowService.getRun(runId, user.id);
  if (!result) {
    return c.json({ detail: "Run not found or access denied" }, 404);
  }

  const run = result.run;
  if (run.status !== "running") {
    return c.json({
      type:
        run.status === "completed" ? "workflow_completed" : "workflow_failed",
      runId,
      output: run.output,
      error: run.error,
    });
  }

  // For active runs, return current state
  return c.json(run);
});

// ===== Run Control =====

// POST /api/workflows/runs/:run_id/pause — Pause a running workflow
workflowRoutes.post("/api/workflows/runs/:run_id/pause", async (c) => {
  const user = c.get("user");
  const runId = c.req.param("run_id");

  const run = await workflowService.pauseRun(runId, user.id);
  if (!run) {
    return c.json({ detail: "Run not found or not in running state" }, 404);
  }

  logger.info({ runId }, "Workflow run paused");
  return c.json(run);
});

// POST /api/workflows/runs/:run_id/resume — Resume a paused workflow
workflowRoutes.post("/api/workflows/runs/:run_id/resume", async (c) => {
  const user = c.get("user");
  const runId = c.req.param("run_id");

  return streamSSE(c, async (stream) => {
    try {
      for await (const event of workflowService.resumeRun(runId, user.id)) {
        await stream.writeSSE({ data: JSON.stringify(event) });
      }
      await stream.writeSSE({ data: "[DONE]" });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : "Unknown error";
      await stream.writeSSE({
        data: JSON.stringify({ type: "workflow_failed", error: errMsg }),
      });
    }
  });
});

// POST /api/workflows/runs/:run_id/cancel — Cancel a running or paused workflow
workflowRoutes.post("/api/workflows/runs/:run_id/cancel", async (c) => {
  const user = c.get("user");
  const runId = c.req.param("run_id");

  const run = await workflowService.cancelRun(runId, user.id);
  if (!run) {
    return c.json({ detail: "Run not found or not in cancellable state" }, 404);
  }

  logger.info({ runId }, "Workflow run cancelled");
  return c.json(run);
});

// POST /api/workflows/runs/:run_id/retry — Retry a failed run from checkpoint
workflowRoutes.post("/api/workflows/runs/:run_id/retry", async (c) => {
  const user = c.get("user");
  const runId = c.req.param("run_id");

  const result = await workflowService.getRun(runId, user.id);
  if (!result) {
    return c.json({ detail: "Run not found or access denied" }, 404);
  }

  const run = result.run;
  if (run.status !== "failed") {
    return c.json(
      { detail: `Run is ${run.status}, can only retry failed runs` },
      400,
    );
  }

  // Start a new run with the same input (from checkpoint)
  return streamSSE(c, async (stream) => {
    try {
      for await (const event of workflowService.runWorkflow(
        run.workflowId,
        user.id,
        run.input,
        undefined, // conversationId
        createExecutionScope({ signal: c.req.raw.signal }),
      )) {
        await stream.writeSSE({ data: JSON.stringify(event) });
      }
      await stream.writeSSE({ data: "[DONE]" });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : "Unknown error";
      await stream.writeSSE({
        data: JSON.stringify({ type: "workflow_failed", error: errMsg }),
      });
    }
  });
});

// ===== Approval =====

// POST /api/workflows/runs/:run_id/approve — Handle approval for a paused workflow
workflowRoutes.post(
  "/api/workflows/runs/:run_id/approve",
  zValidator("json", ApprovalDecisionSchema),
  async (c) => {
    const user = c.get("user");
    const runId = c.req.param("run_id");
    const { action, modified_args, rejection_reason } = c.req.valid("json");

    const result = await workflowService.getRun(runId, user.id);
    if (!result) {
      return c.json({ detail: "Run not found or access denied" }, 404);
    }

    if (result.run.status !== "paused") {
      return c.json({ detail: `Run is ${result.run.status}, not paused` }, 400);
    }

    return streamSSE(c, async (stream) => {
      try {
        for await (const event of workflowService.handleApproval(
          runId,
          action,
          modified_args as Record<string, unknown> | undefined,
          rejection_reason,
        )) {
          await stream.writeSSE({ data: JSON.stringify(event) });
        }
        await stream.writeSSE({ data: "[DONE]" });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : "Unknown error";
        await stream.writeSSE({
          data: JSON.stringify({ type: "workflow_failed", error: errMsg }),
        });
      }
    });
  },
);
