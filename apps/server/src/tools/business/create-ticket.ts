// Business Tool: create_support_ticket
// 通用工单创建 —— 不依赖 OrderService，直接写 DB
// 适用于 IT Helpdesk、客服等需要工单流转的场景

import type { ToolDefinition } from "@agentforge/shared-types";
import type { RegisteredTool } from "../types.js";
import type { RunContext } from "../../runtime/context.js";
import { successResult, failedResult, ExecutionErrorCode } from "../../runtime/results.js";
import { prisma } from "../../db.js";
import { randomUUID } from "crypto";
import { logger } from "@agentforge/logger";

const def: ToolDefinition = {
  type: "function",
  function: {
    name: "create_support_ticket",
    description:
      "创建支持工单。当问题无法立刻解决、用户要求投诉/升级、或需要团队跟进时使用。工单创建后会被持久化保存。",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "问题摘要，用一两句话描述用户遇到的具体问题和诉求",
        },
        priority: {
          type: "string",
          enum: ["normal", "urgent"],
          description: "工单优先级：normal（普通，24小时响应）或 urgent（紧急，1小时响应）",
        },
        category: {
          type: "string",
          description: "问题分类，如 IT、HR、运维、客服等",
        },
      },
      required: ["summary"],
    },
  },
};

async function execute(
  args: Record<string, unknown>,
  _context: RunContext,
): Promise<import("../../runtime/results.js").ExecutionResult> {
  const summary = (args.summary as string) || "未提供摘要";
  const priority = (args.priority as "normal" | "urgent") || "normal";
  const category = (args.category as string) || "通用";

  try {
    const ticketId = `TKT-${Date.now()}-${randomUUID().slice(0, 8)}`;

    // 写入 support_tickets 表
    await prisma.$executeRawUnsafe(
      `INSERT INTO support_tickets (id, ticket_id, summary, priority, category, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'open', NOW(), NOW())`,
      randomUUID(),
      ticketId,
      summary,
      priority,
      category,
    );

    return successResult(JSON.stringify({
      ticket_id: ticketId,
      status: "已创建",
      priority,
      category,
      summary,
      created_at: new Date().toISOString(),
      response_time:
        priority === "urgent"
          ? "工单已标记为紧急，支持团队将在 1 小时内响应处理。"
          : "工单已创建，支持团队将在 24 小时内响应处理。",
      tracking_tip: `您可以通过工单号 ${ticketId} 查询处理进度。`,
    }, null, 2));
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : "";
    // 表不存在 vs 其他数据库错误
    if (errMsg.includes("does not exist") || errMsg.includes("undefined table")) {
      logger.warn(
        { error: errMsg },
        "support_tickets table not found — run migration first",
      );
      return failedResult(
        ExecutionErrorCode.EXECUTION_ERROR,
        "工单系统尚未初始化，请联系管理员。",
      );
    }
    logger.error(e, "create_support_ticket failed");
    return failedResult(
      ExecutionErrorCode.EXECUTION_ERROR,
      "工单创建失败，请稍后再试或联系人工客服。",
    );
  }
}

export const createSupportTicketTool: RegisteredTool = {
  definition: def,
  execute,
  riskLevel: "mutation",
  timeout: 30_000,
  requireApproval: false,
  category: "business",
  parallelizable: false,
};
