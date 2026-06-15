// Team Routes — V9 Multi-Agent API Endpoints
// CRUD + templates + run/stream + control
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { logger } from "@agentforge/logger";
import { createHono } from "../lib/hono.js";
import { createExecutionScope } from "../runtime/scope.js";
import { teamService } from "../teams/service.js";
import {
  CreateTeamSchema,
  UpdateTeamSchema,
  RunTeamSchema,
  TeamDefinitionSchema,
} from "../teams/schema.js";
import { listTeamTemplates, getTeamTemplate } from "../teams/templates.js";

export const teamRoutes = createHono();

// ===== CRUD =====

// POST /api/teams — Create a new team
teamRoutes.post(
  "/api/teams",
  zValidator("json", CreateTeamSchema),
  async (c) => {
    const user = c.get("user");
    const data = c.req.valid("json");

    try {
      const team = await teamService.create(user.id, data);
      logger.info({ teamId: team.id, name: team.name }, "Team created");
      return c.json(team, 201);
    } catch (err: any) {
      if (err?.name === "ZodError") {
        return c.json({ error: "Validation failed", details: err.issues }, 400);
      }
      logger.error({ error: err }, "Failed to create team");
      return c.json({ error: "Failed to create team" }, 500);
    }
  },
);

// GET /api/teams — List teams
teamRoutes.get("/api/teams", async (c) => {
  const user = c.get("user");
  const status = c.req.query("status");
  const mode = c.req.query("mode");
  const page = parseInt(c.req.query("page") || "1", 10);
  const limit = parseInt(c.req.query("limit") || "20", 10);

  try {
    const result = await teamService.list(user.id, {
      status,
      mode,
      page,
      limit,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ error: err }, "Failed to list teams");
    return c.json({ error: "Failed to list teams" }, 500);
  }
});

// GET /api/teams/templates — List built-in team templates
teamRoutes.get("/api/teams/templates", async (c) => {
  return c.json(listTeamTemplates());
});

// POST /api/teams/templates/:id/instantiate — Create team from template
teamRoutes.post("/api/teams/templates/:id/instantiate", async (c) => {
  const user = c.get("user");
  const { id } = c.req.param();
  const body = await c.req.json().catch(() => ({}));

  try {
    const team = await teamService.createFromTemplate(user.id, id, {
      name: body.name,
      description: body.description,
    });
    if (!team) {
      return c.json({ error: `Template "${id}" not found` }, 404);
    }
    return c.json(team, 201);
  } catch (err: any) {
    if (err?.name === "ZodError") {
      return c.json({ error: "Validation failed", details: err.issues }, 400);
    }
    logger.error({ error: err }, "Failed to create team from template");
    return c.json({ error: "Failed to create team from template" }, 500);
  }
});

// POST /api/teams/validate — Validate a team definition without saving
teamRoutes.post("/api/teams/validate", async (c) => {
  const body = await c.req.json();

  try {
    const result = teamService.validateDefinition(body.definition || body);
    return c.json(result);
  } catch (err) {
    return c.json(
      { valid: false, errors: [{ path: "", message: "Invalid request body" }] },
      400,
    );
  }
});

// GET /api/teams/:id — Get a single team
teamRoutes.get("/api/teams/:id", async (c) => {
  const user = c.get("user");
  const { id } = c.req.param();

  try {
    const team = await teamService.get(id, user.id);
    if (!team) {
      return c.json({ error: "Team not found" }, 404);
    }
    return c.json(team);
  } catch (err) {
    logger.error({ error: err }, "Failed to get team");
    return c.json({ error: "Failed to get team" }, 500);
  }
});

// PUT /api/teams/:id — Update a team
teamRoutes.put("/api/teams/:id", async (c) => {
  const user = c.get("user");
  const { id } = c.req.param();
  const body = await c.req.json();

  try {
    const team = await teamService.update(id, user.id, body);
    if (!team) {
      return c.json({ error: "Team not found" }, 404);
    }
    logger.info({ teamId: id }, "Team updated");
    return c.json(team);
  } catch (err: any) {
    if (err?.name === "ZodError") {
      return c.json({ error: "Validation failed", details: err.issues }, 400);
    }
    logger.error({ error: err }, "Failed to update team");
    return c.json({ error: "Failed to update team" }, 500);
  }
});

// DELETE /api/teams/:id — Delete a team
teamRoutes.delete("/api/teams/:id", async (c) => {
  const user = c.get("user");
  const { id } = c.req.param();

  try {
    const deleted = await teamService.delete(id, user.id);
    if (!deleted) {
      return c.json({ error: "Team not found" }, 404);
    }
    return c.json({ success: true });
  } catch (err) {
    logger.error({ error: err }, "Failed to delete team");
    return c.json({ error: "Failed to delete team" }, 500);
  }
});

// ===== Execution =====

// POST /api/teams/:id/run — Execute a team (SSE stream)
teamRoutes.post("/api/teams/:id/run", async (c) => {
  const user = c.get("user");
  const { id } = c.req.param();
  const body = await c.req.json();

  try {
    const parsed = RunTeamSchema.parse(body);
    const task = parsed.task;
    const variables = parsed.variables || {};
    const conversationId = parsed.conversationId;

    return streamSSE(c, async (stream) => {
      const scope = createExecutionScope({ signal: c.req.raw.signal });
      for await (const event of teamService.runTeam(
        id,
        user.id,
        task,
        variables,
        conversationId,
        scope,
      )) {
        await stream.writeSSE({
          data: JSON.stringify(event),
          event: event.type,
        });
      }
      await stream.writeSSE({
        data: "[DONE]",
      });
    });
  } catch (err: any) {
    if (err?.name === "ZodError") {
      return c.json({ error: "Validation failed", details: err.issues }, 400);
    }
    logger.error({ error: err }, "Failed to start team run");
    return c.json({ error: "Failed to start team run" }, 500);
  }
});

// ===== Run History =====

// GET /api/teams/:id/runs — List runs for a team
teamRoutes.get("/api/teams/:id/runs", async (c) => {
  const user = c.get("user");
  const { id } = c.req.param();
  const status = c.req.query("status");
  const page = parseInt(c.req.query("page") || "1", 10);
  const limit = parseInt(c.req.query("limit") || "20", 10);

  try {
    const result = await teamService.listRuns(id, user.id, {
      status,
      page,
      limit,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ error: err }, "Failed to list team runs");
    return c.json({ error: "Failed to list runs" }, 500);
  }
});

// ===== Run Control =====

// GET /api/teams/runs/:runId — Get a specific run
teamRoutes.get("/api/teams/runs/:runId", async (c) => {
  const user = c.get("user");
  const { runId } = c.req.param();

  try {
    const run = await teamService.getRun(runId, user.id);
    if (!run) {
      return c.json({ error: "Run not found" }, 404);
    }
    return c.json(run);
  } catch (err) {
    logger.error({ error: err }, "Failed to get run");
    return c.json({ error: "Failed to get run" }, 500);
  }
});

// POST /api/teams/runs/:runId/cancel — Cancel a running team
teamRoutes.post("/api/teams/runs/:runId/cancel", async (c) => {
  const user = c.get("user");
  const { runId } = c.req.param();

  try {
    const run = await teamService.cancelRun(runId, user.id);
    if (!run) {
      return c.json({ error: "Run not found or cannot be cancelled" }, 404);
    }
    return c.json(run);
  } catch (err) {
    logger.error({ error: err }, "Failed to cancel run");
    return c.json({ error: "Failed to cancel run" }, 500);
  }
});

// POST /api/teams/runs/:runId/pause — Pause a running team
teamRoutes.post("/api/teams/runs/:runId/pause", async (c) => {
  const user = c.get("user");
  const { runId } = c.req.param();

  try {
    const run = await teamService.pauseRun(runId, user.id);
    if (!run) {
      return c.json({ error: "Run not found or cannot be paused" }, 404);
    }
    return c.json(run);
  } catch (err) {
    logger.error({ error: err }, "Failed to pause run");
    return c.json({ error: "Failed to pause run" }, 500);
  }
});
