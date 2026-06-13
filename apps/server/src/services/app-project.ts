// AppProjectService — CRUD operations for app projects and file management
// WeaveFox Phase 1 (V12): Foundation for AI-driven application generation
import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import { logger } from "@agentforge/logger";
import type {
  AppProjectDTO,
  ProjectFileDTO,
  AppGenRunDTO,
  CreateProjectRequest,
  UpdateProjectRequest,
  ProjectLanguage,
} from "@agentforge/shared-types";

export class AppProjectService {
  /**
   * Create a new app project. Does NOT trigger generation — caller should
   * use CodeGenService separately to provide streaming feedback.
   */
  async createProject(
    userId: string,
    input: CreateProjectRequest,
  ): Promise<AppProjectDTO> {
    const id = randomUUID();
    const project = await prisma.appProject.create({
      data: {
        id,
        userId,
        name: input.name || this.extractNameFromPrompt(input.prompt),
        description: input.description || null,
        status: "draft",
        type: input.type || "frontend",
        framework: input.framework || "react",
        metadata: {
          initialPrompt: input.prompt,
        },
      },
    });

    logger.info({ projectId: id, userId, name: project.name }, "AppProject created");
    return this.toDTO(project);
  }

  private extractNameFromPrompt(prompt: string): string {
    // Take first 60 chars of prompt as project name, trimmed to last full word
    const clean = prompt.replace(/\s+/g, " ").trim();
    if (clean.length <= 60) return clean;
    const truncated = clean.slice(0, 60);
    const lastSpace = truncated.lastIndexOf(" ");
    return lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
  }

  /**
   * Get a single project by ID, verifying ownership.
   */
  async getProject(projectId: string, userId: string): Promise<AppProjectDTO | null> {
    const project = await prisma.appProject.findFirst({
      where: { id: projectId, userId },
    });
    return project ? this.toDTO(project) : null;
  }

  /**
   * List all projects for a user, ordered by most recently updated.
   */
  async listProjects(userId: string): Promise<AppProjectDTO[]> {
    const projects = await prisma.appProject.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
    });
    return projects.map((p) => this.toDTO(p));
  }

  /**
   * Update project metadata.
   */
  async updateProject(
    projectId: string,
    userId: string,
    input: UpdateProjectRequest,
  ): Promise<AppProjectDTO | null> {
    const project = await prisma.appProject.findFirst({
      where: { id: projectId, userId },
    });
    if (!project) return null;

    const updated = await prisma.appProject.update({
      where: { id: projectId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
    });
    return this.toDTO(updated);
  }

  /**
   * Delete a project and all associated files and runs (cascading).
   */
  async deleteProject(projectId: string, userId: string): Promise<boolean> {
    const project = await prisma.appProject.findFirst({
      where: { id: projectId, userId },
    });
    if (!project) return false;

    await prisma.appProject.delete({ where: { id: projectId } });
    logger.info({ projectId, userId }, "AppProject deleted");
    return true;
  }

  // ---- File Management ----

  /**
   * Save or update a file in a project. Uses upsert on (projectId, path).
   */
  async saveFile(
    projectId: string,
    filePath: string,
    content: string,
    language?: ProjectLanguage,
  ): Promise<ProjectFileDTO> {
    const detectedLanguage = language || this.detectLanguage(filePath);
    const id = randomUUID();

    // Check if file already exists (to increment version)
    const existing = await prisma.projectFile.findUnique({
      where: { projectId_path: { projectId, path: filePath } },
    });

    // Use upsert-like pattern: delete then create, or use raw upsert
    // Prisma upsert requires unique fields, which we have with @@unique([projectId, path])
    const file = await prisma.projectFile.upsert({
      where: { projectId_path: { projectId, path: filePath } },
      update: {
        content,
        language: detectedLanguage,
        size: Buffer.byteLength(content, "utf-8"),
        version: existing ? existing.version + 1 : 1,
      },
      create: {
        id,
        projectId,
        path: filePath,
        content,
        language: detectedLanguage,
        size: Buffer.byteLength(content, "utf-8"),
        version: 1,
      },
    });

    // Update project status if it was draft
    await prisma.appProject.updateMany({
      where: { id: projectId, status: "draft" },
      data: { status: "generating" },
    });

    return this.fileToDTO(file);
  }

  /**
   * Get all files for a project.
   */
  async getFiles(projectId: string): Promise<ProjectFileDTO[]> {
    const files = await prisma.projectFile.findMany({
      where: { projectId },
      orderBy: { path: "asc" },
    });
    return files.map((f) => this.fileToDTO(f));
  }

  /**
   * Get a specific file by path.
   */
  async getFile(projectId: string, filePath: string): Promise<ProjectFileDTO | null> {
    const file = await prisma.projectFile.findFirst({
      where: { projectId, path: filePath },
    });
    return file ? this.fileToDTO(file) : null;
  }

  /**
   * Bulk save files from a generation result.
   */
  async saveFiles(
    projectId: string,
    files: Array<{ path: string; content: string; language?: ProjectLanguage }>,
  ): Promise<string[]> {
    const saved: string[] = [];
    for (const f of files) {
      await this.saveFile(projectId, f.path, f.content, f.language);
      saved.push(f.path);
    }
    return saved;
  }

  private detectLanguage(path: string): ProjectLanguage {
    const ext = path.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "tsx":
        return "tsx";
      case "ts":
        return "ts";
      case "css":
        return "css";
      case "html":
        return "html";
      case "json":
        return "json";
      case "js":
      case "jsx":
        return "js";
      default:
        return "tsx";
    }
  }

  /**
   * Validate a file path for security — prevent path traversal.
   */
  static validatePath(filePath: string): boolean {
    // No empty paths
    if (!filePath || filePath.trim().length === 0) return false;
    // No absolute paths
    if (filePath.startsWith("/") || filePath.match(/^[A-Za-z]:\\/)) return false;
    // No path traversal
    if (filePath.includes("..")) return false;
    // Must have a reasonable length
    if (filePath.length > 500) return false;
    // Must have a valid extension
    if (!filePath.includes(".")) return false;
    return true;
  }

  // ---- Generation Runs ----

  /**
   * Create a generation run record.
   */
  async createGenRun(
    projectId: string,
    prompt: string,
    agentSessionId?: string,
  ): Promise<AppGenRunDTO> {
    const id = randomUUID();
    const run = await prisma.appGenRun.create({
      data: {
        id,
        projectId,
        prompt,
        status: "running",
        agentSessionId: agentSessionId || null,
      },
    });

    // Update project status
    await prisma.appProject.update({
      where: { id: projectId },
      data: { status: "generating" },
    });

    return {
      id: run.id,
      projectId: run.projectId,
      prompt: run.prompt,
      status: run.status as "running" | "completed" | "failed",
      result: run.result as AppGenRunDTO["result"],
      agentSessionId: run.agentSessionId,
      startedAt: run.startedAt.toISOString(),
      completedAt: run.completedAt?.toISOString() || null,
    };
  }

  /**
   * Complete a generation run with results.
   */
  async completeGenRun(
    runId: string,
    filesCreated: string[],
    tokensUsed: number,
    errors: string[] = [],
  ): Promise<void> {
    await prisma.appGenRun.update({
      where: { id: runId },
      data: {
        status: errors.length > 0 ? "failed" : "completed",
        result: {
          files_created: filesCreated,
          tokens_used: tokensUsed,
          errors,
        },
        completedAt: new Date(),
      },
    });

    // Get project ID from run and update its status
    const run = await prisma.appGenRun.findUnique({ where: { id: runId } });
    if (run) {
      await prisma.appProject.update({
        where: { id: run.projectId },
        data: { status: errors.length > 0 ? "draft" : "previewing" },
      });
    }
  }

  /**
   * List generation runs for a project.
   */
  async listGenRuns(projectId: string): Promise<AppGenRunDTO[]> {
    const runs = await prisma.appGenRun.findMany({
      where: { projectId },
      orderBy: { startedAt: "desc" },
    });
    return runs.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      prompt: r.prompt,
      status: r.status as "running" | "completed" | "failed",
      result: r.result as AppGenRunDTO["result"],
      agentSessionId: r.agentSessionId,
      startedAt: r.startedAt.toISOString(),
      completedAt: r.completedAt?.toISOString() || null,
    }));
  }

  // ---- DTO Conversion (Prisma → DTO) ----

  private toDTO(project: any): AppProjectDTO {
    return {
      id: project.id,
      userId: project.userId,
      name: project.name,
      description: project.description,
      status: project.status,
      type: project.type,
      framework: project.framework,
      previewUrl: project.previewUrl,
      deployUrl: project.deployUrl,
      metadata: project.metadata as Record<string, unknown>,
      createdAt: project.createdAt instanceof Date ? project.createdAt.toISOString() : project.createdAt,
      updatedAt: project.updatedAt instanceof Date ? project.updatedAt.toISOString() : project.updatedAt,
    };
  }

  private fileToDTO(file: any): ProjectFileDTO {
    return {
      id: file.id,
      projectId: file.projectId,
      path: file.path,
      content: file.content,
      language: file.language,
      size: file.size,
      version: file.version,
      createdAt: file.createdAt instanceof Date ? file.createdAt.toISOString() : file.createdAt,
      updatedAt: file.updatedAt instanceof Date ? file.updatedAt.toISOString() : file.updatedAt,
    };
  }
}

// Singleton
export const appProjectService = new AppProjectService();
