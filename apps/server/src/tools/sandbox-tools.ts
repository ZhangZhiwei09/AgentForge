// Sandbox tools — code_execute with Docker isolation
import type { ToolDefinition } from "@agentforge/shared-types";
import type { RegisteredTool } from "./types.js";
import type { RunContext } from "../runtime/context.js";
import type { ExecutionResult } from "../runtime/results.js";
import {
  successResult,
  partialResult,
  failedResult,
  ExecutionErrorCode,
} from "../runtime/results.js";
import { logger } from "@agentforge/logger";

// Tool definition for code_execute
const codeExecuteDef: ToolDefinition = {
  type: "function",
  function: {
    name: "code_execute",
    description:
      "Execute code in an isolated Docker sandbox. Supports Python and JavaScript. " +
      "The sandbox has no network access, limited memory (256MB), a 60-second timeout, " +
      "and runs as an unprivileged user with a read-only filesystem. " +
      "Use this for calculations, data processing, or running code examples. " +
      "IMPORTANT: This tool requires user approval before execution.",
    parameters: {
      type: "object",
      properties: {
        language: {
          type: "string",
          enum: ["python", "javascript"],
          description:
            "The programming language to use. 'python' for Python 3.12, 'javascript' for Node.js 22.",
        },
        code: {
          type: "string",
          description:
            "The source code to execute. Print or console.log outputs will be captured and returned.",
        },
      },
      required: ["language", "code"],
    },
  },
};

async function codeExecuteExecute(
  args: Record<string, unknown>,
  _context: RunContext,
): Promise<ExecutionResult> {
  const language = (args.language as string) || "";
  const code = (args.code as string) || "";

  if (!["python", "javascript"].includes(language)) {
    return failedResult(ExecutionErrorCode.INVALID_PARAM, `Unsupported language "${language}". Supported: python, javascript.`);
  }

  if (!code || code.trim().length === 0) {
    return failedResult(ExecutionErrorCode.INVALID_PARAM, "Code cannot be empty.");
  }

  if (code.length > 50_000) {
    return failedResult(ExecutionErrorCode.INVALID_PARAM, `Code too long (${code.length} chars). Maximum is 50,000 characters.`);
  }

  try {
    // Dynamic import — avoids loading dockerode at module parse time
    const { sandboxManager } = await import("../services/sandbox.js");

    if (!sandboxManager.isAvailable()) {
      return partialResult(
        JSON.stringify(
          {
            error: "Docker is not available on this server.",
            hint:
              "The code_execute tool requires Docker to be installed and running. " +
              "Build the sandbox image with: docker build -t agentforge-sandbox:latest -f infra/docker/Dockerfile.sandbox .",
            language,
            code_preview: code.slice(0, 200),
          },
          null,
          2,
        ),
        "Docker sandbox not available, returning error details",
      );
    }

    logger.info(
      { language, codeLength: code.length, codePreview: code.slice(0, 80) },
      "code_execute invoked",
    );

    const result = await sandboxManager.executeCode(
      language as "python" | "javascript",
      code,
    );

    const output = JSON.stringify(
      {
        language,
        exit_code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr || null,
        timed_out: result.timedOut,
        duration_ms: result.durationMs,
      },
      null,
      2,
    );

    if (result.timedOut) {
      return partialResult(output, "Code execution timed out in sandbox");
    }

    if (result.exitCode !== 0) {
      return partialResult(output, `Code exited with non-zero code: ${result.exitCode}`);
    }

    return successResult(output, { exitCode: result.exitCode, durationMs: result.durationMs });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error({ language, error: msg }, "code_execute failed");
    return failedResult(ExecutionErrorCode.EXECUTION_ERROR, `Error executing code (${language}): ${msg}`);
  }
}

export const sandboxTools: RegisteredTool[] = [
  {
    definition: codeExecuteDef,
    execute: codeExecuteExecute,
    riskLevel: "destructive",
    timeout: 65_000, // Slightly above sandbox timeout to allow for error messages
    requireApproval: true,
    category: "sandbox",
    parallelizable: false,
    sandbox: true,
  },
];
