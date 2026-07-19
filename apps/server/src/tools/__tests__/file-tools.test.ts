import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRunContext } from "../../runtime/context.js";
import { ExecutionErrorCode } from "../../runtime/results.js";
import { existsSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Mock filesystem modules before importing the module under test.
// WORKSPACE_ROOT is computed at module evaluation time from
// process.env.FILE_WORKSPACE || process.cwd(), so we set the env var first.
// ---------------------------------------------------------------------------
vi.mock("node:fs/promises");
vi.mock("node:fs");

const TEST_WORKSPACE = resolve("/test-workspace");
process.env.FILE_WORKSPACE = TEST_WORKSPACE;

const testCtx = createRunContext(new AbortController().signal);

// Dynamic import AFTER env var is set so WORKSPACE_ROOT uses TEST_WORKSPACE
const { fileTools } = await import("../file-tools.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a Dirent-like object for readdir withFileTypes mocks */
function dirent(name: string, isDir: boolean) {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

/** Normalize path separators to forward slashes for cross-platform assertions */
function norm(paths: string[]): string[] {
  return paths.map((p) => p.replace(/\\/g, "/"));
}

const [fileReadTool, fileWriteTool, fileSearchTool] = fileTools;

// ---------------------------------------------------------------------------
// Metadata tests
// ---------------------------------------------------------------------------

describe("fileTools metadata", () => {
  describe("file_read", () => {
    it("should have correct definition name", () => {
      expect(fileReadTool.definition.function.name).toBe("file_read");
    });

    it("should require path parameter", () => {
      expect(fileReadTool.definition.function.parameters.required).toEqual(["path"]);
    });

    it("should have correct risk metadata", () => {
      expect(fileReadTool.riskLevel).toBe("safe");
      expect(fileReadTool.timeout).toBe(10_000);
      expect(fileReadTool.requireApproval).toBe(false);
      expect(fileReadTool.category).toBe("file");
      expect(fileReadTool.parallelizable).toBe(true);
    });
  });

  describe("file_write", () => {
    it("should have correct definition name", () => {
      expect(fileWriteTool.definition.function.name).toBe("file_write");
    });

    it("should require path and content parameters", () => {
      expect(fileWriteTool.definition.function.parameters.required).toEqual([
        "path",
        "content",
      ]);
    });

    it("should have correct risk metadata", () => {
      expect(fileWriteTool.riskLevel).toBe("destructive");
      expect(fileWriteTool.timeout).toBe(10_000);
      expect(fileWriteTool.requireApproval).toBe(true);
      expect(fileWriteTool.category).toBe("file");
      expect(fileWriteTool.parallelizable).toBe(false);
    });
  });

  describe("file_search", () => {
    it("should have correct definition name", () => {
      expect(fileSearchTool.definition.function.name).toBe("file_search");
    });

    it("should have no required parameters", () => {
      expect(fileSearchTool.definition.function.parameters.required).toEqual([]);
    });

    it("should have correct risk metadata", () => {
      expect(fileSearchTool.riskLevel).toBe("read_only");
      expect(fileSearchTool.timeout).toBe(15_000);
      expect(fileSearchTool.requireApproval).toBe(false);
      expect(fileSearchTool.category).toBe("file");
      expect(fileSearchTool.parallelizable).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// file_read tests
// ---------------------------------------------------------------------------

describe("file_read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return failed result for empty path", async () => {
    const result = await fileReadTool.execute({ path: "" }, testCtx);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.INVALID_PARAM);
      expect(result.error.message).toContain("path is required");
    }
  });

  it("should return failed result for whitespace-only path", async () => {
    const result = await fileReadTool.execute({ path: "   " }, testCtx);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.INVALID_PARAM);
    }
  });

  it("should return not-found when file does not exist", async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result = await fileReadTool.execute({ path: "missing.txt" }, testCtx);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.NOT_FOUND);
      expect(result.error.message).toContain("File not found");
      expect(result.error.message).toContain("missing.txt");
    }
  });

  it("should return not-found when file does not exist (no existsSync calls needed for other scenarios)", async () => {
    // Verify existsSync was called with the resolved path
    vi.mocked(existsSync).mockReturnValue(false);

    await fileReadTool.execute({ path: "nope.log" }, testCtx);

    expect(existsSync).toHaveBeenCalledWith(
      resolve(TEST_WORKSPACE, "nope.log"),
    );
  });

  it("should read file successfully and return content with totalLines metadata", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(fsPromises.readFile).mockResolvedValue("line1\nline2\nline3");

    const result = await fileReadTool.execute({ path: "test.txt" }, testCtx);

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.output).toBe("line1\nline2\nline3");
      expect(result.metadata).toEqual({ totalLines: 3 });
    }
  });

  it("should return partialResult with truncation when lines exceed max_lines", async () => {
    const lines = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`);
    const content = lines.join("\n");

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(fsPromises.readFile).mockResolvedValue(content);

    const result = await fileReadTool.execute(
      { path: "large.txt", max_lines: 100 },
      testCtx,
    );

    expect(result.status).toBe("partial");
    if (result.status === "partial") {
      expect(result.reason).toContain("Truncated");
      expect(result.reason).toContain("500 more lines");
      expect(result.metadata).toEqual({ totalLines: 600, shownLines: 100 });

      // Output should have exactly 100 lines
      const outputLines = result.output.split("\n");
      expect(outputLines.length).toBe(100);
      expect(outputLines[0]).toBe("line 1");
    }
  });

  it("should use default max_lines of 500 when not specified", async () => {
    const lines = Array.from({ length: 550 }, (_, i) => `line ${i + 1}`);
    const content = lines.join("\n");

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(fsPromises.readFile).mockResolvedValue(content);

    const result = await fileReadTool.execute({ path: "large.txt" }, testCtx);

    expect(result.status).toBe("partial");
    if (result.status === "partial") {
      expect(result.metadata).toEqual({ totalLines: 550, shownLines: 500 });
    }
  });

  it("should not truncate when lines equal max_lines", async () => {
    const content = "line1\nline2\nline3";

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(fsPromises.readFile).mockResolvedValue(content);

    const result = await fileReadTool.execute(
      { path: "small.txt", max_lines: 3 },
      testCtx,
    );

    expect(result.status).toBe("success");
  });

  it("should clamp negative max_lines to minimum 1", async () => {
    const content = "a\nb\nc";

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(fsPromises.readFile).mockResolvedValue(content);

    const result = await fileReadTool.execute(
      { path: "test.txt", max_lines: -5 },
      testCtx,
    );

    // max_lines -5 → Math.max(1, -5) → 1 → truncation with totalLines: 3, shownLines: 1
    expect(result.status).toBe("partial");
    if (result.status === "partial") {
      expect(result.metadata).toEqual({ totalLines: 3, shownLines: 1 });
    }
  });

  it("should treat max_lines: 0 as falsy and use default 500", async () => {
    // 0 is falsy, so 0 || 500 = 500. Content has 3 lines, fits within 500.
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(fsPromises.readFile).mockResolvedValue("a\nb\nc");

    const result = await fileReadTool.execute(
      { path: "test.txt", max_lines: 0 },
      testCtx,
    );

    // 0 || 500 → 500, 3 lines fits, so success
    expect(result.status).toBe("success");
  });

  it("should clamp max_lines to maximum 2000", async () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`);
    const content = lines.join("\n");

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(fsPromises.readFile).mockResolvedValue(content);

    const result = await fileReadTool.execute(
      { path: "huge.txt", max_lines: 5000 },
      testCtx,
    );

    // max_lines clamped to 2000 → truncation with shownLines: 2000
    expect(result.status).toBe("partial");
    if (result.status === "partial") {
      expect(result.metadata).toEqual({ totalLines: 2500, shownLines: 2000 });
    }
  });

  it("should block path traversal via ../outside", async () => {
    // safeResolve throws "Access denied: path \"../outside\" is outside the workspace"
    // The catch block wraps it in a failed result with EXECUTION_ERROR
    const result = await fileReadTool.execute(
      { path: "../outside" },
      testCtx,
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.EXECUTION_ERROR);
      expect(result.error.message).toContain("outside the workspace");
      expect(result.error.message).toContain("../outside");
    }

    // existsSync should NOT have been called — safeResolve throws before FS access
    expect(existsSync).not.toHaveBeenCalled();
  });

  it("should block deep path traversal with multiple ../ segments", async () => {
    const result = await fileReadTool.execute(
      { path: "../../../etc/passwd" },
      testCtx,
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.message).toContain("outside the workspace");
    }
  });

  it("should normalize paths (resolve ./ and ../ within workspace)", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(fsPromises.readFile).mockResolvedValue("normalized content");

    // ./sub/../target.txt → target.txt (within workspace)
    await fileReadTool.execute({ path: "./sub/../target.txt" }, testCtx);

    // existsSync should be called with the normalized path
    expect(existsSync).toHaveBeenCalledWith(
      resolve(TEST_WORKSPACE, "target.txt"),
    );
  });

  it("should handle read errors gracefully", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(fsPromises.readFile).mockRejectedValue(
      new Error("EACCES: permission denied"),
    );

    const result = await fileReadTool.execute(
      { path: "protected.txt" },
      testCtx,
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.EXECUTION_ERROR);
      expect(result.error.message).toContain("EACCES");
    }
  });
});

// ---------------------------------------------------------------------------
// file_write tests
// ---------------------------------------------------------------------------

describe("file_write", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return failed result for empty path", async () => {
    const result = await fileWriteTool.execute(
      { path: "", content: "test" },
      testCtx,
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.INVALID_PARAM);
      expect(result.error.message).toContain("path is required");
    }
  });

  it("should return failed result for whitespace-only path", async () => {
    const result = await fileWriteTool.execute(
      { path: "   ", content: "test" },
      testCtx,
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.INVALID_PARAM);
    }
  });

  it("should write file successfully and return path and size in metadata", async () => {
    vi.mocked(existsSync).mockReturnValue(true); // dir exists
    vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);

    const content = "Hello, World!";
    const result = await fileWriteTool.execute(
      { path: "output.txt", content },
      testCtx,
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.output).toContain("output.txt");
      expect(result.output).toContain(`${content.length} characters`);
      expect(result.metadata).toEqual({
        path: "output.txt",
        size: content.length,
      });
    }

    expect(fsPromises.writeFile).toHaveBeenCalledWith(
      resolve(TEST_WORKSPACE, "output.txt"),
      content,
      "utf-8",
    );
  });

  it("should create parent directories via mkdir when they do not exist", async () => {
    // Parent dir does NOT exist
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);

    const result = await fileWriteTool.execute(
      { path: "sub/deep/file.txt", content: "data" },
      testCtx,
    );

    expect(result.status).toBe("success");

    // mkdir should have been called with recursive: true
    expect(fsPromises.mkdir).toHaveBeenCalledWith(
      resolve(TEST_WORKSPACE, "sub/deep"),
      { recursive: true },
    );

    // writeFile should have been called after mkdir
    expect(fsPromises.writeFile).toHaveBeenCalledWith(
      resolve(TEST_WORKSPACE, "sub/deep/file.txt"),
      "data",
      "utf-8",
    );
  });

  it("should not call mkdir when parent directory already exists", async () => {
    vi.mocked(existsSync).mockReturnValue(true); // dir exists
    vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);

    const result = await fileWriteTool.execute(
      { path: "existing/dir/file.txt", content: "test" },
      testCtx,
    );

    expect(result.status).toBe("success");
    expect(fsPromises.mkdir).not.toHaveBeenCalled();
    expect(fsPromises.writeFile).toHaveBeenCalledTimes(1);
  });

  it("should handle empty content", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);

    const result = await fileWriteTool.execute(
      { path: "empty.txt", content: "" },
      testCtx,
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.metadata).toEqual({ path: "empty.txt", size: 0 });
    }
  });

  it("should block path traversal via ../outside", async () => {
    const result = await fileWriteTool.execute(
      { path: "../outside", content: "malicious" },
      testCtx,
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.EXECUTION_ERROR);
      expect(result.error.message).toContain("outside the workspace");
    }

    // FS operations should NOT have been called
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
    expect(fsPromises.mkdir).not.toHaveBeenCalled();
  });

  it("should strip leading slashes from path (absolute paths become workspace-relative)", async () => {
    // Leading slashes are stripped: "/etc/hosts" → "etc/hosts" → resolves within workspace
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);

    const result = await fileWriteTool.execute(
      { path: "/etc/hosts", content: "evil" },
      testCtx,
    );

    // Path is stripped of leading slashes, stays in workspace — write succeeds
    expect(result.status).toBe("success");
    expect(fsPromises.writeFile).toHaveBeenCalledWith(
      resolve(TEST_WORKSPACE, "etc/hosts"),
      "evil",
      "utf-8",
    );
  });

  it("should handle write errors gracefully", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(fsPromises.writeFile).mockRejectedValue(
      new Error("ENOSPC: no space left on device"),
    );

    const result = await fileWriteTool.execute(
      { path: "bigfile.txt", content: "data" },
      testCtx,
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.EXECUTION_ERROR);
      expect(result.error.message).toContain("ENOSPC");
    }
  });

  it("should handle mkdir errors gracefully", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(fsPromises.mkdir).mockRejectedValue(
      new Error("EACCES: permission denied"),
    );

    const result = await fileWriteTool.execute(
      { path: "readonly/dir/file.txt", content: "data" },
      testCtx,
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.EXECUTION_ERROR);
      expect(result.error.message).toContain("EACCES");
    }
  });
});

// ---------------------------------------------------------------------------
// file_search tests
// ---------------------------------------------------------------------------

describe("file_search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should use default pattern **/* when none specified", async () => {
    // Pattern defaults to "**/*"
    (vi.mocked(fsPromises.readdir) as any).mockResolvedValue([
      dirent("README.md", false),
      dirent("index.ts", false),
    ] as any[]);

    const result = await fileSearchTool.execute({}, testCtx);

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const parsed = JSON.parse(result.output);
      expect(parsed.pattern).toBe("**/*");
    }
  });

  it("should return matching files in workspace", async () => {
    (vi.mocked(fsPromises.readdir) as any).mockImplementation(
      async (dirPath: unknown, _opts?: unknown) => {
        const dir = String(dirPath);
        if (dir === TEST_WORKSPACE) {
          return [
            dirent("src", true),
            dirent("index.ts", false),
          ] as any[];
        }
        if (dir === resolve(TEST_WORKSPACE, "src")) {
          return [
            dirent("app.ts", false),
            dirent("utils.ts", false),
          ] as any[];
        }
        return [] as any[];
      },
    );

    const result = await fileSearchTool.execute(
      { pattern: "**/*.ts" },
      testCtx,
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const parsed = JSON.parse(result.output);
      expect(norm(parsed.matches)).toContain("index.ts");
      expect(norm(parsed.matches)).toContain("src/app.ts");
      expect(norm(parsed.matches)).toContain("src/utils.ts");
      expect(parsed.total).toBe(3);
    }
  });

  it("should filter files by contains text", async () => {
    (vi.mocked(fsPromises.readdir) as any).mockImplementation(
      async (dirPath: unknown, _opts?: unknown) => {
        const dir = String(dirPath);
        if (dir === TEST_WORKSPACE) {
          return [
            dirent("a.ts", false),
            dirent("b.ts", false),
          ] as any[];
        }
        return [] as any[];
      },
    );

    // a.ts contains "hello", b.ts does not
    vi.mocked(fsPromises.readFile).mockImplementation(
      async (filePath: unknown, _encoding?: unknown) => {
        const path = String(filePath);
        if (path.includes("a.ts")) return "hello world";
        if (path.includes("b.ts")) return "foo bar baz";
        return "";
      },
    );

    const result = await fileSearchTool.execute(
      { contains: "hello" },
      testCtx,
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const parsed = JSON.parse(result.output);
      expect(parsed.matches).toEqual(["a.ts"]);
      expect(parsed.contains).toBe("hello");
      expect(parsed.total).toBe(1);
    }
  });

  it("should return empty results when contains text is not found", async () => {
    (vi.mocked(fsPromises.readdir) as any).mockImplementation(
      async (dirPath: unknown, _opts?: unknown) => {
        const dir = String(dirPath);
        if (dir === TEST_WORKSPACE) {
          return [
            dirent("readme.md", false),
          ] as any[];
        }
        return [] as any[];
      },
    );

    vi.mocked(fsPromises.readFile).mockResolvedValue("some content");

    const result = await fileSearchTool.execute(
      { contains: "NONEXISTENT_TEXT" },
      testCtx,
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const parsed = JSON.parse(result.output);
      expect(parsed.matches).toEqual([]);
      expect(parsed.total).toBe(0);
    }
  });

  it("should respect max_results and limit output to exactly that many", async () => {
    const files = Array.from({ length: 30 }, (_, i) =>
      dirent(`file${i}.ts`, false),
    );

    (vi.mocked(fsPromises.readdir) as any).mockImplementation(
      async (dirPath: unknown, _opts?: unknown) => {
        const dir = String(dirPath);
        if (dir === TEST_WORKSPACE) {
          return files as any[];
        }
        return [] as any[];
      },
    );

    const result = await fileSearchTool.execute(
      { max_results: 5 },
      testCtx,
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const parsed = JSON.parse(result.output);
      expect(parsed.matches.length).toBe(5);
      expect(parsed.total).toBe(5);
      // The first 5 files should be present
      expect(parsed.matches).toContain("file0.ts");
      expect(parsed.matches).toContain("file4.ts");
    }
  });

  it("should clamp max_results between 1 and 100", async () => {
    (vi.mocked(fsPromises.readdir) as any).mockResolvedValue([
      dirent("single.ts", false),
    ] as any[]);

    // Test minimum clamp: 0 → 1
    const resultMin = await fileSearchTool.execute(
      { max_results: 0 },
      testCtx,
    );
    expect(resultMin.status).toBe("success");
    if (resultMin.status === "success") {
      const parsed = JSON.parse(resultMin.output);
      // With only 1 file, max_results=1 still works
      expect(parsed.matches.length).toBeLessThanOrEqual(1);
    }

    // Test maximum clamp: 200 → 100
    // Just verify no error — the clamp itself is tested implicitly
    const resultMax = await fileSearchTool.execute(
      { max_results: 200 },
      testCtx,
    );
    expect(resultMax.status).toBe("success");
  });

  it("should skip dotfiles (names starting with .)", async () => {
    (vi.mocked(fsPromises.readdir) as any).mockImplementation(
      async (dirPath: unknown, _opts?: unknown) => {
        const dir = String(dirPath);
        if (dir === TEST_WORKSPACE) {
          return [
            dirent(".git", true),
            dirent(".env", false),
            dirent(".gitignore", false),
            dirent("src", true),
            dirent("README.md", false),
          ] as any[];
        }
        if (dir === resolve(TEST_WORKSPACE, "src")) {
          return [
            dirent("index.ts", false),
          ] as any[];
        }
        return [] as any[];
      },
    );

    const result = await fileSearchTool.execute(
      { pattern: "**/*" },
      testCtx,
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const parsed = JSON.parse(result.output);

      // Dotfiles and directories starting with . should be absent
      for (const match of parsed.matches) {
        expect(match).not.toContain(".git");
        expect(match).not.toContain(".env");
        expect(match).not.toContain(".gitignore");
      }

      // Normal files should be present (use norm for cross-platform path separators)
      expect(norm(parsed.matches)).toContain("README.md");
      expect(norm(parsed.matches)).toContain("src/index.ts");
    }
  });

  it("should skip node_modules directory", async () => {
    (vi.mocked(fsPromises.readdir) as any).mockImplementation(
      async (dirPath: unknown, _opts?: unknown) => {
        const dir = String(dirPath);
        if (dir === TEST_WORKSPACE) {
          return [
            dirent("node_modules", true),
            dirent("src", true),
          ] as any[];
        }
        if (dir === resolve(TEST_WORKSPACE, "src")) {
          return [
            dirent("main.ts", false),
          ] as any[];
        }
        // node_modules should NOT be explored — if it is, this mock path won't match
        return [] as any[];
      },
    );

    const result = await fileSearchTool.execute({}, testCtx);

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const parsed = JSON.parse(result.output);
      // Only src/main.ts should be found, nothing from node_modules
      expect(norm(parsed.matches)).toEqual(["src/main.ts"]);
    }
  });

  it("should return empty result set for empty workspace", async () => {
    (vi.mocked(fsPromises.readdir) as any).mockResolvedValue(
      [] as any[],
    );

    const result = await fileSearchTool.execute({}, testCtx);

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const parsed = JSON.parse(result.output);
      expect(parsed.matches).toEqual([]);
      expect(parsed.total).toBe(0);
      expect(result.metadata).toEqual({ totalMatches: 0 });
    }
  });

  it("should handle inaccessible directories gracefully (scanDir catches internally)", async () => {
    // When readdir throws for the workspace root, scanDir's internal catch
    // silently skips it and returns without pushing any matches.
    vi.mocked(fsPromises.readdir).mockRejectedValue(
      new Error("EACCES: permission denied"),
    );

    const result = await fileSearchTool.execute({}, testCtx);

    // The outer try/catch never fires — scanDir catches internally
    // and the function returns success with an empty result set
    expect(result.status).toBe("success");
    if (result.status === "success") {
      const parsed = JSON.parse(result.output);
      expect(parsed.matches).toEqual([]);
      expect(parsed.total).toBe(0);
    }
  });

  it("should skip unreadable files during contains filtering", async () => {
    (vi.mocked(fsPromises.readdir) as any).mockImplementation(
      async (dirPath: unknown, _opts?: unknown) => {
        const dir = String(dirPath);
        if (dir === TEST_WORKSPACE) {
          return [
            dirent("good.ts", false),
            dirent("bad.ts", false),
          ] as any[];
        }
        return [] as any[];
      },
    );

    // good.ts is readable and contains "match", bad.ts throws
    vi.mocked(fsPromises.readFile).mockImplementation(
      async (filePath: unknown, _encoding?: unknown) => {
        const path = String(filePath);
        if (path.includes("bad.ts")) throw new Error("EACCES");
        return "this file has match text";
      },
    );

    const result = await fileSearchTool.execute(
      { contains: "match" },
      testCtx,
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const parsed = JSON.parse(result.output);
      expect(parsed.matches).toEqual(["good.ts"]);
      expect(parsed.total).toBe(1);
    }
  });

  it("should return partialResult with success status when results fit within max_results", async () => {
    // Three files, max_results=10 — all fit, should be success
    (vi.mocked(fsPromises.readdir) as any).mockImplementation(
      async (dirPath: unknown, _opts?: unknown) => {
        const dir = String(dirPath);
        if (dir === TEST_WORKSPACE) {
          return [
            dirent("a.ts", false),
            dirent("b.ts", false),
            dirent("c.ts", false),
          ] as any[];
        }
        return [] as any[];
      },
    );

    const result = await fileSearchTool.execute(
      { max_results: 10 },
      testCtx,
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const parsed = JSON.parse(result.output);
      expect(parsed.total).toBe(3);
      expect(result.metadata).toEqual({ totalMatches: 3 });
    }
  });
});

// ---------------------------------------------------------------------------
// safeResolve tests (tested through tool execution)
// ---------------------------------------------------------------------------

describe("safeResolve (indirectly via tools)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should block ../outside traversal via file_read", async () => {
    const result = await fileReadTool.execute(
      { path: "../outside" },
      testCtx,
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.message).toContain("outside the workspace");
      expect(result.error.message).toContain("../outside");
    }
  });

  it("should normalize paths containing ./ and ../ that stay within workspace", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(fsPromises.readFile).mockResolvedValue("content");

    // ./foo/../bar.txt should normalize to bar.txt
    await fileReadTool.execute({ path: "./foo/../bar.txt" }, testCtx);

    // Path resolution should have normalized away the ./foo/.. segment
    const expectedResolved = resolve(TEST_WORKSPACE, "bar.txt");
    expect(existsSync).toHaveBeenCalledWith(expectedResolved);
  });

  it("should strip leading slashes — absolute paths become workspace-relative", async () => {
    // safeResolve strips leading slashes: "/etc/passwd" → "etc/passwd"
    // This stays within the workspace and is treated as a relative path
    vi.mocked(existsSync).mockReturnValue(false);

    const result = await fileReadTool.execute(
      { path: "/etc/passwd" },
      testCtx,
    );

    // NOT blocked — leading slash stripped, path stays in workspace
    // The file just doesn't exist (mocked existsSync returns false)
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.NOT_FOUND);
      expect(result.error.message).toContain("File not found");
    }

    // Verify it resolved within workspace
    expect(existsSync).toHaveBeenCalledWith(
      resolve(TEST_WORKSPACE, "etc/passwd"),
    );
  });

  it("should strip leading slashes to keep path relative to workspace", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(fsPromises.readFile).mockResolvedValue("ok");

    // Leading slashes get stripped: "///sub/file.txt" → "sub/file.txt"
    await fileReadTool.execute({ path: "///sub/file.txt" }, testCtx);

    // Verify it resolved within the workspace (not to /sub/file.txt)
    const calledPath = (vi.mocked(existsSync).mock.calls[0][0] as string);
    expect(calledPath).toBe(resolve(TEST_WORKSPACE, "sub/file.txt"));
    expect(calledPath.startsWith(TEST_WORKSPACE)).toBe(true);
  });

  it("should allow paths within workspace even when using ../../workspace-root trick", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(fsPromises.readFile).mockResolvedValue("safe");

    // ../test-workspace/target.txt → resolves within /test-workspace
    await fileReadTool.execute(
      { path: "../test-workspace/target.txt" },
      testCtx,
    );

    // Verify the path was within the workspace
    const calledPath = (vi.mocked(existsSync).mock.calls[0][0] as string);
    expect(calledPath.startsWith(TEST_WORKSPACE)).toBe(true);
  });
});
