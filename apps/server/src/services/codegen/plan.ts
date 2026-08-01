// CodeGen planning phase — file structure design and extraction
// Extracted from services/codegen.ts — Phase 3 file splitting

import type { ChatMessage } from "../../providers/types.js";
import type { AppFilePlan, ProjectLanguage } from "@agentforge/shared-types";
import { parseJSONFromLLMResponse } from "../../lib/json-utils.js";
import { logger } from "@agentforge/logger";
import type { CodeGenLLMCaller } from "./llm.js";
import { PLAN_SYSTEM_PROMPT, MAX_TOKENS_PLAN } from "./prompts.js";

/**
 * Phase 1: Plan the app structure via direct LLM prompt.
 */
export async function planAppStructure(
  prompt: string,
  framework: string,
  model: string,
  callLLM: CodeGenLLMCaller,
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
    const content = await callLLM(
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
    return extractFilePlan(content);
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : "Unknown error" }, "Plan LLM call failed");
    return null;
  }
}

/**
 * Extract file plan from LLM response JSON.
 */
export function extractFilePlan(text: string): AppFilePlan[] | null {
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
            (f.language as ProjectLanguage) || detectLang(f.path),
          description: String(f.description || ""),
        }));
      }
    } catch (e) {
      logger.warn(
        { error: e instanceof Error ? e.message : "Unknown error" },
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
          language: detectLang(p),
          description: "",
        });
      }
    }
  }

  return files.length > 0 ? files : null;
}

/**
 * Detect project language from file extension.
 */
export function detectLang(path: string): ProjectLanguage {
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
 * Default file plan — used as fallback when LLM planning fails.
 */
export function getDefaultPlan(framework: string): AppFilePlan[] {
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
