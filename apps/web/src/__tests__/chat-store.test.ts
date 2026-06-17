// Chat store tests — Zustand store: appendStreamToken, toolCall tracking, state management
import { describe, it, expect, beforeEach } from "vitest";
import { useChatStore } from "../stores/chat.js";

describe("useChatStore", () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    useChatStore.getState().resetChat();
    useChatStore.setState({
      currentConversationId: null,
      messages: [],
      isStreaming: false,
      debugInfo: null,
      memoryInfo: null,
      toolCalls: [],
      enabledTools: [],
    });
  });

  describe("appendStreamToken", () => {
    it("should append a token to the __streaming__ message", () => {
      // Arrange
      useChatStore.setState({
        messages: [
          {
            id: "1",
            role: "user",
            content: "Hello",
            conversation_id: "c1",
            created_at: "",
            model: "",
          },
          {
            id: "__streaming__",
            role: "assistant",
            content: "Hel",
            conversation_id: "c1",
            created_at: "",
            model: "",
          },
        ],
      });

      // Act
      useChatStore.getState().appendStreamToken("lo");

      // Assert
      const msgs = useChatStore.getState().messages;
      expect(msgs[msgs.length - 1].content).toBe("Hello");
    });

    it("should append multiple tokens sequentially", () => {
      // Arrange
      useChatStore.setState({
        messages: [
          {
            id: "__streaming__",
            role: "assistant",
            content: "",
            conversation_id: "c1",
            created_at: "",
            model: "",
          },
        ],
      });

      // Act
      const store = useChatStore.getState();
      store.appendStreamToken("Hello");
      store.appendStreamToken(" ");
      store.appendStreamToken("World");

      // Assert
      const msgs = useChatStore.getState().messages;
      expect(msgs[0].content).toBe("Hello World");
    });

    it("should not modify state when messages array is empty", () => {
      // Arrange
      useChatStore.setState({ messages: [] });

      // Act
      useChatStore.getState().appendStreamToken("test");

      // Assert
      expect(useChatStore.getState().messages).toHaveLength(0);
    });

    it("should not append to non-streaming assistant message", () => {
      // Arrange
      useChatStore.setState({
        messages: [
          {
            id: "msg1",
            role: "assistant",
            content: "Existing",
            conversation_id: "c1",
            created_at: "",
            model: "",
          },
        ],
      });

      // Act
      useChatStore.getState().appendStreamToken("Extra");

      // Assert
      const msgs = useChatStore.getState().messages;
      // Last message is not __streaming__, so nothing should change
      expect(msgs[0].content).toBe("Existing");
    });

    it("should not append to user message at end", () => {
      // Arrange
      useChatStore.setState({
        messages: [
          {
            id: "1",
            role: "user",
            content: "Hello",
            conversation_id: "c1",
            created_at: "",
            model: "",
          },
        ],
      });

      // Act
      useChatStore.getState().appendStreamToken("Extra");

      // Assert
      expect(useChatStore.getState().messages[0].content).toBe("Hello");
    });
  });

  describe("addToolCall", () => {
    it("should add a tool call with pending status", () => {
      // Act
      useChatStore.getState().addToolCall({
        id: "tc1",
        name: "calculator",
        arguments: '{"expr":"2+2"}',
      });

      // Assert
      const toolCalls = useChatStore.getState().toolCalls;
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].id).toBe("tc1");
      expect(toolCalls[0].name).toBe("calculator");
      expect(toolCalls[0].arguments).toBe('{"expr":"2+2"}');
      expect(toolCalls[0].status).toBe("pending");
    });

    it("should accumulate multiple tool calls", () => {
      // Act
      useChatStore
        .getState()
        .addToolCall({ id: "tc1", name: "calc", arguments: "{}" });
      useChatStore
        .getState()
        .addToolCall({ id: "tc2", name: "search", arguments: "{}" });

      // Assert
      expect(useChatStore.getState().toolCalls).toHaveLength(2);
    });
  });

  describe("setToolResult", () => {
    it("should update tool call result and status", () => {
      // Arrange
      useChatStore.getState().addToolCall({
        id: "tc1",
        name: "calculator",
        arguments: '{"expr":"2+2"}',
      });

      // Act
      useChatStore.getState().setToolResult("tc1", "4");

      // Assert
      const tc = useChatStore.getState().toolCalls[0];
      expect(tc.result).toBe("4");
      expect(tc.status).toBe("done");
    });

    it("should not affect other tool calls", () => {
      // Arrange
      useChatStore
        .getState()
        .addToolCall({ id: "tc1", name: "calc", arguments: "{}" });
      useChatStore
        .getState()
        .addToolCall({ id: "tc2", name: "search", arguments: "{}" });

      // Act
      useChatStore.getState().setToolResult("tc1", "result1");

      // Assert
      const tcs = useChatStore.getState().toolCalls;
      expect(tcs[0].status).toBe("done");
      expect(tcs[1].status).toBe("pending");
    });

    it("should not modify state for unknown tool call id", () => {
      // Arrange
      useChatStore
        .getState()
        .addToolCall({ id: "tc1", name: "calc", arguments: "{}" });

      // Act
      useChatStore.getState().setToolResult("unknown", "result");

      // Assert — all tool calls should still be pending
      const tcs = useChatStore.getState().toolCalls;
      expect(tcs).toHaveLength(1);
      expect(tcs[0].status).toBe("pending");
    });
  });

  describe("toggleTool", () => {
    it("should add a tool to enabledTools", () => {
      // Act
      useChatStore.getState().toggleTool("calculator");

      // Assert
      expect(useChatStore.getState().enabledTools).toContain("calculator");
    });

    it("should remove a tool from enabledTools when toggled twice", () => {
      // Act
      useChatStore.getState().toggleTool("calculator");
      useChatStore.getState().toggleTool("calculator");

      // Assert
      expect(useChatStore.getState().enabledTools).not.toContain("calculator");
    });

    it("should support multiple enabled tools", () => {
      // Act
      useChatStore.getState().toggleTool("calculator");
      useChatStore.getState().toggleTool("web_search");

      // Assert
      expect(useChatStore.getState().enabledTools).toEqual([
        "calculator",
        "web_search",
      ]);
    });
  });

  describe("setEnabledTools", () => {
    it("should replace enabled tools list", () => {
      // Arrange
      useChatStore.getState().toggleTool("calc");

      // Act
      useChatStore.getState().setEnabledTools(["search", "read"]);

      // Assert
      expect(useChatStore.getState().enabledTools).toEqual(["search", "read"]);
    });

    it("should clear enabled tools with empty array", () => {
      // Arrange
      useChatStore.getState().toggleTool("calc");

      // Act
      useChatStore.getState().setEnabledTools([]);

      // Assert
      expect(useChatStore.getState().enabledTools).toHaveLength(0);
    });
  });

  describe("resetChat", () => {
    it("should clear messages, debug info, memory info, and tool calls", () => {
      // Arrange
      useChatStore.setState({
        messages: [
          {
            id: "1",
            role: "user",
            content: "Hi",
            conversation_id: "c1",
            created_at: "",
            model: "",
          },
        ],
        debugInfo: {
          model: "gpt-4o",
          provider: "openai",
          system_prompt: "",
          temperature: 0.7,
          max_tokens: 4096,
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          latency_ms: 100,
          first_token_ms: 50,
        },
        memoryInfo: { injected: 2, extracted: 1 },
        toolCalls: [
          { id: "tc1", name: "calc", arguments: "{}", status: "done" as const },
        ],
      });

      // Act
      useChatStore.getState().resetChat();

      // Assert
      const state = useChatStore.getState();
      expect(state.messages).toHaveLength(0);
      expect(state.debugInfo).toBeNull();
      expect(state.memoryInfo).toBeNull();
      expect(state.toolCalls).toHaveLength(0);
    });
  });

  describe("setIsStreaming", () => {
    it("should toggle streaming state", () => {
      expect(useChatStore.getState().isStreaming).toBe(false);

      useChatStore.getState().setIsStreaming(true);
      expect(useChatStore.getState().isStreaming).toBe(true);

      useChatStore.getState().setIsStreaming(false);
      expect(useChatStore.getState().isStreaming).toBe(false);
    });
  });

  describe("appendMessage", () => {
    it("should add a message to the list", () => {
      // Act
      useChatStore.getState().appendMessage({
        id: "m1",
        role: "user",
        content: "Hi",
        conversation_id: "c1",
        created_at: new Date().toISOString(),
        model: "deepseek-chat",
      });

      // Assert
      expect(useChatStore.getState().messages).toHaveLength(1);
      expect(useChatStore.getState().messages[0].content).toBe("Hi");
    });
  });

  describe("panel mode", () => {
    it("should default to debug panel mode", () => {
      expect(useChatStore.getState().panelMode).toBe("debug");
    });

    it("should switch panel modes", () => {
      useChatStore.getState().setPanelMode("memory");
      expect(useChatStore.getState().panelMode).toBe("memory");

      useChatStore.getState().setPanelMode("knowledge");
      expect(useChatStore.getState().panelMode).toBe("knowledge");

      useChatStore.getState().setPanelMode("agent");
      expect(useChatStore.getState().panelMode).toBe("agent");
    });

    it("should toggle debug panel", () => {
      expect(useChatStore.getState().isDebugOpen).toBe(true);

      useChatStore.getState().toggleDebugPanel();
      expect(useChatStore.getState().isDebugOpen).toBe(false);

      useChatStore.getState().toggleDebugPanel();
      expect(useChatStore.getState().isDebugOpen).toBe(true);
    });
  });
});
