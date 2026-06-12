// P1-5 — Hook for consuming Agent SSE streaming events from /api/agent/run
import { useCallback } from "react";
import type { AgentStreamEvent } from "@agentforge/shared-types";
import { useChatStore } from "@/stores/chat";

export function useAgentStream() {
  const {
    currentConversationId,
    selectedModel,
    enabledTools,
    appendMessage,
    setDebugInfo,
    setPendingApproval,
    clearPendingApproval,
    setPanelMode,
  } = useChatStore();

  const startAgentTask = useCallback(
    async (task: string, maxIterations: number = 10) => {
      if (!currentConversationId) return;

      setPanelMode("agent");

      // Add user task message
      const userMsg = {
        id: `agent-task-${Date.now()}`,
        conversation_id: currentConversationId,
        role: "user" as const,
        content: `/agent ${task}`,
        model: selectedModel,
        created_at: new Date().toISOString(),
      };
      appendMessage(userMsg);

      try {
        const token = localStorage.getItem("accessToken");
        const res = await fetch("/api/agent/run", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            conversation_id: currentConversationId,
            task,
            model: selectedModel,
            max_iterations: maxIterations,
            tools: enabledTools.length > 0 ? enabledTools : null,
          }),
        });

        if (!res.ok) {
          const err = await res
            .json()
            .catch(() => ({ detail: "Unknown error" }));
          throw new Error(err.detail ?? `HTTP ${res.status}`);
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;
            const data = trimmed.slice(6);
            if (data === "[DONE]") return;

            try {
              const event = JSON.parse(data) as AgentStreamEvent;
              handleAgentEvent(event);
            } catch {
              // Skip unparseable lines
            }
          }
        }
      } catch (err) {
        console.error("Agent stream failed:", err);
      }
    },
    [
      currentConversationId,
      selectedModel,
      enabledTools,
      appendMessage,
      setDebugInfo,
      setPendingApproval,
      clearPendingApproval,
      setPanelMode,
    ],
  );

  const handleAgentEvent = useCallback(
    (event: AgentStreamEvent) => {
      switch (event.type) {
        case "agent_meta":
          setDebugInfo({
            model: event.model,
            provider: event.provider,
            system_prompt: "",
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            latency_ms: 0,
            first_token_ms: 0,
            temperature: 0.7,
            max_tokens: 4096,
          });
          break;

        case "agent_respond":
          appendMessage({
            id: event.message_id,
            conversation_id: currentConversationId || "",
            role: "assistant",
            content: event.content,
            model: "",
            created_at: new Date().toISOString(),
          });
          break;

        case "agent_approval_required":
          setPendingApproval({
            approvalId: event.approval_id,
            sessionId: event.session_id,
            step: event.step,
            toolName: event.tool_name,
            toolArgs: event.tool_args,
            riskLevel: event.risk_level,
            reason: event.reason,
            timeoutMs: event.timeout_ms,
          });
          break;

        case "agent_approval_result":
          clearPendingApproval();
          break;

        case "agent_error":
          console.error("Agent error:", event.error);
          break;

        // Other events (think, act, observe, token, ask_user, clear_stream, done) are
        // currently displayed in AgentPanel via REST; no streaming UI needed yet
      }
    },
    // Stable callback — doesn't depend on changing state
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return { startAgentTask };
}
