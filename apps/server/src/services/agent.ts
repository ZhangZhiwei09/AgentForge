// AgentService — ReAct (Reasoning + Acting) loop for autonomous agent tasks
// Transforms the passive chatbot into an agent that thinks, plans, acts, and observes
import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import { getProvider, resolveModel } from "../providers/registry.js";
import type { ChatMessage } from "../providers/types.js";
import { toolRegistry } from "../tools/registry.js";
import { logger } from "@agentforge/logger";
import { react_system_prompt } from "@agentforge/shared-prompts";
import { parseJSONFromLLMResponse } from "../lib/json-utils.js";
import { truncateHistory } from "../lib/context-window.js";
import type {
  AgentDecision,
  AgentStep,
  AgentStreamEvent,
  AgentApprovalRequiredEvent,
  AgentApprovalResultEvent,
  ToolDefinition,
} from "@agentforge/shared-types";

// Maximum iterations to prevent infinite loops
const DEFAULT_MAX_ITERATIONS = 10;
// Timeout per LLM call (ms)
const ITERATION_TIMEOUT_MS = 120_000;

// Virtual tool: agent_decide — the LLM calls this to report its decision
// instead of outputting raw JSON. Provides native structured output guarantee.
const AGENT_DECIDE_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "agent_decide",
    description:
      "Report your observation, analysis, plan, and decision for this step. " +
      "Call this function instead of outputting JSON text.",
    parameters: {
      type: "object",
      properties: {
        observation: {
          type: "string",
          description: "What I observe about the current state and available information",
        },
        analysis: {
          type: "string",
          description: "What this means — interpretation and progress assessment",
        },
        plan: {
          type: "string",
          description: "What to do next and why",
        },
        action: {
          type: "string",
          enum: ["tool_call", "respond", "ask_user"],
          description: "The type of action to take",
        },
        tool: {
          type: "string",
          description: "Name of the tool to call (required if action=tool_call)",
        },
        args_json: {
          type: "string",
          description: "JSON-encoded tool arguments (required if action=tool_call)",
        },
        reason: {
          type: "string",
          description: "Why this tool is needed (required if action=tool_call)",
        },
        content: {
          type: "string",
          description: "The final response to the user (required if action=respond)",
        },
        summary: {
          type: "string",
          description: "One-line summary of what was accomplished (required if action=respond)",
        },
        question: {
          type: "string",
          description: "The question to ask the user (required if action=ask_user)",
        },
        clarify_context: {
          type: "string",
          description: "Why this clarification is needed (required if action=ask_user)",
        },
      },
      required: ["observation", "analysis", "plan", "action"],
    },
  },
};

// ReAct prompt adapted for tool calling — instructs LLM to call agent_decide
const REACT_PROMPT_WITH_TOOLS = react_system_prompt.content +
  "\n\n重要：你必须调用 agent_decide 函数来报告你的决策，而不是输出原始 JSON 文本。";

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

    // 4. Get tool definitions — always include agent_decide for structured output
    const toolDefs = [
      AGENT_DECIDE_TOOL,
      ...(enabledTools && enabledTools.length > 0
        ? toolRegistry.getDefinitions(enabledTools)
        : toolRegistry.getDefinitions()),
    ];

    const toolsEnabled = toolDefs.length > 0;

    // 5. Build system prompt — use tool-calling variant
    const systemPrompt = REACT_PROMPT_WITH_TOOLS;

    // 6. Load conversation history (most recent 100, reversed for truncateHistory)
    const history = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    history.reverse();

    // 6000 token预算：需为system prompt + scratchpad + tool results留空间
    const rawMessages: ChatMessage[] = history.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));
    const conversationMessages = truncateHistory(rawMessages, 6000);

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

      // 9b. Call LLM — stream tokens in real time, intercept agent_decide tool calls
      const streamMsgId = randomUUID();
      let llmResponse = "";
      let agentDecision: AgentStep | null = null; // set if LLM calls agent_decide

      try {
        for await (const chunk of provider.streamChat(
          iterationMessages,
          resolvedModel,
          undefined, // system prompt is in messages
          undefined, // temperature
          undefined, // maxTokens
          toolDefs,
        )) {
          if (chunk.type === "token" && chunk.content) {
            llmResponse += chunk.content;
            yield {
              type: "agent_token",
              content: chunk.content,
              message_id: streamMsgId,
            };
          } else if (chunk.type === "tool_call" && chunk.tool_call) {
            const tc = chunk.tool_call;
            if (tc.name === "agent_decide") {
              agentDecision = this.parseAgentDecideFromArgs(tc.arguments, totalSteps);
              // Clear any streamed text — the LLM shouldn't have emitted
              // text when using tool calling, but clear as a safety measure
              if (agentDecision && llmResponse.trim().length > 0) {
                yield {
                  type: "agent_clear_stream",
                  message_id: streamMsgId,
                  step: totalSteps,
                };
              }
            } else {
              // Real tool call — execute immediately for agent workflow
              let args: Record<string, unknown> = {};
              try { args = JSON.parse(tc.arguments); } catch { /* ignore */ }
              const result = await toolRegistry.execute(tc.name, args);
              conversationMessages.push({
                role: "assistant",
                content: null,
                tool_calls: [{
                  id: tc.id, type: "function" as const,
                  function: { name: tc.name, arguments: tc.arguments },
                }],
              });
              conversationMessages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: result,
              });
              yield {
                type: "agent_observe",
                step: totalSteps,
                result: `Tool ${tc.name}: ${result}`,
              };
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        logger.error({ sessionId, error: msg }, "LLM call failed");
        yield { type: "agent_error", error: `LLM error: ${msg}`, step: totalSteps };
        await this.saveSession(sessionRecord, scratchpad, "failed", null);
        return;
      }

      // 9c. Parse decision — prefer native tool calling, fall back to JSON text
      const step = agentDecision || this.parseStep(llmResponse, totalSteps);
      if (!step) {
        logger.warn(
          { sessionId, response: llmResponse.slice(0, 200) },
          "Failed to parse agent decision — treating as respond",
        );
        // Parsing failed: the raw text was already streamed to the frontend.
        // Save it as the assistant message.
        await prisma.message.create({
          data: {
            id: streamMsgId,
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
          message_id: streamMsgId,
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
        // Agent decides task is complete — content was already streamed
        // as agent_token events during the LLM call (real streaming)
        yield {
          type: "agent_act",
          step: totalSteps,
          decision,
        };

        finalContent = decision.content;

        // Save assistant message (ID matches the streamed tokens)
        await prisma.message.create({
          data: {
            id: streamMsgId,
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
          message_id: streamMsgId,
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
        // Agent wants to use a tool — clear the streamed JSON tokens
        // since they contain structural data, not user-facing text
        yield {
          type: "agent_clear_stream",
          message_id: streamMsgId,
          step: totalSteps,
        };

        yield {
          type: "agent_act",
          step: totalSteps,
          decision,
        };

        // ---- P1-5 Approval Gate ----
        // Check if this tool requires human approval before execution
        const registeredTool = toolRegistry.getAll().find(
          (t) => t.definition.function.name === decision.tool,
        );

        if (registeredTool?.requireApproval) {
          // Pause agent and request user approval
          const approvalId = randomUUID();
          const riskLevel = registeredTool.riskLevel;
          const timeoutMs = 300_000; // 5 min default

          // Push step to scratchpad BEFORE pausing (result not set yet)
          step.result = undefined;
          scratchpad.push(step);

          // Create approval record for audit log
          try {
            await prisma.agentApproval.create({
              data: {
                id: approvalId,
                sessionId: sessionRecord.id,
                conversationId,
                stepNumber: totalSteps,
                toolName: decision.tool,
                toolArgs: decision.args as object,
                riskLevel,
                reason: decision.reason,
                status: "pending",
                timeoutMs,
                requestedAt: new Date(),
              },
            });
          } catch (err) {
            logger.warn({ error: (err as Error).message }, "Failed to create approval record");
          }

          // Save session as paused
          await this.saveSession(sessionRecord, scratchpad, "paused", null);

          yield {
            type: "agent_approval_required",
            approval_id: approvalId,
            session_id: sessionId,
            step: totalSteps,
            tool_name: decision.tool,
            tool_args: decision.args,
            risk_level: riskLevel,
            reason: decision.reason,
            timeout_ms: timeoutMs,
          } satisfies AgentApprovalRequiredEvent;
          return;
        }

        // No approval needed — execute directly
        const toolResult = await this.executeToolAndRecord(
          decision.tool, decision.args, conversationMessages,
        );

        // Yield observe event
        yield {
          type: "agent_observe",
          step: totalSteps,
          result: toolResult,
        };

        // Record step in scratchpad
        step.result = toolResult;
        scratchpad.push(step);

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
   * Resume a paused agent session with the user's response.
   * Delegates to continueReActLoop() — no duplicate loop code.
   */
  async *resume(
    sessionId: string,
    userResponse: string,
  ): AsyncGenerator<AgentStreamEvent> {
    // 1. Load and validate paused session
    const session = await this.getSession(sessionId);
    if (!session) {
      yield { type: "agent_error", error: "Agent session not found", step: 0 };
      return;
    }
    if (session.status !== "paused") {
      yield {
        type: "agent_error",
        error: `Session is ${session.status}, not paused`,
        step: 0,
      };
      return;
    }

    const conversationId = session.conversationId;
    const task = session.task;
    const scratchpad: AgentStep[] = session.scratchpad || [];

    // 2. Save user's response to DB (continueReActLoop will reload from DB)
    await prisma.message.create({
      data: {
        id: randomUUID(),
        conversationId,
        role: "user",
        content: userResponse,
        model: resolveModel()[1],
      },
    });

    // 3. Delegate to shared ReAct loop
    yield* this.continueReActLoop(
      sessionId,
      conversationId,
      task,
      scratchpad,
      scratchpad.length,
    );
  }

  /**
   * Handle an approval decision (approve/reject) for a paused agent session.
   * Called from POST /api/agent/approve — continues the ReAct loop.
   */
  async *handleApproval(
    sessionId: string,
    approvalId: string,
    action: "approve" | "reject",
    modifiedArgs?: Record<string, unknown>,
    rejectionReason?: string,
  ): AsyncGenerator<AgentStreamEvent> {
    // 1. Load the paused session
    const session = await this.getSession(sessionId);
    if (!session) {
      yield { type: "agent_error", error: "Agent session not found", step: 0 };
      return;
    }
    if (session.status !== "paused") {
      yield {
        type: "agent_error",
        error: `Session is ${session.status}, not paused`,
        step: 0,
      };
      return;
    }

    // 2. Load the approval record
    let approval;
    try {
      approval = await prisma.agentApproval.findUnique({
        where: { id: approvalId },
      });
    } catch {
      yield { type: "agent_error", error: "Failed to load approval record", step: 0 };
      return;
    }
    if (!approval || approval.status !== "pending") {
      yield {
        type: "agent_error",
        error: "Approval not found or already decided",
        step: 0,
      };
      return;
    }

    // 3. Check timeout — auto-reject if expired
    const elapsed = Date.now() - approval.requestedAt.getTime();
    const now = new Date();
    const args = modifiedArgs || (approval.toolArgs as Record<string, unknown>);
    const scratchpad: AgentStep[] = session.scratchpad || [];
    const conversationId = session.conversationId;
    const task = session.task;

    if (elapsed > approval.timeoutMs) {
      await prisma.agentApproval.update({
        where: { id: approvalId },
        data: { status: "timed_out", decidedAt: now },
      });

      const step = scratchpad.find((s) => s.step === approval.stepNumber);
      if (step) {
        step.result = `[审批超时] 工具 "${approval.toolName}" 的审批请求已超时（${approval.timeoutMs / 1000}s），自动拒绝。`;
      }

      yield {
        type: "agent_approval_result",
        approval_id: approvalId,
        session_id: sessionId,
        step: approval.stepNumber,
        status: "timed_out",
      } satisfies AgentApprovalResultEvent;

      // Save session and continue loop
      await this.saveSession(
        this.sessionRecord(sessionId, conversationId, task),
        scratchpad, "running", null,
      );

      yield* this.continueReActLoop(sessionId, conversationId, task, scratchpad, scratchpad.length);
      return;
    }

    // 4. Process decision
    if (action === "approve") {
      await prisma.agentApproval.update({
        where: { id: approvalId },
        data: {
          status: "approved",
          modifiedArgs: modifiedArgs ? (modifiedArgs as object) : undefined,
          decidedAt: now,
        },
      });

      // Execute the approved tool
      const step = scratchpad.find((s) => s.step === approval.stepNumber);
      if (!step) {
        yield { type: "agent_error", error: "Step not found in scratchpad", step: 0 };
        return;
      }

      // Load conversation messages for tool result recording
      const history = await prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      history.reverse();
      const rawMessages: ChatMessage[] = history.map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));
      const conversationMessages = truncateHistory(rawMessages, 6000);

      // Execute the tool
      let toolResult: string;
      try {
        toolResult = await toolRegistry.execute(approval.toolName, args);
      } catch (err) {
        toolResult = `Error: ${err instanceof Error ? err.message : "Tool execution failed"}`;
      }

      // Record result
      step.result = toolResult;
      conversationMessages.push({
        role: "assistant", content: null,
        tool_calls: [{ id: randomUUID(), type: "function", function: { name: approval.toolName, arguments: JSON.stringify(args) } }],
      });
      conversationMessages.push({
        role: "tool",
        tool_call_id: conversationMessages[conversationMessages.length - 1].tool_calls![0].id,
        content: toolResult,
      });

      yield {
        type: "agent_approval_result",
        approval_id: approvalId,
        session_id: sessionId,
        step: approval.stepNumber,
        status: "approved",
        modified_args: modifiedArgs,
        result: toolResult,
      } satisfies AgentApprovalResultEvent;

      yield {
        type: "agent_observe",
        step: approval.stepNumber,
        result: toolResult,
      };

      // Save session as running and continue
      await this.saveSession(
        this.sessionRecord(sessionId, conversationId, task),
        scratchpad, "running", null,
      );

      yield* this.continueReActLoop(sessionId, conversationId, task, scratchpad, scratchpad.length);
      return;

    } else {
      // Reject
      await prisma.agentApproval.update({
        where: { id: approvalId },
        data: {
          status: "rejected",
          rejectionReason: rejectionReason || "User rejected the tool execution",
          decidedAt: now,
        },
      });

      const step = scratchpad.find((s) => s.step === approval.stepNumber);
      if (step) {
        step.result = `[用户拒绝] 工具 "${approval.toolName}" 的执行被用户拒绝。${rejectionReason ? `原因: ${rejectionReason}` : ""}`;
      }

      yield {
        type: "agent_approval_result",
        approval_id: approvalId,
        session_id: sessionId,
        step: approval.stepNumber,
        status: "rejected",
        rejection_reason: rejectionReason,
      } satisfies AgentApprovalResultEvent;

      // Save session as running and continue
      await this.saveSession(
        this.sessionRecord(sessionId, conversationId, task),
        scratchpad, "running", null,
      );

      yield* this.continueReActLoop(sessionId, conversationId, task, scratchpad, scratchpad.length);
      return;
    }
  }

  /**
   * Shared ReAct loop continuation — used by resume() and handleApproval().
   * Starts from startIteration and runs until respond/ask_user/max_iterations.
   */
  private async *continueReActLoop(
    sessionId: string,
    conversationId: string,
    task: string,
    scratchpad: AgentStep[],
    startIteration: number,
  ): AsyncGenerator<AgentStreamEvent> {
    const [providerName, resolvedModel] = resolveModel();
    const provider = getProvider(providerName);

    const toolDefs = [
      AGENT_DECIDE_TOOL,
      ...toolRegistry.getDefinitions(),
    ];

    const systemPrompt = REACT_PROMPT_WITH_TOOLS;
    const maxIterations = DEFAULT_MAX_ITERATIONS;

    // Load conversation history (most recent 100, reversed for truncateHistory)
    const history = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    history.reverse();
    const rawMessages: ChatMessage[] = history.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));
    const conversationMessages = truncateHistory(rawMessages, 6000);

    yield {
      type: "agent_meta",
      session_id: sessionId,
      model: resolvedModel,
      provider: providerName,
      max_iterations: maxIterations,
      tools_enabled: toolRegistry.listNames(),
    };

    for (let iteration = startIteration; iteration < maxIterations; iteration++) {
      const totalSteps = iteration + 1;
      logger.debug({ sessionId, iteration: totalSteps }, "Agent continue iteration");

      await this.saveSession(
        this.sessionRecord(sessionId, conversationId, task),
        scratchpad,
        "running",
        null,
      );

      const iterationMessages: ChatMessage[] = [
        {
          role: "system",
          content: this.buildIterationContext(systemPrompt, task, scratchpad, totalSteps),
        },
        ...conversationMessages,
      ];

      const streamMsgId = randomUUID();
      let llmResponse = "";
      let agentDecision: AgentStep | null = null;

      try {
        for await (const chunk of provider.streamChat(
          iterationMessages, resolvedModel, undefined, undefined, undefined, toolDefs,
        )) {
          if (chunk.type === "token" && chunk.content) {
            llmResponse += chunk.content;
            yield { type: "agent_token", content: chunk.content, message_id: streamMsgId };
          } else if (chunk.type === "tool_call" && chunk.tool_call) {
            const tc = chunk.tool_call;
            if (tc.name === "agent_decide") {
              agentDecision = this.parseAgentDecideFromArgs(tc.arguments, totalSteps);
              if (agentDecision && llmResponse.trim().length > 0) {
                yield { type: "agent_clear_stream", message_id: streamMsgId, step: totalSteps };
              }
            } else {
              // Real tool call — execute immediately
              let tcArgs: Record<string, unknown> = {};
              try { tcArgs = JSON.parse(tc.arguments); } catch { /* ignore */ }
              const result = await toolRegistry.execute(tc.name, tcArgs);
              conversationMessages.push({
                role: "assistant", content: null,
                tool_calls: [{ id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.arguments } }],
              });
              conversationMessages.push({ role: "tool", tool_call_id: tc.id, content: result });
              yield { type: "agent_observe", step: totalSteps, result: `Tool ${tc.name}: ${result}` };
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        yield { type: "agent_error", error: `LLM error: ${msg}`, step: totalSteps };
        await this.saveSession(
          this.sessionRecord(sessionId, conversationId, task),
          scratchpad, "failed", null,
        );
        return;
      }

      const step = agentDecision || this.parseStep(llmResponse, totalSteps);
      if (!step) {
        await prisma.message.create({
          data: { id: streamMsgId, conversationId, role: "assistant", content: llmResponse, model: resolvedModel },
        });
        yield { type: "agent_respond", content: llmResponse, summary: "Agent completed (unstructured)", message_id: streamMsgId };
        await this.saveSession(
          this.sessionRecord(sessionId, conversationId, task),
          scratchpad, "completed", "Task completed",
        );
        yield { type: "agent_done", total_steps: totalSteps, final_summary: "Task completed", session_id: sessionId };
        return;
      }

      yield { type: "agent_think", step: totalSteps, observation: step.observation, analysis: step.analysis, plan: step.plan };
      const decision = step.decision;

      if (decision.action === "respond") {
        yield { type: "agent_act", step: totalSteps, decision };
        await prisma.message.create({
          data: { id: streamMsgId, conversationId, role: "assistant", content: decision.content, model: resolvedModel },
        });
        step.result = decision.summary;
        scratchpad.push(step);
        yield { type: "agent_respond", content: decision.content, summary: decision.summary, message_id: streamMsgId };
        await this.saveSession(
          this.sessionRecord(sessionId, conversationId, task),
          scratchpad, "completed", decision.summary,
        );
        yield { type: "agent_done", total_steps: totalSteps, final_summary: decision.summary, session_id: sessionId };
        return;
      } else if (decision.action === "tool_call") {
        yield { type: "agent_clear_stream", message_id: streamMsgId, step: totalSteps };
        yield { type: "agent_act", step: totalSteps, decision };

        // P1-5 Approval Gate (during continuation loop)
        const registeredTool = toolRegistry.getAll().find(
          (t) => t.definition.function.name === decision.tool,
        );

        if (registeredTool?.requireApproval) {
          const aId = randomUUID();
          const riskLevel = registeredTool.riskLevel;
          const timeoutMs = 300_000;

          step.result = undefined;
          scratchpad.push(step);

          try {
            await prisma.agentApproval.create({
              data: {
                id: aId,
                sessionId,
                conversationId,
                stepNumber: totalSteps,
                toolName: decision.tool,
                toolArgs: decision.args as object,
                riskLevel,
                reason: decision.reason,
                status: "pending",
                timeoutMs,
                requestedAt: new Date(),
              },
            });
          } catch (err) {
            logger.warn({ error: (err as Error).message }, "Failed to create approval record");
          }

          await this.saveSession(
            this.sessionRecord(sessionId, conversationId, task),
            scratchpad, "paused", null,
          );

          yield {
            type: "agent_approval_required",
            approval_id: aId,
            session_id: sessionId,
            step: totalSteps,
            tool_name: decision.tool,
            tool_args: decision.args,
            risk_level: riskLevel,
            reason: decision.reason,
            timeout_ms: timeoutMs,
          } satisfies AgentApprovalRequiredEvent;
          return;
        }

        const toolResult = await this.executeToolAndRecord(
          decision.tool, decision.args, conversationMessages,
        );
        yield { type: "agent_observe", step: totalSteps, result: toolResult };
        step.result = toolResult;
        scratchpad.push(step);
      } else if (decision.action === "ask_user") {
        scratchpad.push(step);
        await this.saveSession(
          this.sessionRecord(sessionId, conversationId, task),
          scratchpad, "paused", null,
        );
        yield { type: "agent_ask_user", question: decision.question, context: decision.context, session_id: sessionId };
        return;
      }
    }

    yield { type: "agent_error", error: `Maximum iterations (${maxIterations}) reached`, step: startIteration + maxIterations };
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
   * Parse agent_decide tool call arguments into a structured AgentStep.
   * Used by all ReAct loop methods to avoid duplicating the JSON parsing logic.
   */
  private parseAgentDecideFromArgs(
    rawArgs: string,
    totalSteps: number,
  ): AgentStep | null {
    try {
      const a = JSON.parse(rawArgs);
      const action: string = a.action || "respond";

      let decision: AgentDecision;
      switch (action) {
        case "tool_call":
          decision = {
            action: "tool_call",
            tool: String(a.tool || ""),
            args: (() => {
              try { return JSON.parse(a.args_json || "{}"); }
              catch { return {}; }
            })(),
            reason: String(a.reason || ""),
          };
          break;
        case "ask_user":
          decision = {
            action: "ask_user",
            question: String(a.question || ""),
            context: String(a.clarify_context || ""),
          };
          break;
        default: // respond
          decision = {
            action: "respond",
            content: String(a.content || ""),
            summary: String(a.summary || ""),
          };
      }

      return {
        step: totalSteps,
        observation: String(a.observation || ""),
        analysis: String(a.analysis || ""),
        plan: String(a.plan || ""),
        decision,
        timestamp: new Date().toISOString(),
      };
    } catch {
      logger.warn(
        { args: rawArgs },
        "Failed to parse agent_decide tool arguments",
      );
      return null;
    }
  }

  /**
   * Parse the LLM's JSON response into a structured AgentStep
   */
  private parseStep(
    response: string,
    stepNumber: number,
  ): AgentStep | null {
    try {
      const parsed = parseJSONFromLLMResponse(response);
      if (!parsed || typeof parsed !== "object") {
        logger.warn({ response: response.slice(0, 200) }, "No JSON object found in agent response");
        return null;
      }

      const obj = parsed as Record<string, unknown>;

      if (!obj.observation || !obj.analysis || !obj.plan || !obj.decision) {
        logger.warn({ obj }, "Missing required fields in agent decision");
        return null;
      }

      const decision = obj.decision as AgentDecision;

      // Validate decision type
      if (
        !["tool_call", "respond", "ask_user"].includes(decision.action)
      ) {
        logger.warn({ action: decision.action }, "Invalid decision action");
        return null;
      }

      return {
        step: stepNumber,
        observation: String(obj.observation),
        analysis: String(obj.analysis),
        plan: String(obj.plan),
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
   * Execute a tool and record the call + result in conversation messages.
   * Shared by all ReAct loop methods to avoid duplicating tool execution logic.
   */
  private async executeToolAndRecord(
    toolName: string,
    args: Record<string, unknown>,
    conversationMessages: ChatMessage[],
  ): Promise<string> {
    let result: string;
    try {
      result = await toolRegistry.execute(toolName, args);
    } catch (err) {
      result = `Error: ${err instanceof Error ? err.message : "Tool execution failed"}`;
    }

    conversationMessages.push({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: randomUUID(),
          type: "function" as const,
          function: { name: toolName, arguments: JSON.stringify(args) },
        },
      ],
    });
    conversationMessages.push({
      role: "tool",
      tool_call_id: conversationMessages[conversationMessages.length - 1].tool_calls![0].id,
      content: result,
    });

    return result;
  }

  /**
   * Create a session record object used by saveSession across all loop methods.
   */
  private sessionRecord(
    id: string,
    conversationId: string,
    task: string,
  ) {
    return {
      id,
      conversationId,
      task,
      status: "running" as string,
      scratchpad: [] as AgentStep[],
      finalSummary: null as string | null,
      startedAt: new Date(),
      completedAt: null as Date | null,
    };
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
      const completedAt =
        status === "completed" || status === "failed" ? new Date() : null;

      await prisma.agentSession.upsert({
        where: { id: record.id },
        create: {
          id: record.id,
          conversationId: record.conversationId,
          task: record.task,
          status,
          scratchpad: scratchpad as unknown as object,
          finalSummary,
          startedAt: record.startedAt,
          completedAt,
        },
        update: {
          status,
          scratchpad: scratchpad as unknown as object,
          finalSummary,
          completedAt,
        },
      });

      // Sync the in-memory record for external tracking
      record.status = status;
      record.scratchpad = scratchpad;
      record.finalSummary = finalSummary;
      record.completedAt = completedAt;
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
      const sessions = await prisma.agentSession.findMany({
        where: { conversationId },
        orderBy: { startedAt: "desc" },
      });

      return sessions.map((s) => ({
        id: s.id,
        conversationId: s.conversationId,
        task: s.task,
        status: s.status,
        scratchpad: (s.scratchpad as unknown as AgentStep[]) || [],
        finalSummary: s.finalSummary,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
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
      const s = await prisma.agentSession.findUnique({ where: { id } });
      if (!s) return null;

      return {
        id: s.id,
        conversationId: s.conversationId,
        task: s.task,
        status: s.status,
        scratchpad: (s.scratchpad as unknown as AgentStep[]) || [],
        finalSummary: s.finalSummary,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
      };
    } catch {
      return null;
    }
  }
}
