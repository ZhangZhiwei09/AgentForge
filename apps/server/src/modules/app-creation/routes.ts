// App Creation Routes —— WeaveFox Phase 1 (V12)
// CRUD for app projects, file management, and code generation with SSE streaming
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  appProjectService,
  AppProjectService,
} from "../../services/app-project.js";
import { codeGenService } from "../../services/codegen.js";
import { logger } from "@agentforge/logger";
import { createHono } from "../../lib/hono.js";

export const appCreationRoutes = createHono();

// ---- Request Schemas ----

const createProjectSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
  prompt: z
    .string()
    .min(1)
    .max(16000, "Prompt must be at most 16000 characters"),
  framework: z.enum(["react", "vue", "html", "nextjs"]).default("react"),
  type: z.enum(["frontend", "fullstack"]).default("frontend"),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).nullable().optional(),
  status: z
    .enum(["draft", "generating", "previewing", "deployed", "archived"])
    .optional(),
});

const generateSchema = z.object({
  prompt: z.string().min(1).max(16000),
  skills: z.array(z.string()).optional(),
  model: z.string().nullable().optional(),
});

const writeFileSchema = z.object({
  content: z.string().min(1),
  language: z.enum(["tsx", "ts", "css", "html", "json", "js", "py"]).optional(),
});

// ---- Helpers ----

function getUserId(c: any): string {
  return c.get("user").id;
}

// ---- Routes ----

// POST /api/projects — Create a new app project + trigger generation (SSE stream)
appCreationRoutes.post(
  "/api/projects",
  zValidator("json", createProjectSchema),
  async (c) => {
    const { name, description, prompt, framework, type } = c.req.valid("json");
    const userId = getUserId(c);

    // Create the project
    const project = await appProjectService.createProject(userId, {
      name: name || "",
      description,
      prompt,
      framework,
      type,
    });

    logger.info(
      { projectId: project.id, userId, framework },
      "AppProject created, starting generation stream",
    );

    // Stream the code generation progress
    return streamSSE(c, async (stream) => {
      try {
        for await (const event of codeGenService.generate(
          project.id,
          userId,
          prompt,
          { framework, model: null },
        )) {
          await stream.writeSSE({ data: JSON.stringify(event) });
        }
        await stream.writeSSE({ data: "[DONE]" });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : "Unknown error";
        logger.error(
          { error: errMsg, projectId: project.id },
          "Code generation failed",
        );
        await stream.writeSSE({
          data: JSON.stringify({
            type: "appgen_error",
            error: errMsg,
            project_id: project.id,
          }),
        });
      }
    });
  },
);

// GET /api/projects — List user's projects
appCreationRoutes.get("/api/projects", async (c) => {
  const userId = getUserId(c);
  const projects = await appProjectService.listProjects(userId);
  return c.json({ projects, count: projects.length });
});

// GET /api/projects/:id — Get project details with files
appCreationRoutes.get("/api/projects/:id", async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param("id");

  const project = await appProjectService.getProject(projectId, userId);
  if (!project) {
    return c.json({ detail: "Project not found" }, 404);
  }

  const files = await appProjectService.getFiles(projectId);
  return c.json({ ...project, files });
});

// PATCH /api/projects/:id — Update project metadata
appCreationRoutes.patch(
  "/api/projects/:id",
  zValidator("json", updateProjectSchema),
  async (c) => {
    const userId = getUserId(c);
    const projectId = c.req.param("id");
    const input = c.req.valid("json");

    const updated = await appProjectService.updateProject(projectId, userId, {
      ...input,
      description: input.description === null ? undefined : input.description,
    });
    if (!updated) {
      return c.json({ detail: "Project not found" }, 404);
    }
    return c.json(updated);
  },
);

// DELETE /api/projects/:id — Delete project
appCreationRoutes.delete("/api/projects/:id", async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param("id");

  const deleted = await appProjectService.deleteProject(projectId, userId);
  if (!deleted) {
    return c.json({ detail: "Project not found" }, 404);
  }
  return c.json({ detail: "Project deleted" });
});

// POST /api/projects/:id/generate — Trigger regeneration (SSE stream)
appCreationRoutes.post(
  "/api/projects/:id/generate",
  zValidator("json", generateSchema),
  async (c) => {
    const userId = getUserId(c);
    const projectId = c.req.param("id");
    const { prompt, skills, model } = c.req.valid("json");

    // Verify project ownership
    const project = await appProjectService.getProject(projectId, userId);
    if (!project) {
      return c.json({ detail: "Project not found" }, 404);
    }

    logger.info({ projectId, userId }, "Regeneration started");

    return streamSSE(c, async (stream) => {
      try {
        for await (const event of codeGenService.generate(
          projectId,
          userId,
          prompt,
          { framework: project.framework, skills, model },
        )) {
          await stream.writeSSE({ data: JSON.stringify(event) });
        }
        await stream.writeSSE({ data: "[DONE]" });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : "Unknown error";
        logger.error({ error: errMsg, projectId }, "Regeneration failed");
        await stream.writeSSE({
          data: JSON.stringify({
            type: "appgen_error",
            error: errMsg,
            project_id: projectId,
          }),
        });
      }
    });
  },
);

// GET /api/projects/:id/files — List project files
appCreationRoutes.get("/api/projects/:id/files", async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param("id");

  const project = await appProjectService.getProject(projectId, userId);
  if (!project) {
    return c.json({ detail: "Project not found" }, 404);
  }

  const files = await appProjectService.getFiles(projectId);
  return c.json({ files, count: files.length });
});

// PUT /api/projects/:id/files/:path — Write/update a file
appCreationRoutes.put(
  "/api/projects/:id/files/:path",
  zValidator("json", writeFileSchema),
  async (c) => {
    const userId = getUserId(c);
    const projectId = c.req.param("id");
    const filePath = decodeURIComponent(c.req.param("path"));

    const project = await appProjectService.getProject(projectId, userId);
    if (!project) {
      return c.json({ detail: "Project not found" }, 404);
    }

    if (!AppProjectService.validatePath(filePath)) {
      return c.json({ detail: "Invalid file path" }, 400);
    }

    const { content, language } = c.req.valid("json");
    const file = await appProjectService.saveFile(
      projectId,
      filePath,
      content,
      language,
    );
    return c.json(file);
  },
);

// GET /api/projects/:id/files/:path — Read a file
appCreationRoutes.get("/api/projects/:id/files/:path", async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param("id");
  const filePath = decodeURIComponent(c.req.param("path"));

  const project = await appProjectService.getProject(projectId, userId);
  if (!project) {
    return c.json({ detail: "Project not found" }, 404);
  }

  const file = await appProjectService.getFile(projectId, filePath);
  if (!file) {
    return c.json({ detail: "File not found" }, 404);
  }

  return c.json(file);
});

// GET /api/projects/:id/generations — List generation runs
appCreationRoutes.get("/api/projects/:id/generations", async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param("id");

  const project = await appProjectService.getProject(projectId, userId);
  if (!project) {
    return c.json({ detail: "Project not found" }, 404);
  }

  const runs = await appProjectService.listGenRuns(projectId);
  return c.json({ runs, count: runs.length });
});
