// AgentService — ReAct (Reasoning + Acting) loop for autonomous agent tasks
// Transforms the passive chatbot into an agent that thinks, plans, acts, and observes
import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import { getProvider, resolveModel } from "../providers/registry.js";
import type { ChatMessage } from "../providers/types.js";
import { toolRegistry } from "../tools/registry.js";
import { logger } from "@agentforge/logger";
import { react_system_prompt } from "@agentforge/shared-prompts";
import type {
  AgentDecision,
  AgentStep,
  AgentStreamEvent,
} from "@agentforge/shared-types";

// Maximum iterations to prevent infinite loops
const DEFAULT_MAX_ITERATIONS = 10;
// Timeout per LLM call (ms)
const ITERATION_TIMEOUT_MS = 120_000;

export class AgentService {
  /**
   * Run the ReAct agent loop for a given task.
   * Yields AgentStreamEvent chunks for SSE streaming to the frontend.
   */
  async *run(
    conversationId: string,
    task: string,
    options: {
      model?: string | null;
      maxIterations?: number;
      tools?: string[] | null;
    } = {},
  ): AsyncGenerator<AgentStreamEvent> {
    const maxIterations = options.maxIterations || DEFAULT_MAX_ITERATIONS;
    const enabledTools = options.tools?.length ? options.tools : null;

    // 1. Resolve model/provider
    const [providerName, resolvedModel] = resolveModel(options.model);
    const provider = getProvider(providerName);

    // 2. Get conversation and validate
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation) {
      yield { type: "agent_error", error: "Conversation not found", step: 0 };
      return;
    }

    // 3. Create agent session record
    const sessionId = randomUUID();
    const sessionRecord: {
      id: string;
      conversationId: string;
      task: string;
      status: string;
      scratchpad: AgentStep[];
      finalSummary: string | null;
      startedAt: Date;
      completedAt: Date | null;
    } = {
      id: sessionId,
      conversationId,
      task,
      status: "running",
      scratchpad: [],
      finalSummary: null,
      startedAt: new Date(),
      completedAt: null,
    };

    // 4. Get tool definitions if enabled
    const toolDefs =
      enabledTools && enabledTools.length > 0
        ? toolRegistry.getDefinitions(enabledTools)
        : toolRegistry.getDefinitions(); // Use all available tools

    const toolsEnabled = toolDefs.length > 0;

    // 5. Build system prompt
    const systemPrompt = react_system_prompt.content;

    // 6. Load conversation history
    const history = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
    });

    const conversationMessages: ChatMessage[] = history.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    // 7. Add the user's task as the first user message (save to DB)
    const taskMsgId = randomUUID();
    await prisma.message.create({
      data: {
        id: taskMsgId,
        conversationId,
        role: "user",
        content: task,
        model: resolvedModel,
      },
    });

    // 8. Send meta event
    yield {
      type: "agent_meta",
      session_id: sessionId,
      model: resolvedModel,
      provider: providerName,
      max_iterations: maxIterations,
      tools_enabled: toolsEnabled
        ? toolRegistry.listNames()
        : undefined,
    };

    // 9. ReAct Loop
    const scratchpad: AgentStep[] = [];
    let finalContent = "";
    let totalSteps = 0;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      totalSteps = iteration + 1;
      logger.debug({ sessionId, iteration: totalSteps }, "Agent iteration start");

      // 9a. Build messages for this iteration
      const iterationMessages: ChatMessage[] = [
        {
          role: "system",
          content: this.buildIterationContext(
            systemPrompt,
            task,
            scratchpad,
            totalSteps,
          ),
        },
        ...conversationMessages,
      ];

      // 9b. Call LLM with structured output instruction
      let llmResponse = "";
      try {
        for await (const chunk of provider.streamChat(
          iterationMessages,
          resolvedModel,
          undefined, // system prompt is in messages
          undefined, // temperature
          undefined, // maxTokens
          toolDefs.length > 0 ? toolDefs : undefined,
        )) {
          if (chunk.type === "token" && chunk.content) {
            llmResponse += chunk.content;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        logger.error({ sessionId, error: msg }, "LLM call failed");
        yield { type: "agent_error", error: `LLM error: ${msg}`, step: totalSteps };

        // Save session as failed
        await this.saveSession(sessionRecord, scratchpad, "failed", null);
        return;
      }

      // 9c. Parse structured decision from LLM response
      const step = this.parseStep(llmResponse, totalSteps);
      if (!step) {
        logger.warn(
          { sessionId, response: llmResponse.slice(0, 200) },
          "Failed to parse agent decision — treating as respond",
        );
        // If we can't parse, just output the raw response as text
        const msgId = randomUUID();
        await prisma.message.create({
          data: {
            id: msgId,
            conversationId,
            role: "assistant",
            content: llmResponse,
            model: resolvedModel,
          },
        });

        yield {
          type: "agent_respond",
          content: llmResponse,
          summary: "Agent completed (unstructured)",
          message_id: msgId,
        };

        await this.saveSession(sessionRecord, scratchpad, "completed", "Task completed");
        yield {
          type: "agent_done",
          total_steps: totalSteps,
          final_summary: "Task completed",
          session_id: sessionId,
        };
        return;
      }

      // 9d. Yield think event
      yield {
        type: "agent_think",
        step: totalSteps,
        observation: step.observation,
        analysis: step.analysis,
        plan: step.plan,
      };

      // 9e. Execute decision
      const decision = step.decision;

      if (decision.action === "respond") {
        // Agent decides task is complete
        yield {
          type: "agent_act",
          step: totalSteps,
          decision,
        };

        // Stream the response as tokens
        const msgId = randomUUID();
        const words = decision.content.split(/(\s+)/);
        for (const word of words) {
          if (word) {
            yield {
              type: "agent_token",
              content: word,
              message_id: msgId,
            };
          }
        }

        finalContent = decision.content;

        // Save assistant message
        await prisma.message.create({
          data: {
            id: msgId,
            conversationId,
            role: "assistant",
            content: decision.content,
            model: resolvedModel,
          },
        });

        // Complete step
        step.result = decision.summary;
        scratchpad.push(step);

        yield {
          type: "agent_respond",
          content: decision.content,
          summary: decision.summary,
          message_id: msgId,
        };

        // Save session as completed
        await this.saveSession(
          sessionRecord,
          scratchpad,
          "completed",
          decision.summary,
        );

        yield {
          type: "agent_done",
          total_steps: totalSteps,
          final_summary: decision.summary,
          session_id: sessionId,
        };
        return;

      } else if (decision.action === "tool_call") {
        // Agent wants to use a tool
        yield {
          type: "agent_act",
          step: totalSteps,
          decision,
        };

        // Execute the tool
        let toolResult: string;
        try {
          toolResult = await toolRegistry.execute(decision.tool, decision.args);
        } catch (err) {
          toolResult = `Error: ${err instanceof Error ? err.message : "Tool execution failed"}`;
        }

        // Yield observe event
        yield {
          type: "agent_observe",
          step: totalSteps,
          result: toolResult,
        };

        // Record step in scratchpad
        step.result = toolResult;
        scratchpad.push(step);

        // Add tool call + result to conversation context for next iteration
        conversationMessages.push({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: randomUUID(),
              type: "function",
              function: {
                name: decision.tool,
                arguments: JSON.stringify(decision.args),
              },
            },
          ],
        });
        conversationMessages.push({
          role: "tool",
          tool_call_id:
            conversationMessages[conversationMessages.length - 1].tool_calls![0]
              .id,
          content: toolResult,
        });

      } else if (decision.action === "ask_user") {
        // Agent needs clarification — pause and wait
        scratchpad.push(step);

        await this.saveSession(
          sessionRecord,
          scratchpad,
          "paused",
          null,
        );

        yield {
          type: "agent_ask_user",
          question: decision.question,
          context: decision.context,
          session_id: sessionId,
        };
        return;
      }
    }

    // Max iterations reached
    logger.warn({ sessionId, iterations: totalSteps }, "Agent reached max iterations");
    await this.saveSession(
      sessionRecord,
      scratchpad,
      "failed",
      `Reached maximum ${maxIterations} iterations without completing the task.`,
    );

    yield {
      type: "agent_error",
      error: `Maximum iterations (${maxIterations}) reached without completing the task.`,
      step: totalSteps,
    };
  }

  /**
   * Build the full context for an iteration: system prompt + task + scratchpad
   */
  private buildIterationContext(
    systemPrompt: string,
    task: string,
    scratchpad: AgentStep[],
    currentStep: number,
  ): string {
    const parts = [systemPrompt];

    parts.push(`\n\n## 当前任务\n${task}`);

    if (scratchpad.length > 0) {
      parts.push(
        `\n\n## 历史步骤（Scratchpad）\n你已完成 ${scratchpad.length} 步：`,
      );
      for (const step of scratchpad) {
        parts.push(
          `\n第 ${step.step} 步:\n- 观察: ${step.observation}\n- 决策: ${step.decision.action}` +
          (step.result ? `\n- 结果: ${step.result}` : ""),
        );
      }
    }

    parts.push(
      `\n\n## 当前步骤: 第 ${currentStep} 步`,
      "请将你的 observation、analysis、plan、decision 输出为一个完整的 JSON 对象。",
    );

    return parts.join("\n");
  }

  /**
   * Parse the LLM's JSON response into a structured AgentStep
   */
  private parseStep(
    response: string,
    stepNumber: number,
  ): AgentStep | null {
    try {
      // Try to extract JSON from the response (might be wrapped in markdown code blocks)
      let jsonStr = response.trim();

      // Strip markdown code fences if present
      const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
      }

      // Find the outermost JSON object
      const objMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (!objMatch) {
        logger.warn({ response: response.slice(0, 200) }, "No JSON object found in agent response");
        return null;
      }

      const parsed = JSON.parse(objMatch[0]);

      if (!parsed.observation || !parsed.analysis || !parsed.plan || !parsed.decision) {
        logger.warn({ parsed }, "Missing required fields in agent decision");
        return null;
      }

      const decision = parsed.decision as AgentDecision;

      // Validate decision type
      if (
        !["tool_call", "respond", "ask_user"].includes(decision.action)
      ) {
        logger.warn({ action: decision.action }, "Invalid decision action");
        return null;
      }

      return {
        step: stepNumber,
        observation: String(parsed.observation),
        analysis: String(parsed.analysis),
        plan: String(parsed.plan),
        decision,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      logger.warn(
        { error: (err as Error).message, response: response.slice(0, 300) },
        "Failed to parse agent decision JSON",
      );
      return null;
    }
  }

  /**
   * Save the agent session to the database
   */
  private async saveSession(
    record: {
      id: string;
      conversationId: string;
      task: string;
      status: string;
      scratchpad: AgentStep[];
      finalSummary: string | null;
      startedAt: Date;
      completedAt: Date | null;
    },
    scratchpad: AgentStep[],
    status: "running" | "paused" | "completed" | "failed",
    finalSummary: string | null,
  ): Promise<void> {
    try {
      record.status = status;
      record.scratchpad = scratchpad;
      record.finalSummary = finalSummary;
      record.completedAt =
        status === "completed" || status === "failed" ? new Date() : null;

      // Upsert: create if not exists, update if exists
      await prisma.$executeRawUnsafe(
        `INSERT INTO agent_sessions (id, conversation_id, task, status, scratchpad, final_summary, started_at, completed_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           scratchpad = EXCLUDED.scratchpad,
           final_summary = EXCLUDED.final_summary,
           completed_at = EXCLUDED.completed_at`,
        record.id,
        record.conversationId,
        record.task,
        record.status,
        JSON.stringify(scratchpad),
        finalSummary,
        record.startedAt,
        record.completedAt,
      );
    } catch (err) {
      // Table might not exist yet (before migration) — gracefully degrade
      logger.warn(
        { error: (err as Error).message },
        "Failed to save agent session (table may not exist yet)",
      );
    }
  }

  /**
   * Get agent sessions for a conversation
   */
  async getSessions(conversationId: string): Promise<
    Array<{
      id: string;
      conversationId: string;
      task: string;
      status: string;
      scratchpad: AgentStep[];
      finalSummary: string | null;
      startedAt: Date;
      completedAt: Date | null;
    }>
  > {
    try {
      const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT id, conversation_id, task, status, scratchpad, final_summary, started_at, completed_at
         FROM agent_sessions
         WHERE conversation_id = $1
         ORDER BY started_at DESC`,
        conversationId,
      );

      return rows.map((row) => ({
        id: row.id as string,
        conversationId: row.conversation_id as string,
        task: row.task as string,
        status: row.status as string,
        scratchpad: (row.scratchpad as AgentStep[]) || [],
        finalSummary: (row.final_summary as string) || null,
        startedAt: row.started_at as Date,
        completedAt: (row.completed_at as Date) || null,
      }));
    } catch {
      // Table might not exist yet
      return [];
    }
  }

  /**
   * Get a single agent session by ID
   */
  async getSession(id: string): Promise<{
    id: string;
    conversationId: string;
    task: string;
    status: string;
    scratchpad: AgentStep[];
    finalSummary: string | null;
    startedAt: Date;
    completedAt: Date | null;
  } | null> {
    try {
      const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT id, conversation_id, task, status, scratchpad, final_summary, started_at, completed_at
         FROM agent_sessions
         WHERE id = $1`,
        id,
      );

      if (rows.length === 0) return null;
      const row = rows[0];
      return {
        id: row.id as string,
        conversationId: row.conversation_id as string,
        task: row.task as string,
        status: row.status as string,
        scratchpad: (row.scratchpad as AgentStep[]) || [],
        finalSummary: (row.final_summary as string) || null,
        startedAt: row.started_at as Date,
        completedAt: (row.completed_at as Date) || null,
      };
    } catch {
      return null;
    }
  }
}
