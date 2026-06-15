import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRunContext } from "../../runtime/context.js";

// Mock prisma before importing the tool module
const mockQueryRawUnsafe = vi.fn();
vi.mock("../../db.js", () => ({
  prisma: {
    $queryRawUnsafe: (...args: unknown[]) => mockQueryRawUnsafe(...args),
  },
}));

// Dynamic import after mock setup
const { databaseTools } = await import("../database-tools.js");

const testCtx = createRunContext(new AbortController().signal);

describe("db_query tool", () => {
  const dbQueryTool = databaseTools[0];

  beforeEach(() => {
    mockQueryRawUnsafe.mockReset();
  });

  it("should be registered with correct metadata", () => {
    expect(dbQueryTool.definition.function.name).toBe("db_query");
    expect(dbQueryTool.riskLevel).toBe("read_only");
    expect(dbQueryTool.category).toBe("database");
    expect(dbQueryTool.requireApproval).toBe(false);
    expect(dbQueryTool.parallelizable).toBe(true);
  });

  it("should execute a simple SELECT query", async () => {
    mockQueryRawUnsafe.mockResolvedValue([{ id: 1, name: "test" }]);

    const result = await dbQueryTool.execute({ query: "SELECT * FROM users" }, testCtx);
    const parsed = JSON.parse(result);

    expect(parsed.row_count).toBe(1);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].name).toBe("test");
  });

  it("should add LIMIT 100 if not present in query", async () => {
    mockQueryRawUnsafe.mockResolvedValue([]);

    await dbQueryTool.execute({ query: "SELECT * FROM users" }, testCtx);

    expect(mockQueryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("LIMIT 100"),
    );
  });

  it("should not duplicate LIMIT if already present", async () => {
    mockQueryRawUnsafe.mockResolvedValue([]);

    await dbQueryTool.execute({ query: "SELECT * FROM users LIMIT 10" }, testCtx);

    const calledQuery = mockQueryRawUnsafe.mock.calls[0][0];
    // Should only have LIMIT once
    const limitCount = (calledQuery.match(/LIMIT/gi) || []).length;
    expect(limitCount).toBe(1);
  });

  it("should reject empty query", async () => {
    const result = await dbQueryTool.execute({ query: "" }, testCtx);
    expect(result).toContain("Error");
    expect(result).toContain("empty");
    expect(mockQueryRawUnsafe).not.toHaveBeenCalled();
  });

  it("should reject non-SELECT queries", async () => {
    const result = await dbQueryTool.execute({
      query: "INSERT INTO users VALUES (1)",
    }, testCtx);
    expect(result).toContain("Error");
    expect(result).toContain("SELECT");
    expect(mockQueryRawUnsafe).not.toHaveBeenCalled();
  });

  it("should reject UPDATE queries", async () => {
    const result = await dbQueryTool.execute({
      query: "UPDATE users SET name = 'x'",
    }, testCtx);
    expect(result).toContain("Error");
    expect(mockQueryRawUnsafe).not.toHaveBeenCalled();
  });

  it("should reject DELETE queries", async () => {
    const result = await dbQueryTool.execute({ query: "DELETE FROM users" }, testCtx);
    expect(result).toContain("Error");
    expect(mockQueryRawUnsafe).not.toHaveBeenCalled();
  });

  it("should reject DROP queries", async () => {
    const result = await dbQueryTool.execute({ query: "DROP TABLE users" }, testCtx);
    expect(result).toContain("Error");
    expect(mockQueryRawUnsafe).not.toHaveBeenCalled();
  });

  it("should reject queries with blocked keywords mid-query", async () => {
    const result = await dbQueryTool.execute({
      query: "SELECT * FROM users; DROP TABLE users",
    }, testCtx);
    expect(result).toContain("Error");
    expect(result).toContain("DROP");
    expect(mockQueryRawUnsafe).not.toHaveBeenCalled();
  });

  it("should handle prisma errors gracefully", async () => {
    mockQueryRawUnsafe.mockRejectedValue(new Error("Connection refused"));

    const result = await dbQueryTool.execute({ query: "SELECT 1" }, testCtx);
    expect(result).toContain("Error");
    expect(result).toContain("Connection refused");
  });

  it("should return error for missing query parameter", async () => {
    const result = await dbQueryTool.execute({}, testCtx);
    expect(result).toContain("Error");
  });

  it("should handle empty result set", async () => {
    mockQueryRawUnsafe.mockResolvedValue([]);

    const result = await dbQueryTool.execute({
      query: "SELECT * FROM users WHERE id = 999",
    }, testCtx);
    const parsed = JSON.parse(result);

    expect(parsed.row_count).toBe(0);
    expect(parsed.rows).toHaveLength(0);
  });
});
