// CodeGen file generation phase — single file generation and content extraction
// Extracted from services/codegen.ts — Phase 3 file splitting

import type { ChatMessage } from "../../providers/types.js";
import type { AppFilePlan } from "@agentforge/shared-types";
import { logger } from "@agentforge/logger";
import type { CodeGenLLMCaller } from "./llm.js";
import { GENERATE_SYSTEM_PROMPT, MAX_TOKENS_FILE } from "./prompts.js";

/**
 * Phase 2: Generate a single file via direct LLM prompt.
 */
export async function generateFile(
  filePlan: AppFilePlan,
  appPrompt: string,
  framework: string,
  model: string,
  callLLM: CodeGenLLMCaller,
  langGuides: Record<string, string>,
): Promise<{ content: string; tokens: number }> {
  const ext = filePlan.path.split(".").pop() || "";
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
    const content = await callLLM(
      messages,
      model,
      GENERATE_SYSTEM_PROMPT,
      0.5,
      MAX_TOKENS_FILE,
    );
    const extracted = extractFileContent(content, filePlan.path);
    return {
      content:
        extracted ||
        `// Generated: ${filePlan.path}\n${content.slice(0, 500)}`,
      tokens: Math.ceil(content.length / 3),
    };
  } catch (err) {
    logger.error(
      { file: filePlan.path, error: err instanceof Error ? err.message : "Unknown error" },
      "File generation LLM error",
    );
    return {
      content: `// Error generating ${filePlan.path}\n// ${err instanceof Error ? err.message : "Unknown error"}`,
      tokens: 0,
    };
  }
}

/**
 * Extract file content from LLM response using FILE: marker.
 */
export function extractFileContent(
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
