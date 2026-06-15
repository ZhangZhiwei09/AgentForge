import { describe, it, expect } from "vitest";
import { toolRegistry } from "../registry.js";
import { createRunContext } from "../../runtime/context.js";

// Shared test context for tool execution
const testCtx = createRunContext(new AbortController().signal);

describe("ToolRegistry", () => {
  // ToolRegistry is a singleton — tests use the real instance
  // but the init() method is idempotent so it's safe

  it("should register all built-in tools on init", () => {
    const names = toolRegistry.listNames();
    expect(names).toContain("get_current_time");
    expect(names).toContain("calculator");
    expect(names).toContain("web_search");
    expect(names).toContain("http_request");
    expect(names).toContain("file_read");
    expect(names).toContain("file_write");
    expect(names).toContain("file_search");
    // New P1-6 tools
    expect(names).toContain("db_query");
    expect(names).toContain("web_fetch");
    expect(names).toContain("code_execute");
    expect(names.length).toBeGreaterThanOrEqual(10);
  });

  it("should get definitions for enabled tools only", () => {
    const defs = toolRegistry.getDefinitions(["calculator"]);
    expect(defs).toHaveLength(1);
    expect(defs[0].function.name).toBe("calculator");
  });

  it("should get all definitions when no filter provided", () => {
    const defs = toolRegistry.getDefinitions();
    expect(defs.length).toBeGreaterThanOrEqual(10);
  });

  it("should return empty array for unknown tool", () => {
    const defs = toolRegistry.getDefinitions(["nonexistent_tool"]);
    expect(defs).toHaveLength(0);
  });

  it("should execute calculator tool correctly", async () => {
    const result = await toolRegistry.execute("calculator", {
      expression: "2 + 3 * 4",
    }, testCtx);
    expect(result).toBe("14");
  });

  it("should execute get_current_time tool", async () => {
    const result = await toolRegistry.execute("get_current_time", {
      timezone: "UTC",
    }, testCtx);
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(5);
  });

  it("should execute web_search (stub)", async () => {
    const result = await toolRegistry.execute("web_search", {
      query: "test",
    }, testCtx);
    expect(result).toContain("test");
    expect(result).toContain("query");
  });

  it("should return error for unknown tool", async () => {
    const result = await toolRegistry.execute("unknown_tool", {}, testCtx);
    expect(result).toContain("Error");
    expect(result).toContain("unknown tool");
  });

  it("should return error for calculator with invalid expression", async () => {
    const result = await toolRegistry.execute("calculator", {
      expression: "foo + bar",
    }, testCtx);
    expect(result).toContain("Error");
  });

  it("should list all registered tool names", () => {
    const names = toolRegistry.listNames();
    expect(Array.isArray(names)).toBe(true);
    names.forEach((n) => expect(typeof n).toBe("string"));
  });

  it("should get all registered tools via getAll", () => {
    const all = toolRegistry.getAll();
    expect(all.length).toBeGreaterThanOrEqual(10);
    all.forEach((t) => {
      expect(t.definition).toBeDefined();
      expect(t.definition.function.name).toBeTruthy();
      expect(typeof t.execute).toBe("function");
    });
  });

  it("should have sandbox field on code_execute tool", () => {
    const all = toolRegistry.getAll();
    const codeExec = all.find(
      (t) => t.definition.function.name === "code_execute",
    );
    expect(codeExec).toBeDefined();
    expect(codeExec!.sandbox).toBe(true);
    expect(codeExec!.riskLevel).toBe("destructive");
    expect(codeExec!.requireApproval).toBe(true);
  });

  it("should have correct metadata on db_query tool", () => {
    const all = toolRegistry.getAll();
    const dbQuery = all.find((t) => t.definition.function.name === "db_query");
    expect(dbQuery).toBeDefined();
    expect(dbQuery!.riskLevel).toBe("read_only");
    expect(dbQuery!.category).toBe("database");
    expect(dbQuery!.requireApproval).toBe(false);
  });
});
