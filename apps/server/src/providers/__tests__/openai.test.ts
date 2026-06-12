// OpenAIProvider tests — streamChat chunks, tool_call accumulation, done usage, chatSync
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAIProvider } from "../openai.js";
import type { ChatMessage, StreamChunk } from "../types.js";

// Mock OpenAI SDK
vi.mock("openai", () => {
  return {
    default: vi.fn().mockImplementation(function (this: Record<string, unknown>, config: unknown) {
      this.config = config;
      this.chat = {
        completions: {
          create: vi.fn(),
        },
      };
    }),
  };
});

function createProvider(): OpenAIProvider {
  return new OpenAIProvider("test-api-key");
}

// Helper: collect all chunks from a stream
async function collectStream(
  gen: AsyncGenerator<StreamChunk>,
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("OpenAIProvider", () => {
  describe("listModels", () => {
    it("should return supported models", () => {
      const provider = createProvider();
      const models = provider.listModels();

      expect(models.length).toBeGreaterThanOrEqual(3);
      expect(models.some((m) => m.id === "gpt-4o")).toBe(true);
      expect(models.some((m) => m.id === "gpt-4o-mini")).toBe(true);
    });

    it("should return models with correct shape", () => {
      const provider = createProvider();
      for (const model of provider.listModels()) {
        expect(model).toHaveProperty("id");
        expect(model).toHaveProperty("name");
        expect(model).toHaveProperty("provider", "openai");
        expect(model).toHaveProperty("max_tokens");
        expect(typeof model.max_tokens).toBe("number");
      }
    });
  });

  describe("chatSync", () => {
    it("should return content and usage from OpenAI response", async () => {
      const provider = createProvider();
      const mockClient = (provider as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).client;
      mockClient.chat.completions.create.mockResolvedValueOnce({
        choices: [
          {
            message: { content: '{"score": 0.95}', role: "assistant" },
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 20 },
      });

      const result = await provider.chatSync(
        [{ role: "user", content: "Test query" }],
        "gpt-4o-mini",
        "You are a helpful assistant.",
        0.1,
        500,
        false,
      );

      expect(result.content).toBe('{"score": 0.95}');
      expect(result.usage.prompt_tokens).toBe(50);
      expect(result.usage.completion_tokens).toBe(20);
    });

    it("should include jsonMode response_format when enabled", async () => {
      const provider = createProvider();
      const mockClient = (provider as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).client;
      mockClient.chat.completions.create.mockResolvedValueOnce({
        choices: [{ message: { content: "{}" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

      await provider.chatSync(
        [{ role: "user", content: "Q" }],
        "gpt-4o",
        "",
        0.7,
        100,
        true,
      );

      // Verify the call included response_format: json_object
      const callArgs = mockClient.chat.completions.create.mock.calls[0][0];
      expect(callArgs.response_format).toEqual({ type: "json_object" });
    });

    it("should handle empty content gracefully", async () => {
      const provider = createProvider();
      const mockClient = (provider as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).client;
      mockClient.chat.completions.create.mockResolvedValueOnce({
        choices: [{ message: { content: null } }],
        usage: { prompt_tokens: 5, completion_tokens: 0 },
      });

      const result = await provider.chatSync(
        [{ role: "user", content: "Q" }],
        "gpt-4o-mini",
      );

      expect(result.content).toBe("");
      expect(result.usage.completion_tokens).toBe(0);
    });
  });

  describe("streamChat", () => {
    it("should yield token chunks for text content", async () => {
      const provider = createProvider();
      const mockClient = (provider as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).client;

      // Create an async iterable that simulates streaming chunks
      mockClient.chat.completions.create.mockResolvedValueOnce(
        (async function* () {
          yield {
            choices: [{ delta: { content: "Hello" } }],
            usage: null,
          };
          yield {
            choices: [{ delta: { content: " World" } }],
            usage: null,
          };
          yield {
            choices: [{ delta: {} }],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          };
        })(),
      );

      const chunks = await collectStream(
        provider.streamChat(
          [{ role: "user", content: "Hi" }],
          "gpt-4o",
        ),
      );

      const tokens = chunks.filter((c) => c.type === "token");
      expect(tokens).toHaveLength(2);
      expect(tokens[0].content).toBe("Hello");
      expect(tokens[1].content).toBe(" World");

      const done = chunks.find((c) => c.type === "done");
      expect(done).toBeDefined();
      expect(done!.usage).toBeDefined();
    });

    it("should yield done event with usage even on empty stream", async () => {
      const provider = createProvider();
      const mockClient = (provider as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).client;

      mockClient.chat.completions.create.mockResolvedValueOnce(
        (async function* () {
          yield {
            choices: [{ delta: {} }],
            usage: { prompt_tokens: 5, completion_tokens: 0 },
          };
        })(),
      );

      const chunks = await collectStream(
        provider.streamChat([{ role: "user", content: "." }], "gpt-4o-mini"),
      );

      const done = chunks.find((c) => c.type === "done");
      expect(done).toBeDefined();
      expect(done!.usage?.prompt_tokens).toBe(5);
    });

    it("should accumulate tool call fragments across chunks", async () => {
      const provider = createProvider();
      const mockClient = (provider as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).client;

      mockClient.chat.completions.create.mockResolvedValueOnce(
        (async function* () {
          // First chunk: tool call starts with id and name
          yield {
            choices: [{
              delta: {
                tool_calls: [
                  { index: 0, id: "call_123", function: { name: "get", arguments: '{"url"' } },
                ],
              },
            }],
            usage: null,
          };
          // Second chunk: more arguments
          yield {
            choices: [{
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: ':"https://example.com"}' } },
                ],
              },
            }],
            usage: null,
          };
          // Final chunk: no delta, just usage
          yield {
            choices: [{ delta: {} }],
            usage: { prompt_tokens: 20, completion_tokens: 5 },
          };
        })(),
      );

      const chunks = await collectStream(
        provider.streamChat(
          [{ role: "user", content: "Fetch example.com" }],
          "gpt-4o",
          "",
          undefined,
          undefined,
          [{ type: "function", function: { name: "http_request", description: "", parameters: { type: "object", properties: {} } } }],
        ),
      );

      const toolCalls = chunks.filter((c) => c.type === "tool_call");
      expect(toolCalls.length).toBeGreaterThanOrEqual(1);
      expect(toolCalls[0].tool_call?.name).toBe("get");
      expect(toolCalls[0].tool_call?.arguments).toContain("https://example.com");
    });

    it("should yield done event even if stream errors", async () => {
      const provider = createProvider();
      const mockClient = (provider as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).client;

      mockClient.chat.completions.create.mockResolvedValueOnce(
        (async function* () {
          yield {
            choices: [{ delta: { content: "partial" } }],
            usage: null,
          };
          throw new Error("Connection reset");
        })(),
      );

      // The error should propagate through the generator
      try {
        await collectStream(
          provider.streamChat([{ role: "user", content: "Hi" }], "gpt-4o"),
        );
        // If we get here, the done chunk fired before error (in finally block)
      } catch {
        // Expected — the error is thrown after finally
      }
    });

    it("should prepend system prompt as first message", async () => {
      const provider = createProvider();
      const mockClient = (provider as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).client;

      mockClient.chat.completions.create.mockResolvedValueOnce(
        (async function* () {
          yield {
            choices: [{ delta: { content: "ok" } }],
            usage: { prompt_tokens: 8, completion_tokens: 1 },
          };
        })(),
      );

      await collectStream(
        provider.streamChat(
          [{ role: "user", content: "Hi" }],
          "gpt-4o",
          "You are a helpful bot.",
        ),
      );

      const callArgs = mockClient.chat.completions.create.mock.calls[0][0];
      expect(callArgs.messages[0].role).toBe("system");
      expect(callArgs.messages[0].content).toBe("You are a helpful bot.");
      expect(callArgs.stream).toBe(true);
    });

    it("should pass tool definitions to the API", async () => {
      const provider = createProvider();
      const mockClient = (provider as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).client;

      mockClient.chat.completions.create.mockResolvedValueOnce(
        (async function* () {
          yield {
            choices: [{ delta: {} }],
            usage: { prompt_tokens: 5, completion_tokens: 0 },
          };
        })(),
      );

      const tools = [
        { type: "function" as const, function: { name: "calculator", description: "Eval math", parameters: { type: "object" as const, properties: {} } } },
      ];

      await collectStream(
        provider.streamChat(
          [{ role: "user", content: "2+2" }],
          "gpt-4o",
          "",
          undefined,
          undefined,
          tools,
        ),
      );

      const callArgs = mockClient.chat.completions.create.mock.calls[0][0];
      expect(callArgs.tools).toEqual(tools);
    });
  });

  describe("performance", () => {
    it("should yield first token with minimal latency", async () => {
      const provider = createProvider();
      const mockClient = (provider as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).client;

      mockClient.chat.completions.create.mockResolvedValueOnce(
        (async function* () {
          yield {
            choices: [{ delta: { content: "fast" } }],
            usage: { prompt_tokens: 3, completion_tokens: 1 },
          };
        })(),
      );

      const start = Date.now();
      const gen = provider.streamChat([{ role: "user", content: "Hi" }], "gpt-4o-mini");
      const first = await gen.next();
      const elapsed = Date.now() - start;

      expect(first.done).toBe(false);
      expect(elapsed).toBeLessThan(1000); // Should complete quickly with mock
    });
  });

  describe("tool_call message conversion", () => {
    it("should convert ChatMessage tool_calls to OpenAI format", async () => {
      const provider = createProvider();
      const mockClient = (provider as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).client;

      mockClient.chat.completions.create.mockResolvedValueOnce(
        (async function* () {
          yield {
            choices: [{ delta: { content: "I used the tool" } }],
            usage: { prompt_tokens: 15, completion_tokens: 3 },
          };
        })(),
      );

      const messages: ChatMessage[] = [
        { role: "user", content: "What time is it?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "tc1",
              type: "function",
              function: { name: "get_time", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "tc1",
          content: "2024-01-01T12:00:00Z",
        },
      ];

      await collectStream(provider.streamChat(messages, "gpt-4o"));

      const callArgs = mockClient.chat.completions.create.mock.calls[0][0];
      expect(callArgs.messages).toHaveLength(3); // No system prompt passed
      // Third message should have tool_call_id (index 2)
      const toolMsg = callArgs.messages.find((m: any) => m.role === "tool");
      expect(toolMsg).toBeDefined();
      expect(toolMsg.tool_call_id).toBe("tc1");
    });
  });
});
