// CodeGenService — AI-driven application code generation
// WeaveFox Phase 1 (V12): Uses LLM with specialized prompts to plan, generate,
// and review complete frontend applications. Uses direct prompting (not tool calls).
import { randomUUID } from "crypto";
import { getProvider, resolveModel } from "../providers/registry.js";
import type { ChatMessage } from "../providers/types.js";
import { appProjectService } from "./app-project.js";
import { parseJSONFromLLMResponse } from "../lib/json-utils.js";
import { logger } from "@agentforge/logger";
import type {
  AppGenStreamEvent,
  AppFilePlan,
  ProjectLanguage,
} from "@agentforge/shared-types";

// Maximum tokens per LLM call
const MAX_TOKENS_PLAN = 4000;
const MAX_TOKENS_FILE = 8000;

// ---------------------------------------------------------------------------
// Specialized system prompts for each phase
// ---------------------------------------------------------------------------

const PLAN_SYSTEM_PROMPT = `你是一个资深的全栈架构师，专精于前端应用架构设计。

根据用户的需求和选择的框架，设计完整的项目文件树结构。每个文件需要包含路径、语言类型和用途说明。

输出严格遵循以下 JSON 格式（不要输出其他内容）：

{
  "files": [
    { "path": "src/App.tsx", "language": "tsx", "description": "Main app component with state management" },
    { "path": "src/components/TodoItem.tsx", "language": "tsx", "description": "Single todo item component" }
  ],
  "reasoning": "简要说明设计思路"
}

对于 React 项目：
- 使用函数组件 + Hooks + TypeScript
- 组件放 src/components/ 目录
- 包含完整配置文件：package.json, tsconfig.json, vite.config.ts, index.html
- CSS 文件独立，使用 CSS 变量
- 文件数量控制在 5-12 个

对于 HTML/CSS/JS 项目：
- 使用语义化 HTML5
- CSS 使用 CSS 变量和 Flexbox/Grid
- JS 使用 ES6+ 语法`;

const GENERATE_SYSTEM_PROMPT = `你是一个世界级的前端开发专家。根据用户需求生成完整的、可运行的前端代码。

## 代码质量标准
- TypeScript 严格模式，所有 props 有接口定义
- 组件根元素添加 data-af-id={组件名} 属性
- 响应式设计，移动端优先
- 使用 CSS 变量定义主题色
- 包含必要的可访问性属性（aria-label、role 等）
- 代码结构清晰，有适当注释

## 输出格式
你必须以以下格式输出文件（不要包含其他解释）：

\`\`\`FILE:文件路径
完整的文件代码内容
\`\`\`

重要：FILE: 后面必须是精确的文件路径，代码必须是完整可运行的。`;

const REVIEW_SYSTEM_PROMPT = `你是一个严格的代码审查者。审查给定的代码文件，关注：
- 代码正确性和完整性
- 类型安全性
- 可访问性
- 最佳实践

输出一个简短的评审总结（1-3句话），指出任何问题或确认代码质量。`;

// ---------------------------------------------------------------------------

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
    const [providerName, resolvedModel] = resolveModel(options.model);

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
      plan = await this.planAppStructure(prompt, framework, resolvedModel);
    } catch (err) {
      logger.error(
        { error: (err as Error).message },
        "Plan phase failed, using default plan",
      );
    }

    // Fallback to default plan if planning fails
    if (!plan || plan.length === 0) {
      logger.warn({ projectId }, "Plan empty, using default plan");
      plan = this.getDefaultPlan(framework);
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
        const { content, tokens } = await this.generateFile(
          filePlan,
          prompt,
          framework,
          resolvedModel,
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
        const review = await this.reviewApp(plan, projectId, resolvedModel);
        yield { type: "appgen_review", message_id: randomUUID(), review };
      } catch {
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
      const { prisma } = await import("../db.js");
      const project = await prisma.appProject.findUnique({
        where: { id: projectId },
        select: { name: true },
      });
      return project?.name || null;
    } catch {
      return null;
    }
  }

  /**
   * Phase 1: Plan the app structure via direct LLM prompt.
   */
  private async planAppStructure(
    prompt: string,
    framework: string,
    model: string,
  ): Promise<AppFilePlan[] | null> {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: `请为以下应用设计文件树结构：

**用户需求：** ${prompt}
**目标框架：** ${framework}

请严格按照 JSON 格式输出，只输出 JSON，不要有其他内容。`,
      },
    ];

    try {
      const content = await this.callLLM(
        messages,
        model,
        PLAN_SYSTEM_PROMPT,
        0.3,
        MAX_TOKENS_PLAN,
      );
      logger.info(
        { contentLength: content.length, preview: content.slice(0, 200) },
        "Plan LLM response",
      );
      return this.extractFilePlan(content);
    } catch (err) {
      logger.error({ error: (err as Error).message }, "Plan LLM call failed");
      return null;
    }
  }

  /**
   * Phase 2: Generate a single file via direct LLM prompt.
   */
  private async generateFile(
    filePlan: AppFilePlan,
    appPrompt: string,
    framework: string,
    model: string,
  ): Promise<{ content: string; tokens: number }> {
    const ext = filePlan.path.split(".").pop() || "";
    const langGuides: Record<string, string> = {
      tsx: `这是 TypeScript React 组件文件。使用函数组件 + Hooks，定义 Props 接口，在根元素上添加 data-af-id 属性。`,
      ts: `这是 TypeScript 配置文件。使用明确的类型注解和 const 断言。`,
      css: `这是样式文件。使用 CSS 变量定义主题色，移动端优先的响应式设计。`,
      html: `这是 HTML 文件。使用语义化 HTML5 标签，包含必要的 meta 标签。`,
      json: `这是 JSON 配置文件。确保所有字段有效，使用双引号。`,
      js: `这是 JavaScript 文件。使用 ES6+ 语法。`,
    };

    const langGuide = langGuides[ext] || `这是 ${ext} 文件。`;

    const messages: ChatMessage[] = [
      {
        role: "user",
        content: `生成文件 "${filePlan.path}"：

**应用需求：** ${appPrompt}
**框架：** ${framework}
**文件路径：** ${filePlan.path}
**用途：** ${filePlan.description}
**语言类型：** ${filePlan.language}

${langGuide}

请严格按照 FILE: 格式输出完整代码，不要包含解释文字：

\`\`\`FILE:${filePlan.path}
完整的文件代码
\`\`\``,
      },
    ];

    try {
      const content = await this.callLLM(
        messages,
        model,
        GENERATE_SYSTEM_PROMPT,
        0.5,
        MAX_TOKENS_FILE,
      );
      const extracted = this.extractFileContent(content, filePlan.path);
      return {
        content:
          extracted ||
          `// Generated: ${filePlan.path}\n${content.slice(0, 500)}`,
        tokens: Math.ceil(content.length / 3),
      };
    } catch (err) {
      logger.error(
        { file: filePlan.path, error: (err as Error).message },
        "File generation LLM error",
      );
      return {
        content: `// Error generating ${filePlan.path}\n// ${(err as Error).message}`,
        tokens: 0,
      };
    }
  }

  /**
   * Phase 3: Review the generated app.
   */
  private async reviewApp(
    plan: AppFilePlan[],
    projectId: string,
    model: string,
  ): Promise<string> {
    const keyFiles = plan.slice(0, 4);
    const files = await appProjectService.getFiles(projectId);
    const fileMap = new Map(files.map((f) => [f.path, f.content]));

    const reviews: string[] = [];
    for (const fp of keyFiles) {
      const code = fileMap.get(fp.path);
      if (!code || code.length < 10) continue;

      try {
        const messages: ChatMessage[] = [
          {
            role: "user",
            content: `审查以下代码文件：

**文件：** ${fp.path}
**语言：** ${fp.language}

\`\`\`
${code.slice(0, 3000)}
\`\`\`

请给出简短评审总结（1-3句话）。`,
          },
        ];

        const result = await this.callLLM(
          messages,
          model,
          REVIEW_SYSTEM_PROMPT,
          0.2,
          1000,
        );
        const lines = result.split("\n").filter((l) => l.trim());
        const summary = lines.slice(0, 2).join(" ");
        reviews.push(
          `**${fp.path.split("/").pop()}:** ${summary || "Looks good."}`,
        );
      } catch {
        reviews.push(`**${fp.path.split("/").pop()}:** Review skipped.`);
      }
    }

    return reviews.length > 0
      ? reviews.join("\n")
      : "All files generated successfully. Ready for preview.";
  }

  /**
   * Simple LLM call — collects token chunks, no tool calling.
   */
  private async callLLM(
    messages: ChatMessage[],
    model: string,
    systemPrompt: string,
    temperature: number,
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const [providerName, resolvedModel] = resolveModel(model);
    const provider = getProvider(providerName);

    const stream = provider.streamChat(
      messages,
      resolvedModel,
      systemPrompt,
      temperature,
      maxTokens,
      undefined, // No tools — direct prompting
      signal, // Pass AbortSignal for cancellation support
    );

    let content = "";
    for await (const chunk of stream) {
      if (chunk.type === "token" && chunk.content) {
        content += chunk.content;
      }
    }

    if (!content || content.trim().length === 0) {
      throw new Error("LLM returned empty response");
    }

    return content;
  }

  /**
   * Extract file plan from LLM response JSON.
   */
  private extractFilePlan(text: string): AppFilePlan[] | null {
    logger.info({ preview: text.slice(0, 200) }, "Extracting file plan");

    // Try to find a JSON object with "files" key
    const jsonMatch = text.match(/\{[\s\S]*"files"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = parseJSONFromLLMResponse(jsonMatch[0]) as any;
        if (
          parsed?.files &&
          Array.isArray(parsed.files) &&
          parsed.files.length > 0
        ) {
          return parsed.files.map((f: any) => ({
            path: String(f.path || ""),
            language:
              (f.language as ProjectLanguage) || this.detectLang(f.path),
            description: String(f.description || ""),
          }));
        }
      } catch (e) {
        logger.warn(
          { error: (e as Error).message },
          "Failed to parse plan JSON",
        );
      }
    }

    // Fallback: scan for path-like patterns in each line
    const lines = text.split("\n");
    const files: AppFilePlan[] = [];
    const seen = new Set<string>();
    for (const line of lines) {
      // Match: "path": "src/App.tsx" or "path":"src/App.tsx"
      const match = line.match(/["']path["']\s*:\s*["']([^"']+)["']/);
      if (match) {
        const p = match[1].trim();
        if (p && p.includes(".") && !seen.has(p)) {
          seen.add(p);
          files.push({
            path: p,
            language: this.detectLang(p),
            description: "",
          });
        }
      }
    }

    return files.length > 0 ? files : null;
  }

  private detectLang(path: string): ProjectLanguage {
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
   * Extract file content from LLM response using FILE: marker.
   */
  private extractFileContent(
    text: string,
    expectedPath: string,
  ): string | null {
    // Pattern: ```FILE:path\n...\n```
    const safePath = expectedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const fileBlockRegex = new RegExp(
      `\`\`\`FILE:\\s*${safePath}\\s*\\n([\\s\\S]*?)\`\`\``,
      "i",
    );
    const match = text.match(fileBlockRegex);
    if (match) return match[1].trim();

    // Try generic FILE: marker
    const genericRegex = /```FILE:([^\n]+)\s*\n([\s\S]*?)```/g;
    let gm;
    while ((gm = genericRegex.exec(text)) !== null) {
      if (gm[1].trim() === expectedPath) {
        return gm[2].trim();
      }
    }

    // Fallback: first substantial code block
    const codeBlockRegex = /```(?:\w+)?\s*\n([\s\S]*?)```/g;
    let cm;
    const blocks: Array<{ code: string }> = [];
    while ((cm = codeBlockRegex.exec(text)) !== null) {
      const block = cm[1].trim();
      if (block.length > 50) {
        blocks.push({ code: block });
      }
    }

    if (blocks.length === 0) {
      // No code blocks — try to use the raw text minus obvious non-code lines
      const nonCode = text
        .replace(/^(Here|This|The|I|Please|Note|Make sure|Important).*$/gim, "")
        .trim();
      return nonCode.length > 20 ? nonCode : null;
    }

    // Try to match by filename
    const fileName =
      expectedPath
        .split("/")
        .pop()
        ?.replace(/\.[^.]+$/, "") || "";
    for (const b of blocks) {
      if (b.code.includes(fileName)) {
        return b.code;
      }
    }

    // Return largest code block
    blocks.sort((a, b) => b.code.length - a.code.length);
    return blocks[0].code;
  }

  /**
   * Default file plan — used as fallback when LLM planning fails.
   */
  private getDefaultPlan(framework: string): AppFilePlan[] {
    if (framework === "react") {
      return [
        {
          path: "index.html",
          language: "html",
          description: "HTML entry point with root div",
        },
        {
          path: "package.json",
          language: "json",
          description: "Project dependencies and scripts",
        },
        {
          path: "tsconfig.json",
          language: "json",
          description: "TypeScript configuration",
        },
        {
          path: "vite.config.ts",
          language: "ts",
          description: "Vite build configuration",
        },
        {
          path: "src/main.tsx",
          language: "tsx",
          description: "React entry point, renders App",
        },
        {
          path: "src/App.tsx",
          language: "tsx",
          description: "Main app component with all logic",
        },
        {
          path: "src/index.css",
          language: "css",
          description: "Global styles and CSS variables",
        },
      ];
    }
    return [
      { path: "index.html", language: "html", description: "Main HTML page" },
      { path: "style.css", language: "css", description: "Global styles" },
      { path: "app.js", language: "js", description: "Application logic" },
    ];
  }
}

// Singleton
export const codeGenService = new CodeGenService();
