// File system tools — file_read, file_write, file_search
// Restricted to a configurable workspace directory for safety
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join, normalize, basename } from "node:path";
import { glob } from "node:fs/promises"; // Note: glob is available in Node 22+
import type { ToolDefinition } from "@agentforge/shared-types";
import type { RegisteredTool } from "./types.js";

// Workspace root — all file operations are restricted to this directory
// Default: project root. Override with FILE_WORKSPACE env var.
const WORKSPACE_ROOT = resolve(
  process.env.FILE_WORKSPACE || process.cwd(),
);

function safeResolve(userPath: string): string {
  const resolved = resolve(WORKSPACE_ROOT, userPath.replace(/^[\/\\]+/, ""));
  // Ensure the resolved path is within WORKSPACE_ROOT
  if (!resolved.startsWith(WORKSPACE_ROOT)) {
    throw new Error(
      `Access denied: path "${userPath}" is outside the workspace`,
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// 5. file_read — read file contents
// ---------------------------------------------------------------------------

const fileReadDef: ToolDefinition = {
  type: "function",
  function: {
    name: "file_read",
    description:
      "Read the contents of a file. The path is relative to the workspace root. Returns the file content as a string. Use this to inspect source code, configuration files, or any text-based file.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Relative path to the file (e.g. 'src/index.ts', 'README.md'). Only files within the workspace can be read.",
        },
        max_lines: {
          type: "number",
          description:
            "Maximum number of lines to read (default 500, max 2000). Used to prevent reading huge files.",
        },
      },
      required: ["path"],
    },
  },
};

async function fileReadExecute(
  args: Record<string, unknown>,
): Promise<string> {
  const userPath = (args.path as string) || "";
  const maxLines = Math.min(
    Math.max(1, (args.max_lines as number) || 500),
    2000,
  );

  if (!userPath.trim()) return "Error: file path is required";

  try {
    const filePath = safeResolve(userPath);

    if (!existsSync(filePath)) {
      return `Error: file not found: "${userPath}"`;
    }

    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n");

    if (lines.length > maxLines) {
      const truncated = lines.slice(0, maxLines).join("\n");
      return `${truncated}\n\n... (truncated — ${lines.length - maxLines} more lines. Use max_lines to read more.)`;
    }

    return content;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return `Error reading file "${userPath}": ${msg}`;
  }
}

// ---------------------------------------------------------------------------
// 6. file_write — write content to a file
// ---------------------------------------------------------------------------

const fileWriteDef: ToolDefinition = {
  type: "function",
  function: {
    name: "file_write",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Parent directories are created automatically. Restricted to the workspace directory. Use with caution — this modifies the filesystem.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Relative path to the file (e.g. 'output/result.txt'). The file will be created within the workspace.",
        },
        content: {
          type: "string",
          description: "The content to write to the file.",
        },
      },
      required: ["path", "content"],
    },
  },
};

async function fileWriteExecute(
  args: Record<string, unknown>,
): Promise<string> {
  const userPath = (args.path as string) || "";
  const content = (args.content as string) || "";

  if (!userPath.trim()) return "Error: file path is required";

  try {
    const filePath = safeResolve(userPath);

    // Ensure parent directory exists
    const dir = filePath.substring(0, filePath.lastIndexOf("\\") > -1
      ? filePath.lastIndexOf("\\")
      : filePath.lastIndexOf("/"));
    if (dir && !existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    await writeFile(filePath, content, "utf-8");
    return `File written successfully: "${userPath}" (${content.length} characters)`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return `Error writing file "${userPath}": ${msg}`;
  }
}

// ---------------------------------------------------------------------------
// 7. file_search — search for files by name or content
// ---------------------------------------------------------------------------

const fileSearchDef: ToolDefinition = {
  type: "function",
  function: {
    name: "file_search",
    description:
      "Search for files in the workspace by name pattern or content. Returns matching file paths. Use this to find source files, configuration, or any files matching a pattern.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "Glob pattern to match file names (e.g. '**/*.ts', 'src/**/*.test.*'). Defaults to '**/*'.",
        },
        contains: {
          type: "string",
          description:
            "Optional text to search for within file contents. Only files containing this text will be returned.",
        },
        max_results: {
          type: "number",
          description: "Maximum number of results (default 20, max 100).",
        },
      },
      required: [],
    },
  },
};

async function fileSearchExecute(
  args: Record<string, unknown>,
): Promise<string> {
  const pattern = (args.pattern as string) || "**/*";
  const contains = (args.contains as string) || undefined;
  const maxResults = Math.min(
    Math.max(1, (args.max_results as number) || 20),
    100,
  );

  try {
    // Use glob to find files matching the pattern
    const searchPattern = join(WORKSPACE_ROOT, pattern).replace(/\\/g, "/");

    // Simple glob-based file search using Node's fs
    let matches: string[] = [];

    // Use a simplified approach — scan for files matching the pattern
    const { readdir, stat } = await import("node:fs/promises");

    async function scanDir(dir: string, currentPattern: string): Promise<void> {
      if (matches.length >= maxResults) return;

      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (matches.length >= maxResults) return;
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            await scanDir(fullPath, currentPattern);
          } else if (entry.isFile()) {
            const relPath = fullPath.replace(WORKSPACE_ROOT, "").replace(/^[\/\\]/, "");
            // Simple glob matching
            if (matchSimpleGlob(relPath, currentPattern)) {
              // If content search is requested, check file contents
              if (contains) {
                try {
                  const content = await readFile(fullPath, "utf-8");
                  if (content.includes(contains)) {
                    matches.push(relPath);
                  }
                } catch {
                  // Skip unreadable files
                }
              } else {
                matches.push(relPath);
              }
            }
          }
        }
      } catch {
        // Skip inaccessible directories
      }
    }

    await scanDir(WORKSPACE_ROOT, pattern);

    return JSON.stringify({
      pattern,
      contains: contains || null,
      matches: matches.slice(0, maxResults),
      total: matches.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return `Error searching files: ${msg}`;
  }
}

// Simplified glob matching (supports **, *, ?)
function matchSimpleGlob(filePath: string, pattern: string): boolean {
  // Convert glob to regex
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape special regex chars except glob
    .replace(/\*\*\/?/g, "___DOUBLESTAR___") // Temp placeholder for **
    .replace(/\*/g, "[^/\\\\]*") // * matches anything except path separators
    .replace(/\?/g, "[^/\\\\]") // ? matches single char except path separators
    .replace(/___DOUBLESTAR___/g, ".*"); // ** matches anything including path separators

  const regex = new RegExp(`^${regexStr}$`, "i");
  return regex.test(filePath);
}

// ---------------------------------------------------------------------------
// Export file tools
// ---------------------------------------------------------------------------

export const fileTools: RegisteredTool[] = [
  {
    definition: fileReadDef,
    execute: fileReadExecute,
    riskLevel: "safe",
    timeout: 10_000,
    requireApproval: false,
    category: "file",
  },
  {
    definition: fileWriteDef,
    execute: fileWriteExecute,
    riskLevel: "destructive",
    timeout: 10_000,
    requireApproval: true, // Requires human approval
    category: "file",
  },
  {
    definition: fileSearchDef,
    execute: fileSearchExecute,
    riskLevel: "read_only",
    timeout: 15_000,
    requireApproval: false,
    category: "file",
  },
];
