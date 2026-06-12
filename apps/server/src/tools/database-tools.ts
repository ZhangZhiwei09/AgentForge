// Database tools — read-only SQL query execution via Prisma
import type { ToolDefinition } from "@agentforge/shared-types";
import type { RegisteredTool } from "./types.js";
import { prisma } from "../db.js";
import { logger } from "@agentforge/logger";

// Tool definition for db_query
const dbQueryDef: ToolDefinition = {
  type: "function",
  function: {
    name: "db_query",
    description:
      "Execute a read-only SQL query against the application database. Only SELECT statements are allowed. Results are limited to 100 rows.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The SQL SELECT query to execute. Only SELECT statements are permitted.",
        },
      },
      required: ["query"],
    },
  },
};

// Blocklist of SQL keywords that indicate write operations
const BLOCKED_SQL_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "ALTER",
  "CREATE",
  "TRUNCATE",
  "GRANT",
  "REVOKE",
  "EXEC",
  "EXECUTE",
  "MERGE",
  "REPLACE",
  "LOAD",
  "IMPORT",
  "COPY",
  "CALL",
  "DO",
];

function validateReadOnlySql(query: string): string | null {
  const trimmed = query.trim();
  if (!trimmed) {
    return "Query cannot be empty";
  }

  // Must start with SELECT (case-insensitive)
  if (!/^SELECT\b/i.test(trimmed)) {
    return `Only SELECT queries are allowed. Query starts with: "${trimmed.slice(0, 50)}..."`;
  }

  // Check for blocked keywords using word-boundary matching
  for (const keyword of BLOCKED_SQL_KEYWORDS) {
    const pattern = new RegExp(`\\b${keyword}\\b`, "i");
    if (pattern.test(trimmed)) {
      return `SQL keyword "${keyword}" is not allowed in read-only queries`;
    }
  }

  return null; // valid
}

async function dbQueryExecute(
  args: Record<string, unknown>,
): Promise<string> {
  const query = (args.query as string) || "";

  // Validate read-only SQL
  const validationError = validateReadOnlySql(query);
  if (validationError) {
    logger.warn({ query: query.slice(0, 100) }, "db_query validation rejected");
    return `Error: ${validationError}`;
  }

  try {
    const start = Date.now();
    // Add LIMIT 100 if not already present
    let safeQuery = query.trim();
    if (!/\bLIMIT\b/i.test(safeQuery)) {
      safeQuery = safeQuery.replace(/;?\s*$/, "");
      safeQuery += " LIMIT 100";
    }

    const rows = await prisma.$queryRawUnsafe(safeQuery);
    const duration = Date.now() - start;

    const resultRows = Array.isArray(rows) ? rows : [rows];
    const rowCount = resultRows.length;

    logger.info(
      { rowCount, durationMs: duration, query: query.slice(0, 100) },
      "db_query executed",
    );

    const result = {
      row_count: rowCount,
      rows: resultRows,
      truncated: rowCount >= 100,
      duration_ms: duration,
    };

    const jsonResult = JSON.stringify(result, null, 2);
    // Truncate to 80000 chars to avoid overwhelming the LLM context
    if (jsonResult.length > 80_000) {
      return JSON.stringify({
        row_count: rowCount,
        rows: resultRows.slice(0, 20),
        truncated: true,
        truncation_note: `Result truncated from ${jsonResult.length} to 80000 chars. Showing first 20 rows.`,
        duration_ms: duration,
      }, null, 2);
    }

    return jsonResult;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error({ error: msg, query: query.slice(0, 100) }, "db_query failed");
    return `Error executing query: ${msg}`;
  }
}

export const databaseTools: RegisteredTool[] = [
  {
    definition: dbQueryDef,
    execute: dbQueryExecute,
    riskLevel: "read_only",
    timeout: 15_000,
    requireApproval: false,
    category: "database",
    parallelizable: true,
  },
];
