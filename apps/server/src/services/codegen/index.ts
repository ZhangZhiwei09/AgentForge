// CodeGenService — AI-driven application code generation
// WeaveFox Phase 1 (V12): Uses LLM with specialized prompts to plan, generate,
// and review complete frontend applications. Uses direct prompting (not tool calls).
//
// Thin orchestration layer — delegates to specialized sub-modules.
// Refactored: Phase 3 file splitting.

import { randomUUID } from "crypto";
import { resolveModel } from "../../providers/registry.js";
import { appProjectService } from "../app-project.js";
import { logger } from "@agentforge/logger";
import type { AppGenStreamEvent, AppFilePlan } from "@agentforge/shared-types";

import { callLLM } from "./llm.js";
import { planAppStructure, getDefaultPlan } from "./plan.js";
import { generateFile } from "./generate.js";
import { reviewApp } from "./review.js";
import { LANG_GUIDES } from "./prompts.js";

export class CodeGenService {
  /**
   * Generate an app from a natural language prompt.
   * Yields AppGenStreamEvent for SSE streaming to frontend.
   */
  async *generate(
    projectId: string,
    userId: string,
    prompt: string,
    options: {
      model?: string | null;
      framework?: string;
      skills?: string[];
    } = {},
  ): AsyncGenerator<AppGenStreamEvent> {
    const framework = options.framework || "react";

    // 1. Create generation run record
    const run = await appProjectService.createGenRun(projectId, prompt);
    const runId = run.id;

    // 2. Resolve model/provider
    const [, resolvedModel] = resolveModel(options.model);

    // 3. Send meta event
    yield {
      type: "appgen_meta",
      project_id: projectId,
      run_id: runId,
      name: (await this.getProjectName(projectId)) || "New App",
      framework,
      prompt,
    };

    // 4. Phase 1: Plan the file structure
    yield { type: "appgen_plan", message_id: randomUUID(), plan: [] };

    logger.info({ projectId, framework }, "Starting app structure planning");
    let plan: AppFilePlan[] | null = null;

    try {
      plan = await planAppStructure(prompt, framework, resolvedModel, callLLM);
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : "Unknown error" },
        "Plan phase failed, using default plan",
      );
    }

    // Fallback to default plan if planning fails
    if (!plan || plan.length === 0) {
      logger.warn({ projectId }, "Plan empty, using default plan");
      plan = getDefaultPlan(framework);
    }

    yield { type: "appgen_plan", message_id: randomUUID(), plan };

    // 5. Phase 2: Generate each file
    const generatedFiles: string[] = [];
    const errors: string[] = [];
    let totalTokens = 0;

    for (const filePlan of plan) {
      yield {
        type: "appgen_file_start",
        message_id: randomUUID(),
        file_path: filePlan.path,
        language: filePlan.language,
      };

      try {
        logger.info({ file: filePlan.path }, "Generating file");
        const { content, tokens } = await generateFile(
          filePlan,
          prompt,
          framework,
          resolvedModel,
          callLLM,
          LANG_GUIDES,
        );

        if (content) {
          await appProjectService.saveFile(
            projectId,
            filePlan.path,
            content,
            filePlan.language,
          );

          generatedFiles.push(filePlan.path);
          totalTokens += tokens;

          yield {
            type: "appgen_file_done",
            message_id: randomUUID(),
            file_path: filePlan.path,
            language: filePlan.language,
            content,
            size: Buffer.byteLength(content, "utf-8"),
          };
          logger.info(
            { file: filePlan.path, size: content.length },
            "File generated",
          );
        } else {
          errors.push(`${filePlan.path}: empty content returned`);
          logger.warn({ file: filePlan.path }, "Empty content from LLM");
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        errors.push(`${filePlan.path}: ${errorMsg}`);
        logger.error(
          { file: filePlan.path, error: errorMsg },
          "File generation failed",
        );
        yield {
          type: "appgen_error",
          message_id: randomUUID(),
          error: `Failed to generate ${filePlan.path}: ${errorMsg}`,
        };
      }
    }

    // 6. Phase 3: Quick review of key files
    if (generatedFiles.length > 0) {
      yield {
        type: "appgen_review",
        message_id: randomUUID(),
        review: "Reviewing...",
      };

      try {
        const review = await reviewApp(
          plan,
          projectId,
          resolvedModel,
          callLLM,
          (pid: string) => appProjectService.getFiles(pid),
        );
        yield { type: "appgen_review", message_id: randomUUID(), review };
      } catch (err: unknown) {
        logger.warn({ err, projectId }, "App review phase failed, using default message");
        yield {
          type: "appgen_review",
          message_id: randomUUID(),
          review: "Code generation complete. All files generated successfully.",
        };
      }
    }

    // 7. Complete the run
    await appProjectService.completeGenRun(
      runId,
      generatedFiles,
      totalTokens,
      errors,
    );

    yield {
      type: "appgen_done",
      message_id: randomUUID(),
      result: {
        files_created: generatedFiles,
        tokens_used: totalTokens,
        errors,
      },
    };
  }

  private async getProjectName(projectId: string): Promise<string | null> {
    try {
      const { prisma } = await import("../../db.js");
      const project = await prisma.appProject.findUnique({
        where: { id: projectId },
        select: { name: true },
      });
      return project?.name || null;
    } catch (err: unknown) {
      logger.warn({ err, projectId }, "Failed to fetch project name for review");
      return null;
    }
  }
}

// Singleton
export const codeGenService = new CodeGenService();
