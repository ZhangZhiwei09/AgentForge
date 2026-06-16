// CodeGen review phase — generated code quality assessment
// Extracted from services/codegen.ts — Phase 3 file splitting

import type { ChatMessage } from "../../providers/types.js";
import type { AppFilePlan } from "@agentforge/shared-types";
import { logger } from "@agentforge/logger";
import type { CodeGenLLMCaller } from "./llm.js";
import { REVIEW_SYSTEM_PROMPT } from "./prompts.js";

/**
 * Phase 3: Review the generated app.
 */
export async function reviewApp(
  plan: AppFilePlan[],
  projectId: string,
  model: string,
  callLLM: CodeGenLLMCaller,
  getFiles: (projectId: string) => Promise<Array<{ path: string; content: string }>>,
): Promise<string> {
  const keyFiles = plan.slice(0, 4);
  const files = await getFiles(projectId);
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

      const result = await callLLM(
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
    } catch (err: unknown) {
      logger.warn({ err, filePath: fp.path }, "Failed to review file");
      reviews.push(`**${fp.path.split("/").pop()}:** Review skipped.`);
    }
  }

  return reviews.length > 0
    ? reviews.join("\n")
    : "All files generated successfully. Ready for preview.";
}
