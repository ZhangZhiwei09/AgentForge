import { describe, it, expect, beforeEach } from "vitest";
import { toolRegistry } from "../registry.js";

describe("ToolRegistry", () => {
  // ToolRegistry is a singleton — tests use the real instance
  // but the init() method is idempotent so it's safe

  it("should register built-in tools on init", () => {
    const names = toolRegistry.listNames();
    expect(names).toContain("get_current_time");
    expect(names).toContain("calculator");
    expect(names).toContain("web_search");
    expect(names.length).toBeGreaterThanOrEqual(3);
  });

  it("should get definitions for enabled tools only", () => {
    const defs = toolRegistry.getDefinitions(["calculator"]);
    expect(defs).toHaveLength(1);
    expect(defs[0].function.name).toBe("calculator");
  });

  it("should get all definitions when no filter provided", () => {
    const defs = toolRegistry.getDefinitions();
    expect(defs.length).toBeGreaterThanOrEqual(3);
  });

  it("should return empty array for unknown tool", () => {
    const defs = toolRegistry.getDefinitions(["nonexistent_tool"]);
    expect(defs).toHaveLength(0);
  });

  it("should execute calculator tool correctly", async () => {
    const result = await toolRegistry.execute("calculator", {
      expression: "2 + 3 * 4",
    });
    expect(result).toBe("14");
  });

  it("should execute get_current_time tool", async () => {
    const result = await toolRegistry.execute("get_current_time", {
      timezone: "UTC",
    });
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(5);
  });

  it("should execute web_search (stub)", async () => {
    const result = await toolRegistry.execute("web_search", {
      query: "test",
    });
    expect(result).toContain("test");
    expect(result).toContain("query");
  });

  it("should return error for unknown tool", async () => {
    const result = await toolRegistry.execute("unknown_tool", {});
    expect(result).toContain("Error");
    expect(result).toContain("unknown tool");
  });

  it("should return error for calculator with invalid expression", async () => {
    const result = await toolRegistry.execute("calculator", {
      expression: "foo + bar",
    });
    expect(result).toContain("Error");
  });

  it("should list all registered tool names", () => {
    const names = toolRegistry.listNames();
    expect(Array.isArray(names)).toBe(true);
    names.forEach((n) => expect(typeof n).toBe("string"));
  });

  it("should get all registered tools via getAll", () => {
    const all = toolRegistry.getAll();
    expect(all.length).toBeGreaterThanOrEqual(3);
    all.forEach((t) => {
      expect(t.definition).toBeDefined();
      expect(t.definition.function.name).toBeTruthy();
      expect(typeof t.execute).toBe("function");
    });
  });
});
