// LegacyAgentRunner — ReAct (Reasoning + Acting) loop for autonomous agent tasks
// Original AgentService implementation, extracted as legacy runner.
// Delegates prompt construction, decision parsing, tool execution, and session
// persistence to specialized sub-modules.
import { randomUUID } from "crypto";
import { prisma } from "../../../db.js";
import { getProvider, resolveModel } from "../../../providers/registry.js";
import type { ChatMessage } from "../../../providers/types.js";
import { toolRegistry } from "../../../tools/registry.js";
import { logger } from "@agentforge/logger";
import type { ExecutionScope } from "../../../runtime/scope.js";
import { truncateHistory } from "../../../lib/context-window.js";
import { classifyError } from "../../error-classifier.js";
import {
  DEFAULT_LLM_RETRY,
  DEFAULT_TOOL_RETRY,
} from "../../retry-executor.js";
import {
  isDegradedResult,
  executionResultToContent,
  type ExecutionResult,
} from "../../../runtime/results.js";
import { AgentGuardService } from "../../agent-guard.js";
import type { AgentGuardConfig } from "../../agent-guard.js";
import {
  MemoryCompressor,
  SCRATCHPAD_COMPRESSION_THRESHOLD,
} from "../../memory-compressor.js";
import { looksLikeReActJSON } from "../../agent-runtime/react-json-utils.js";
import type { ObservabilityTrace } from "../../../observability/provider.js";
import type {
  AgentStep,
  AgentStreamEvent,
  AgentApprovalRequiredEvent,
  AgentApprovalResultEvent,
} from "@agentforge/shared-types";

// Sub-module imports
import {
  DEFAULT_MAX_ITERATIONS,
  AGENT_DECIDE_TOOL,
  REACT_PROMPT_WITH_TOOLS,
  buildIterationContext,
  getRespondOnlySystemPrompt,
} from "../prompts.js";
import { parseAgentDecideFromArgs, parseStep } from "../decision-parser.js";
import {
  executeToolWithRetry,
  calculateRetryDelayForAgent,
  delay,
} from "../tool-executor.js";
import {
  createSessionRecord,
  saveSession,
  getSessions as getSessionsFn,
  getSession as getSessionFn,
} from "../session-persistence.js";

export class LegacyAgentRunner {
  private compressor = new MemoryCompressor();

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
      guardConfig?: Partial<AgentGuardConfig> | null;
      scope?: ExecutionScope;
      skipUserMessageSave?: boolean;
      skipAssistantMessageSave?: boolean;
    } = {},
  ): AsyncGenerator<AgentStreamEvent> {
    const maxIterations = options.maxIterations || DEFAULT_MAX_ITERATIONS;
    const enabledTools = options.tools?.length ? options.tools : null;
    const scope = options.scope;
    const signal = scope?.context.signal;
    const skipAssistantSave = options.skipAssistantMessageSave === true;

    // Transition controller from Pending → Running so state machine is accurate
    scope?.controller.start();

    // 1. Resolve model/provider
    const [providerName, resolvedModel] = resolveModel(options.model);
    const provider = getProvider(providerName);

    // 1b. Initialize Agent Guard
    const guard = new AgentGuardService(options.guardConfig ?? undefined);
    let tokensUsed = 0;
    let costCentsUsed = 0;

    // 1c. Memory compression state (P0-3)
    let compressedSummary: string = "";
    let keptStepNumbers: Set<number> = new Set();

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
    const sessionRecord = createSessionRecord(sessionId, conversationId, task);

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

    // 7. Save the task as a user message (skip if caller already persisted a clean version)
    if (!options.skipUserMessageSave) {
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
    }

    // 8. Send meta event
    yield {
      type: "agent_meta",
      session_id: sessionId,
      model: resolvedModel,
      provider: providerName,
      max_iterations: maxIterations,
      tools_enabled: toolsEnabled ? toolRegistry.listNames() : undefined,
    };

    // 9. ReAct Loop
    const scratchpad: AgentStep[] = [];
    let finalContent = "";
    let totalSteps = 0;

    // Track whether tools have been used — once they have, switch to respond-only mode
    // where the LLM outputs clean Markdown directly (no JSON wrapping) for real streaming
    let respondOnly = false;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      totalSteps = iteration + 1;

      // Runtime cancellation: check if execution was interrupted
      if (scope?.controller.shouldStop) {
        logger.info({ sessionId, iteration: totalSteps }, "Agent interrupted by runtime signal");
        const result = scope.controller.interrupt();
        // Save partial content if any
        if (finalContent && !skipAssistantSave) {
          await prisma.message.create({
            data: {
              id: randomUUID(),
              conversationId,
              role: "assistant",
              content: finalContent,
              model: resolvedModel,
            },
          });
        }
        await saveSession(sessionRecord, scratchpad, "failed", "Interrupted by user");
        yield {
          type: "agent_done",
          total_steps: totalSteps,
          final_summary: result.termination,
          session_id: sessionId,
        };
        return;
      }

      logger.debug(
        { sessionId, iteration: totalSteps },
        "Agent iteration start",
      );

      // 9a. Build messages for this iteration
      // In respond-only mode: simple prompt, no tools — LLM streams clean Markdown
      const iterationSystemPrompt = respondOnly
        ? getRespondOnlySystemPrompt()
        : systemPrompt;

      const iterationTools = respondOnly ? undefined : toolDefs;

      const iterationMessages: ChatMessage[] = [
        {
          role: "system",
          content: buildIterationContext(
            iterationSystemPrompt,
            task,
            scratchpad,
            totalSteps,
            compressedSummary,
            keptStepNumbers,
            respondOnly,
          ),
        },
        ...conversationMessages,
      ];

      // 9b. Call LLM with retry — stream tokens in real time, intercept agent_decide tool calls
      const streamMsgId = randomUUID();
      let llmResponse = "";
      let agentDecision: AgentStep | null = null; // set if LLM calls agent_decide
      let nativeToolCalls: Array<{
        name: string;
        args: Record<string, unknown>;
        result: ExecutionResult;
      }> = []; // track native tool calls for ReAct loop continuation
      let llmAttempt = 0;
      const maxLlmAttempts = DEFAULT_LLM_RETRY.maxAttempts;
      let llmSucceeded = false;
      let lastLlmError: string = "";

      // ── Observability: access trace from scope ──
      const trace: ObservabilityTrace | undefined = options.scope?.trace;

      while (!llmSucceeded && llmAttempt < maxLlmAttempts) {
        llmAttempt++;
        // Reset state for retry attempts
        if (llmAttempt > 1) {
          llmResponse = "";
          agentDecision = null;
          nativeToolCalls = [];
          yield {
            type: "agent_clear_stream",
            message_id: streamMsgId,
            step: totalSteps,
          };
        }

        try {
          // ── Observability: LLM Generation ──
          const lfGen = trace?.generation({
            name: respondOnly
              ? `llm-respond-iteration-${totalSteps}`
              : `llm-reAct-iteration-${totalSteps}`,
            model: resolvedModel,
            input: iterationMessages.slice(-3),
            metadata: {
              iteration: totalSteps,
              provider: providerName,
              respondOnly,
              toolCount: iterationTools?.length ?? 0,
              llmAttempt,
            },
          });

          let llmUsage: {
            prompt_tokens: number;
            completion_tokens: number;
            total_tokens: number;
          } | null = null;

          for await (const chunk of provider.streamChat(
            iterationMessages,
            resolvedModel,
            undefined, // system prompt is in messages
            undefined, // temperature
            undefined, // maxTokens
            iterationTools,
            signal, // AbortSignal for cancellation
          )) {
            if (chunk.type === "token" && chunk.content) {
              llmResponse += chunk.content;
              yield {
                type: "agent_token",
                content: chunk.content,
                message_id: streamMsgId,
              };
            } else if (chunk.type === "done" && chunk.usage) {
              // 捕获 Token 用量（Provider 在 done chunk 中返回）
              llmUsage = {
                prompt_tokens: chunk.usage.prompt_tokens,
                completion_tokens: chunk.usage.completion_tokens,
                total_tokens: chunk.usage.total_tokens,
              };
            } else if (chunk.type === "tool_call" && chunk.tool_call) {
              const tc = chunk.tool_call;
              if (tc.name === "agent_decide") {
                agentDecision = parseAgentDecideFromArgs(
                  tc.arguments,
                  totalSteps,
                );
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
                try {
                  args = JSON.parse(tc.arguments);
                } catch (err: unknown) {
                  logger.warn(
                    { toolCallId: tc.id, rawArguments: tc.arguments?.slice(0, 200) },
                    "Failed to parse agent decision arguments, using empty args",
                  );
                  args = {};
                }
                const toolResult = await executeToolWithRetry(
                  tc.name,
                  args,
                  conversationMessages,
                  sessionId,
                  totalSteps,
                  scope?.context,
                );
                nativeToolCalls.push({
                  name: tc.name,
                  args,
                  result: toolResult,
                });
                yield {
                  type: "agent_observe",
                  step: totalSteps,
                  result: executionResultToContent(toolResult),
                };
              }
            }
          }
          llmSucceeded = true;

          // ── End LLM generation with output and usage ──
          if (lfGen) {
            lfGen.end({
              output: llmResponse.slice(0, 2000),
              usage: llmUsage
                ? {
                    promptTokens: llmUsage.prompt_tokens,
                    completionTokens: llmUsage.completion_tokens,
                    totalTokens: llmUsage.total_tokens,
                  }
                : undefined,
            });
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          const classified = classifyError(error, "llm");
          lastLlmError = classified.message;

          // Fatal errors — fail immediately
          if (classified.category === "fatal") {
            logger.error(
              { sessionId, error: classified.message, attempt: llmAttempt },
              "LLM call fatal error",
            );
            yield {
              type: "agent_error",
              error: `LLM fatal: ${classified.message}`,
              step: totalSteps,
            };
            await saveSession(sessionRecord, scratchpad, "failed", null);
            return;
          }

          // Retryable — retry if attempts remain
          if (
            classified.category === "retryable" &&
            llmAttempt < maxLlmAttempts
          ) {
            const delayMs = calculateRetryDelayForAgent(
              DEFAULT_LLM_RETRY,
              llmAttempt,
            );
            logger.warn(
              {
                sessionId,
                attempt: llmAttempt,
                maxAttempts: maxLlmAttempts,
                delayMs,
                error: classified.message,
              },
              "LLM call retryable error, retrying",
            );
            await delay(delayMs);
            continue;
          }

          // Degradable or out of retries — log and degrade
          logger.warn(
            {
              sessionId,
              attempt: llmAttempt,
              category: classified.category,
              error: classified.message,
            },
            "LLM call degraded after attempts exhausted",
          );
        }
      }

      // All LLM attempts exhausted without success — degrade gracefully
      if (!llmSucceeded) {
        yield {
          type: "agent_degraded",
          step: totalSteps,
          original_tool: "",
          reason: `LLM调用失败（已尝试${llmAttempt}次）：${lastLlmError}`,
          retried: llmAttempt > 1,
          attempts: llmAttempt,
        };
        // Inject degradation context so agent can adjust
        const degradationMsg = `[系统提示] 上一轮模型调用失败（${lastLlmError}）。请基于已有信息继续尝试完成任务，或向用户说明当前情况。`;
        conversationMessages.push({
          role: "user",
          content: degradationMsg,
        });
        // Continue to next ReAct iteration — agent will work with what it has
        continue;
      }

      // 9b-continued. If LLM called native tools (not agent_decide), feed results back and continue ReAct loop
      if (nativeToolCalls.length > 0) {
        // Clear any streamed text (the LLM's "let me look that up" preamble)
        if (llmResponse.trim().length > 0) {
          yield {
            type: "agent_clear_stream",
            message_id: streamMsgId,
            step: totalSteps,
          };
        }

        // Save assistant message with tool calls
        if (!skipAssistantSave) {
          await prisma.message.create({
            data: {
              id: streamMsgId,
              conversationId,
              role: "assistant",
              content: JSON.stringify({
                tool_calls: nativeToolCalls.map((tc) => ({
                  name: tc.name,
                  arguments: tc.args,
                })),
              }),
              model: resolvedModel,
            },
          });
        }

        // Feed tool results back as user messages for next iteration
        for (const tc of nativeToolCalls) {
          conversationMessages.push({
            role: "user",
            content: `[工具返回] ${tc.name}: ${executionResultToContent(tc.result)}`,
          });
        }

        // Record steps in scratchpad
        for (const tc of nativeToolCalls) {
          scratchpad.push({
            step: totalSteps,
            observation: `调用了工具 ${tc.name}`,
            analysis: `工具 ${tc.name} 返回了数据`,
            plan: "查看工具返回的数据并生成用户回复",
            decision: {
              action: "tool_call",
              tool: tc.name,
              args: tc.args,
              reason: "LLM通过原生tool calling直接调用",
            },
            result: executionResultToContent(tc.result),
            timestamp: new Date().toISOString(),
          });
        }

        // Switch to respond-only mode for next iteration (LLM will output clean Markdown)
        // Note: agent_responding is deferred until LLM output is confirmed non-JSON
        respondOnly = true;

        // Continue to next ReAct iteration so LLM can use the tool result
        continue;
      }

      // 9b-respondOnly. LLM should output clean Markdown, but may still emit ReAct JSON.
      // Defensive: if output is JSON, extract natural language; otherwise stream as-is.
      if (respondOnly) {
        // Screen for leaked ReAct JSON — if so, try to salvage natural language from it
        if (looksLikeReActJSON(llmResponse)) {
          const extracted = tryExtractRespondContent(llmResponse);
          if (extracted) {
            finalContent = extracted;
          } else {
            // Cannot salvage — use degradation fallback
            logger.warn(
              { sessionId, llmResponse: llmResponse.slice(0, 200) },
              "Respond-only LLM output is ReAct JSON, using fallback",
            );
            finalContent =
              "抱歉，暂时无法处理您的请求，请稍后再试或联系人工客服。";
          }

          // Clear any accumulated (non-streamed) tokens from agent-executor buffer
          yield {
            type: "agent_clear_stream",
            message_id: streamMsgId,
            step: totalSteps,
          };
        } else {
          finalContent = llmResponse;
        }

        // Yield responding + tokens for the cleaned content
        yield {
          type: "agent_responding",
          step: totalSteps,
        };
        for (const char of finalContent) {
          yield {
            type: "agent_token",
            content: char,
            message_id: streamMsgId,
          };
        }

        // Save assistant message
        if (!skipAssistantSave) {
          await prisma.message.create({
            data: {
              id: streamMsgId,
              conversationId,
              role: "assistant",
              content: finalContent,
              model: resolvedModel,
            },
          });
        }

        yield {
          type: "agent_respond",
          content: finalContent,
          summary: "Agent completed (respond-only)",
          message_id: streamMsgId,
        };

        await saveSession(
          sessionRecord,
          scratchpad,
          "completed",
          "Task completed",
          compressedSummary,
        );

        yield {
          type: "agent_done",
          total_steps: totalSteps,
          final_summary: "Task completed",
          session_id: sessionId,
        };
        return;
      }

      // 9c. Parse decision — prefer native tool calling, fall back to JSON text
      const step = agentDecision || parseStep(llmResponse, totalSteps);
      // Track whether decision was parsed from raw text (vs agent_decide tool call)
      const parsedFromText = agentDecision === null && step !== null;
      if (!step) {
        logger.warn(
          { sessionId, response: llmResponse.slice(0, 200) },
          "Failed to parse agent decision — treating as respond",
        );

        // 防御：检查 llmResponse 是否为 ReAct JSON，尝试提取可读内容
        let responseContent: string;
        if (looksLikeReActJSON(llmResponse)) {
          const extracted = tryExtractRespondContent(llmResponse);
          responseContent = extracted ||
            "抱歉，暂时无法处理您的请求，请稍后再试或联系人工客服。";
        } else {
          responseContent = llmResponse;
        }

        // Save it as the assistant message.
        if (!skipAssistantSave) {
          await prisma.message.create({
            data: {
              id: streamMsgId,
              conversationId,
              role: "assistant",
              content: responseContent,
              model: resolvedModel,
            },
          });
        }

        yield {
          type: "agent_clear_stream",
          message_id: streamMsgId,
          step: totalSteps,
        };
        yield {
          type: "agent_responding",
          step: totalSteps,
        };
        for (const char of responseContent) {
          yield {
            type: "agent_token",
            content: char,
            message_id: streamMsgId,
          };
        }
        yield {
          type: "agent_respond",
          content: responseContent,
          summary: "Agent completed (unstructured)",
          message_id: streamMsgId,
        };

        await saveSession(
          sessionRecord,
          scratchpad,
          "completed",
          "Task completed",
        );
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
        // as agent_token events during the LLM call
        // If the decision was parsed from raw text (not agent_decide), clear the
        // streamed JSON text before sending the clean response
        if (parsedFromText) {
          yield {
            type: "agent_clear_stream",
            message_id: streamMsgId,
            step: totalSteps,
          };
        }

        yield {
          type: "agent_responding",
          step: totalSteps,
        };

        yield {
          type: "agent_act",
          step: totalSteps,
          decision,
        };

        finalContent = decision.content;

        // PII scan on response
        const responseGuard = guard.guardResponse(finalContent);
        if (!responseGuard.safe) {
          // Content was blocked — replace with safe message
          finalContent = responseGuard.sanitizedContent;
        }
        // Use sanitized content for DB save
        const safeContent = responseGuard.sanitizedContent;

        // Save assistant message (ID matches the streamed tokens)
        if (!skipAssistantSave) {
          await prisma.message.create({
            data: {
              id: streamMsgId,
              conversationId,
              role: "assistant",
              content: safeContent,
              model: resolvedModel,
            },
          });
        }

        // Complete step
        step.result = decision.summary;
        scratchpad.push(step);

        yield {
          type: "agent_respond",
          content: safeContent,
          summary: decision.summary,
          message_id: streamMsgId,
        };

        // Save session as completed
        await saveSession(
          sessionRecord,
          scratchpad,
          "completed",
          decision.summary,
          compressedSummary,
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
        const registeredTool = toolRegistry
          .getAll()
          .find((t) => t.definition.function.name === decision.tool);

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
            logger.warn(
              { error: err instanceof Error ? err.message : "Unknown error" },
              "Failed to create approval record",
            );
          }

          // Save session as paused
          await saveSession(sessionRecord, scratchpad, "paused", null);

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

        // No approval needed — check guard before executing
        const guardCheck = guard.guardToolCall(
          decision.tool,
          decision.args,
          tokensUsed,
          costCentsUsed,
          resolvedModel,
        );
        if (!guardCheck.allowed) {
          step.result = `[安全守卫拦截] ${guardCheck.blockReason}`;
          scratchpad.push(step);
          // P0-3: Memory compression check
          const compResult = this.compressor.compress(scratchpad);
          if (compResult.compressedCount > 0) {
            compressedSummary = compResult.summary;
            keptStepNumbers = new Set(compResult.keptSteps.map((s) => s.step));
          }
          yield {
            type: "agent_guard_block",
            step: totalSteps,
            reason: "tool_blocked",
            detail: guardCheck.blockReason!,
          };
          // Inject rejection as tool result so agent can adjust
          conversationMessages.push({
            role: "user",
            content: `[系统提示] 工具 "${decision.tool}" 被安全策略拦截：${guardCheck.blockReason}`,
          });
          continue; // Skip to next ReAct iteration
        }

        // Execute with retry
        const toolResult = await executeToolWithRetry(
          decision.tool,
          decision.args,
          conversationMessages,
          sessionId,
          totalSteps,
          scope?.context,
        );

        // Check if the result is degraded
        const isDegraded = isDegradedResult(toolResult);
        const toolResultContent = executionResultToContent(toolResult);
        if (isDegraded) {
          step.error = {
            category: "degradable",
            message: toolResultContent,
            retried: true,
            attempts: DEFAULT_TOOL_RETRY.maxAttempts,
          };
        }

        // Yield observe event
        yield {
          type: "agent_observe",
          step: totalSteps,
          result: toolResultContent,
        };

        // Record step in scratchpad
        step.result = toolResultContent;
        scratchpad.push(step);
        // P0-3: Memory compression check
        if (scratchpad.length > SCRATCHPAD_COMPRESSION_THRESHOLD) {
          const compResult = this.compressor.compress(scratchpad);
          if (compResult.compressedCount > 0) {
            compressedSummary = compResult.summary;
            keptStepNumbers = new Set(compResult.keptSteps.map((s) => s.step));
          }
        }

        // 仅在文本解析路径强制 respondOnly：qwen-coder-turbo 等模型输出
        // ReAct JSON 作为文本，下一轮必须用 respond-only prompt 避免再次泄漏。
        // native agent_decide tool call 路径不受影响，遵循原有逻辑。
        if (parsedFromText) {
          respondOnly = true;
          continue;
        }
        // native agent_decide 路径：fall through 到循环末尾，正常进入下一轮
      } else if (decision.action === "ask_user") {
        // Agent needs clarification — pause and wait
        // P0: Clear streamed ReAct JSON tokens before pausing.
        // Without this, the accumulated JSON text leaks to the user via
        // AgentExecutor's post-processing fallback (sanitizeReActJSON).
        // Pattern matches respond and tool_call branches in main loop.
        if (parsedFromText) {
          yield {
            type: "agent_clear_stream",
            message_id: streamMsgId,
            step: totalSteps,
          };
        }

        scratchpad.push(step);

        await saveSession(
          sessionRecord,
          scratchpad,
          "paused",
          null,
          compressedSummary,
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
    logger.warn(
      { sessionId, iterations: totalSteps },
      "Agent reached max iterations",
    );
    await saveSession(
      sessionRecord,
      scratchpad,
      "failed",
      `Reached maximum ${maxIterations} iterations without completing the task.`,
      compressedSummary,
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
    scope?: ExecutionScope,
  ): AsyncGenerator<AgentStreamEvent> {
    // 1. Load and validate paused session
    const session = await getSessionFn(sessionId);
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
      scope,
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
    scope?: ExecutionScope,
  ): AsyncGenerator<AgentStreamEvent> {
    // 1. Load the paused session
    const session = await getSessionFn(sessionId);
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
    } catch (err: unknown) {
      logger.error({ err, approvalId }, "Failed to load approval record");
      yield {
        type: "agent_error",
        error: "Failed to load approval record",
        step: 0,
      };
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
      await saveSession(
        createSessionRecord(sessionId, conversationId, task),
        scratchpad,
        "running",
        null,
      );

      yield* this.continueReActLoop(
        sessionId,
        conversationId,
        task,
        scratchpad,
        scratchpad.length,
        scope,
      );
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
        yield {
          type: "agent_error",
          error: "Step not found in scratchpad",
          step: 0,
        };
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

      // Execute the tool with retry
      const toolResult = await executeToolWithRetry(
        approval.toolName,
        args,
        conversationMessages,
        sessionId,
        approval.stepNumber,
        scope?.context, // Propagate parent context for cancellation
      );

      // Record result
      const approvalResultContent = executionResultToContent(toolResult);
      step.result = approvalResultContent;
      conversationMessages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: randomUUID(),
            type: "function",
            function: {
              name: approval.toolName,
              arguments: JSON.stringify(args),
            },
          },
        ],
      });
      conversationMessages.push({
        role: "tool",
        tool_call_id:
          conversationMessages[conversationMessages.length - 1].tool_calls![0]
            .id,
        content: approvalResultContent,
      });

      yield {
        type: "agent_approval_result",
        approval_id: approvalId,
        session_id: sessionId,
        step: approval.stepNumber,
        status: "approved",
        modified_args: modifiedArgs,
        result: approvalResultContent,
      } satisfies AgentApprovalResultEvent;

      yield {
        type: "agent_observe",
        step: approval.stepNumber,
        result: approvalResultContent,
      };

      // Save session as running and continue
      await saveSession(
        createSessionRecord(sessionId, conversationId, task),
        scratchpad,
        "running",
        null,
      );

      yield* this.continueReActLoop(
        sessionId,
        conversationId,
        task,
        scratchpad,
        scratchpad.length,
        scope,
      );
      return;
    } else {
      // Reject
      await prisma.agentApproval.update({
        where: { id: approvalId },
        data: {
          status: "rejected",
          rejectionReason:
            rejectionReason || "User rejected the tool execution",
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
      await saveSession(
        createSessionRecord(sessionId, conversationId, task),
        scratchpad,
        "running",
        null,
      );

      yield* this.continueReActLoop(
        sessionId,
        conversationId,
        task,
        scratchpad,
        scratchpad.length,
        scope,
      );
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
    scope?: ExecutionScope,
  ): AsyncGenerator<AgentStreamEvent> {
    const [providerName, resolvedModel] = resolveModel();
    const provider = getProvider(providerName);
    const signal = scope?.context.signal;

    // AgentGuardService — security parity with run().
    // Initialized with undefined guardConfig (defaults); full guardConfig passthrough
    // from session state is scheduled for Phase B (dedup + state unification).
    const guard = new AgentGuardService();

    const toolDefs = [AGENT_DECIDE_TOOL, ...toolRegistry.getDefinitions()];

    const systemPrompt = REACT_PROMPT_WITH_TOOLS;
    const maxIterations = DEFAULT_MAX_ITERATIONS;

    // Track whether tools have been used — same as main run() loop.
    // Once set, LLM outputs clean Markdown (no JSON wrapping) for real streaming.
    let respondOnly = false;

    let finalContent = "";

    // Memory compression state (P0-3) — minimal tracking for continue loop
    let compressedSummary: string = "";
    let keptStepNumbers: Set<number> = new Set();

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

    for (
      let iteration = startIteration;
      iteration < maxIterations;
      iteration++
    ) {
      const totalSteps = iteration + 1;
      logger.debug(
        { sessionId, iteration: totalSteps },
        "Agent continue iteration",
      );

      // Runtime cancellation: check if execution was interrupted
      if (scope?.controller.shouldStop) {
        logger.info({ sessionId, iteration: totalSteps }, "Agent continue loop interrupted by runtime signal");
        const result = scope.controller.interrupt();
        await saveSession(
          createSessionRecord(sessionId, conversationId, task),
          scratchpad,
          "failed",
          "Interrupted by user",
        );
        yield {
          type: "agent_done",
          total_steps: totalSteps,
          final_summary: result.termination,
          session_id: sessionId,
        };
        return;
      }

      await saveSession(
        createSessionRecord(sessionId, conversationId, task),
        scratchpad,
        "running",
        null,
      );

      const iterationSystemPrompt = respondOnly
        ? getRespondOnlySystemPrompt()
        : systemPrompt;

      const iterationTools = respondOnly ? undefined : toolDefs;

      const iterationMessages: ChatMessage[] = [
        {
          role: "system",
          content: buildIterationContext(
            iterationSystemPrompt,
            task,
            scratchpad,
            totalSteps,
            compressedSummary,
            keptStepNumbers,
            respondOnly,
          ),
        },
        ...conversationMessages,
      ];

      const streamMsgId = randomUUID();
      let llmResponse = "";
      let agentDecision: AgentStep | null = null;
      let llmAttempt = 0;
      const maxLlmAttempts = DEFAULT_LLM_RETRY.maxAttempts;
      let llmSucceeded = false;
      let lastLlmError = "";

      // ── Observability: access trace from scope ──
      const trace: ObservabilityTrace | undefined = scope?.trace;

      while (!llmSucceeded && llmAttempt < maxLlmAttempts) {
        llmAttempt++;
        if (llmAttempt > 1) {
          llmResponse = "";
          agentDecision = null;
          yield {
            type: "agent_clear_stream",
            message_id: streamMsgId,
            step: totalSteps,
          };
        }

        try {
          // ── Observability: LLM Generation ──
          const lfGen = trace?.generation({
            name: respondOnly
              ? `llm-respond-iteration-${totalSteps}`
              : `llm-reAct-iteration-${totalSteps}`,
            model: resolvedModel,
            input: iterationMessages.slice(-3),
            metadata: {
              iteration: totalSteps,
              provider: providerName,
              respondOnly,
              toolCount: iterationTools?.length ?? 0,
              llmAttempt,
            },
          });

          let llmUsage: {
            prompt_tokens: number;
            completion_tokens: number;
            total_tokens: number;
          } | null = null;

          for await (const chunk of provider.streamChat(
            iterationMessages,
            resolvedModel,
            undefined,
            undefined,
            undefined,
            iterationTools,
            signal, // Pass AbortSignal for cancellation support
          )) {
            if (chunk.type === "token" && chunk.content) {
              llmResponse += chunk.content;
              yield {
                type: "agent_token",
                content: chunk.content,
                message_id: streamMsgId,
              };
            } else if (chunk.type === "done" && chunk.usage) {
              // 捕获 Token 用量（Provider 在 done chunk 中返回）
              llmUsage = {
                prompt_tokens: chunk.usage.prompt_tokens,
                completion_tokens: chunk.usage.completion_tokens,
                total_tokens: chunk.usage.total_tokens,
              };
            } else if (chunk.type === "tool_call" && chunk.tool_call) {
              const tc = chunk.tool_call;
              if (tc.name === "agent_decide") {
                agentDecision = parseAgentDecideFromArgs(
                  tc.arguments,
                  totalSteps,
                );
                if (agentDecision && llmResponse.trim().length > 0) {
                  yield {
                    type: "agent_clear_stream",
                    message_id: streamMsgId,
                    step: totalSteps,
                  };
                }
              } else {
                // Real tool call — execute with retry
                let tcArgs: Record<string, unknown> = {};
                try {
                  tcArgs = JSON.parse(tc.arguments);
                } catch (err: unknown) {
                  logger.warn(
                    { toolCallId: tc.id, rawArguments: tc.arguments?.slice(0, 200) },
                    "Failed to parse tool call arguments in continue loop, using empty args",
                  );
                  tcArgs = {};
                }
                const result = await executeToolWithRetry(
                  tc.name,
                  tcArgs,
                  conversationMessages,
                  sessionId,
                  totalSteps,
                  scope?.context, // Propagate parent context for cancellation
                );
                yield {
                  type: "agent_observe",
                  step: totalSteps,
                  result: `Tool ${tc.name}: ${result}`,
                };
              }
            }
          }
          llmSucceeded = true;

          // ── End LLM generation with output and usage ──
          if (lfGen) {
            lfGen.end({
              output: llmResponse.slice(0, 2000),
              usage: llmUsage
                ? {
                    promptTokens: llmUsage.prompt_tokens,
                    completionTokens: llmUsage.completion_tokens,
                    totalTokens: llmUsage.total_tokens,
                  }
                : undefined,
            });
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          const classified = classifyError(error, "llm");
          lastLlmError = classified.message;

          if (classified.category === "fatal") {
            logger.error(
              { sessionId, error: classified.message, attempt: llmAttempt },
              "LLM call fatal error (continue loop)",
            );
            yield {
              type: "agent_error",
              error: `LLM fatal: ${classified.message}`,
              step: totalSteps,
            };
            await saveSession(
              createSessionRecord(sessionId, conversationId, task),
              scratchpad,
              "failed",
              null,
            );
            return;
          }

          if (
            classified.category === "retryable" &&
            llmAttempt < maxLlmAttempts
          ) {
            const delayMs = calculateRetryDelayForAgent(
              DEFAULT_LLM_RETRY,
              llmAttempt,
            );
            logger.warn(
              {
                sessionId,
                attempt: llmAttempt,
                maxAttempts: maxLlmAttempts,
                delayMs,
                error: classified.message,
              },
              "LLM call retryable error in continue loop, retrying",
            );
            await delay(delayMs);
            continue;
          }

          logger.warn(
            {
              sessionId,
              attempt: llmAttempt,
              category: classified.category,
              error: classified.message,
            },
            "LLM call degraded in continue loop",
          );
        }
      }

      // All LLM attempts exhausted — degrade gracefully
      if (!llmSucceeded) {
        yield {
          type: "agent_degraded",
          step: totalSteps,
          original_tool: "",
          reason: `LLM调用失败（已尝试${llmAttempt}次）：${lastLlmError}`,
          retried: llmAttempt > 1,
          attempts: llmAttempt,
        };
        conversationMessages.push({
          role: "user",
          content: `[系统提示] 上一轮模型调用失败（${lastLlmError}）。请基于已有信息继续尝试完成任务。`,
        });
        continue;
      }

      const step = agentDecision || parseStep(llmResponse, totalSteps);
      const parsedFromText = !agentDecision;
      if (!step) {
        // P0: ReAct JSON leak prevention — try to extract natural language
        // before saving raw LLM output. Mirrors the defense in run() main loop
        // Mirrors the defense in run() main loop unstructured-response branch:
        // tryExtractRespondContent → agent_clear_stream → re-emit.
        const extracted = tryExtractRespondContent(llmResponse);
        const safeContent = extracted ?? llmResponse;

        if (extracted && parsedFromText) {
          // Clear streamed JSON tokens before re-emitting clean content
          yield {
            type: "agent_clear_stream",
            message_id: streamMsgId,
            step: totalSteps,
          };
        }

        await prisma.message.create({
          data: {
            id: streamMsgId,
            conversationId,
            role: "assistant",
            content: safeContent,
            model: resolvedModel,
          },
        });
        yield {
          type: "agent_respond",
          content: safeContent,
          summary: "Agent completed (unstructured)",
          message_id: streamMsgId,
        };
        await saveSession(
          createSessionRecord(sessionId, conversationId, task),
          scratchpad,
          "completed",
          "Task completed",
        );
        yield {
          type: "agent_done",
          total_steps: totalSteps,
          final_summary: "Task completed",
          session_id: sessionId,
        };
        return;
      }

      // respondOnly 模式：LLM 应输出干净 Markdown，但可能仍输出 ReAct JSON。
      // 防御逻辑与主循环 run() 的 respondOnly 分支对称。
      if (respondOnly) {
        if (looksLikeReActJSON(llmResponse)) {
          const extracted = tryExtractRespondContent(llmResponse);
          if (extracted) {
            finalContent = extracted;
          } else {
            logger.warn(
              { sessionId, llmResponse: llmResponse.slice(0, 200) },
              "Respond-only LLM output is ReAct JSON in continue loop, using fallback",
            );
            finalContent =
              "抱歉，暂时无法处理您的请求，请稍后再试或联系人工客服。";
          }

          yield {
            type: "agent_clear_stream",
            message_id: streamMsgId,
            step: totalSteps,
          };
        } else {
          finalContent = llmResponse;
        }

        yield {
          type: "agent_responding",
          step: totalSteps,
        };
        for (const char of finalContent) {
          yield {
            type: "agent_token",
            content: char,
            message_id: streamMsgId,
          };
        }

        await prisma.message.create({
          data: {
            id: streamMsgId,
            conversationId,
            role: "assistant",
            content: finalContent,
            model: resolvedModel,
          },
        });

        yield {
          type: "agent_respond",
          content: finalContent,
          summary: "Agent completed (respond-only)",
          message_id: streamMsgId,
        };

        await saveSession(
          createSessionRecord(sessionId, conversationId, task),
          scratchpad,
          "completed",
          "Task completed",
          compressedSummary,
        );

        yield {
          type: "agent_done",
          total_steps: totalSteps,
          final_summary: "Task completed",
          session_id: sessionId,
        };
        return;
      }

      yield {
        type: "agent_think",
        step: totalSteps,
        observation: step.observation,
        analysis: step.analysis,
        plan: step.plan,
      };
      const decision = step.decision;

      if (decision.action === "respond") {
        // PII guard — security parity with run()
        const responseGuard = guard.guardResponse(decision.content);
        const safeContent = responseGuard.sanitizedContent;

        yield { type: "agent_responding", step: totalSteps };
        yield { type: "agent_act", step: totalSteps, decision };
        await prisma.message.create({
          data: {
            id: streamMsgId,
            conversationId,
            role: "assistant",
            content: safeContent,
            model: resolvedModel,
          },
        });
        step.result = decision.summary;
        scratchpad.push(step);
        yield {
          type: "agent_respond",
          content: safeContent,
          summary: decision.summary,
          message_id: streamMsgId,
        };
        await saveSession(
          createSessionRecord(sessionId, conversationId, task),
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
        yield {
          type: "agent_clear_stream",
          message_id: streamMsgId,
          step: totalSteps,
        };
        yield { type: "agent_act", step: totalSteps, decision };

        // P1-5 Approval Gate (during continuation loop)
        const registeredTool = toolRegistry
          .getAll()
          .find((t) => t.definition.function.name === decision.tool);

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
            logger.warn(
              { error: err instanceof Error ? err.message : "Unknown error" },
              "Failed to create approval record",
            );
          }

          await saveSession(
            createSessionRecord(sessionId, conversationId, task),
            scratchpad,
            "paused",
            null,
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

        // AgentGuard tool call allowlist — security parity with run()
        const guardCheck = guard.guardToolCall(
          decision.tool,
          decision.args,
          0, // tokensUsed — tracked per-iteration; pass 0 for guard baseline
          0, // costCentsUsed — tracked per-iteration; pass 0 for guard baseline
          resolvedModel,
        );
        if (!guardCheck.allowed) {
          logger.warn(
            {
              sessionId,
              tool: decision.tool,
              blockReason: guardCheck.blockReason,
            },
            "AgentGuard blocked tool call in continue loop",
          );
          step.result = `Blocked: ${guardCheck.blockReason}`;
          scratchpad.push(step);
          yield {
            type: "agent_guard_block",
            step: totalSteps,
            reason: "tool_blocked",
            detail: guardCheck.blockReason!,
          };
          conversationMessages.push({
            role: "user",
            content: `[系统提示] 工具 "${decision.tool}" 被安全策略拦截：${guardCheck.blockReason}`,
          });
          continue; // Skip to next ReAct iteration
        }

        const toolResult = await executeToolWithRetry(
          decision.tool,
          decision.args,
          conversationMessages,
          sessionId,
          totalSteps,
          scope?.context, // Propagate parent context for cancellation
        );
        // Check if the result is degraded
        const isDegradedC = isDegradedResult(toolResult);
        const toolResultContentC = executionResultToContent(toolResult);
        if (isDegradedC) {
          step.error = {
            category: "degradable",
            message: toolResultContentC,
            retried: true,
            attempts: DEFAULT_TOOL_RETRY.maxAttempts,
          };
        }
        yield { type: "agent_observe", step: totalSteps, result: toolResultContentC };
        step.result = toolResultContentC;
        scratchpad.push(step);
        // P0-3: Memory compression check
        if (scratchpad.length > SCRATCHPAD_COMPRESSION_THRESHOLD) {
          const cResult = this.compressor.compress(scratchpad);
          if (cResult.compressedCount > 0) {
            compressedSummary = cResult.summary;
            keptStepNumbers = new Set(cResult.keptSteps.map((s) => s.step));
          }
        }

        // 文本解析路径下切换到 respond-only 模式（与主循环 tool_call 分支一致）
        if (parsedFromText) {
          respondOnly = true;
          continue;
        }
      } else if (decision.action === "ask_user") {
        // P0: Clear streamed ReAct JSON tokens before pausing.
        // Pattern matches main loop ask_user branch.
        if (parsedFromText) {
          yield {
            type: "agent_clear_stream",
            message_id: streamMsgId,
            step: totalSteps,
          };
        }

        scratchpad.push(step);
        // P0-3: Compression check before pausing
        const cResultPause = this.compressor.compress(scratchpad);
        if (cResultPause.compressedCount > 0) {
          compressedSummary = cResultPause.summary;
          keptStepNumbers = new Set(cResultPause.keptSteps.map((s) => s.step));
        }
        await saveSession(
          createSessionRecord(sessionId, conversationId, task),
          scratchpad,
          "paused",
          null,
          compressedSummary,
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

    yield {
      type: "agent_error",
      error: `Maximum iterations (${maxIterations}) reached`,
      step: startIteration + maxIterations,
    };
  }

  /**
   * Get agent sessions for a conversation.
   * Thin wrapper delegating to session-persistence module.
   */
  async getSessions(conversationId: string): Promise<
    Array<{
      id: string;
      conversationId: string;
      task: string;
      status: string;
      scratchpad: AgentStep[];
      finalSummary: string | null;
      runtimeState: Record<string, unknown> | null;
      startedAt: Date;
      completedAt: Date | null;
    }>
  > {
    return getSessionsFn(conversationId);
  }

  /**
   * Get a single agent session by ID.
   * Thin wrapper delegating to session-persistence module.
   */
  async getSession(id: string): Promise<{
    id: string;
    conversationId: string;
    task: string;
    status: string;
    scratchpad: AgentStep[];
    finalSummary: string | null;
    runtimeState: Record<string, unknown> | null;
    startedAt: Date;
    completedAt: Date | null;
  } | null> {
    return getSessionFn(id);
  }
}

// ═══════════════════════════════════════════════════════
// Respond-Only JSON Salvage
// ═══════════════════════════════════════════════════════

/**
 * 尝试从 respond-only 模式下泄漏的 ReAct JSON 中提取自然语言内容。
 * LLM 有时不遵循 respond-only prompt，仍然输出 ReAct 格式的 JSON。
 * 此函数尝试从 decision.content / plan / observation 字段中提取有用文本。
 *
 * @returns 可展示给用户的自然语言文本，或 null（无法提取）
 */
function tryExtractRespondContent(llmResponse: string): string | null {
  try {
    const trimmed = llmResponse.trim();
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    // 如果 decision 包含 content 字段（LLM 尝试回答）
    if (parsed.decision && typeof parsed.decision === "object") {
      if (typeof parsed.decision.content === "string" && parsed.decision.content.trim()) {
        return parsed.decision.content.trim();
      }
      // P0: decision.question — LLM 需要向用户提问澄清
      // ask_user 路径中 question 是面向用户的问题文本，优先级高于 plan/observation
      if (typeof parsed.decision.question === "string" && parsed.decision.question.trim()) {
        return parsed.decision.question.trim();
      }
    }

    // 次选：顶层 content / summary（与 sanitizeReActJSON 统一优先级）
    if (typeof parsed.content === "string" && parsed.content.trim()) {
      return parsed.content.trim();
    }
    if (typeof parsed.summary === "string" && parsed.summary.trim()) {
      return parsed.summary.trim();
    }

    // 再次：plan 或 observation（与 sanitizeReActJSON 统一优先级）
    if (typeof parsed.plan === "string" && parsed.plan.trim()) {
      return parsed.plan.trim();
    }

    // observation 字段可能包含分析
    if (typeof parsed.observation === "string" && parsed.observation.trim()) {
      return parsed.observation.trim();
    }

    return null;
  } catch {
    return null;
  }
}
