// DeepSeekProvider tests — streamChat chunks, tool_call accumulation, chatSync with jsonMode
import { describe, it, expect, vi } from "vitest";
import { DeepSeekProvider } from "../deepseek.js";
import type { StreamChunk } from "../types.js";

// Mock OpenAI SDK (DeepSeek uses OpenAI-compatible SDK with different baseUrl)
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

function createProvider(): DeepSeekProvider {
  return new DeepSeekProvider("test-api-key");
}

async function collectStream(
  gen: AsyncGenerator<StreamChunk>,
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("DeepSeekProvider", () => {
  describe("listModels", () => {
    it("should return DeepSeek models", () => {
      const provider = createProvider();
      const models = provider.listModels();

      expect(models.some((m) => m.id === "deepseek-chat")).toBe(true);
      expect(models.some((m) => m.id === "deepseek-reasoner")).toBe(true);
    });

    it("should return models with correct shape", () => {
      const provider = createProvider();
      for (const model of provider.listModels()) {
        expect(model).toHaveProperty("id");
        expect(model).toHaveProperty("name");
        expect(model).toHaveProperty("provider", "deepseek");
        expect(model).toHaveProperty("max_tokens");
      }
    });
  });

  describe("chatSync", () => {
    it("should return content and usage", async () => {
      const provider = createProvider();
      const mockClient = (provider as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).client;
      mockClient.chat.completions.create.mockResolvedValueOnce({
        choices: [{ message: { content: "response", role: "assistant" } }],
        usage: { prompt_tokens: 20, completion_tokens: 10 },
      });

      const result = await provider.chatSync(
        [{ role: "user", content: "Hello" }],
        "deepseek-chat",
      );

      expect(result.content).toBe("response");
      expect(result.usage.prompt_tokens).toBe(20);
      expect(result.usage.completion_tokens).toBe(10);
    });

    it("should append JSON instruction to system prompt in jsonMode", async () => {
      const provider = createProvider();
      const mockClient = (provider as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).client;
      mockClient.chat.completions.create.mockResolvedValueOnce({
        choices: [{ message: { content: "[]" } }],
        usage: { prompt_tokens: 15, completion_tokens: 3 },
      });

      await provider.chatSync(
        [{ role: "user", content: "Extract memories" }],
        "deepseek-chat",
        "You are a memory extractor.",
        0.1,
        500,
        true, // jsonMode
      );

      const callArgs = mockClient.chat.completions.create.mock.calls[0][0];
      expect(callArgs.messages[0].role).toBe("system");
      expect(callArgs.messages[0].content).toContain("You are a memory extractor.");
      expect(callArgs.messages[0].content).toContain("valid JSON object");
      expect(callArgs.messages[0].content).toContain("No markdown");
    });

    it("should NOT append JSON instruction when jsonMode is false", async () => {
      const provider = createProvider();
      const mockClient = (provider as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).client;
      mockClient.chat.completions.create.mockResolvedValueOnce({
        choices: [{ message: { content: "normal" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

      await provider.chatSync(
        [{ role: "user", content: "Hi" }],
        "deepseek-chat",
        "You are a bot.",
        0.7,
        100,
        false,
      );

      const callArgs = mockClient.chat.completions.create.mock.calls[0][0];
      expect(callArgs.messages[0].content).toBe("You are a bot.");
      expect(callArgs.messages[0].content).not.toContain("valid JSON object");
    });

    it("should handle empty result gracefully", async () => {
      const provider = createProvider();
      const mockClient = (provider as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).client;
      mockClient.chat.completions.create.mockResolvedValueOnce({
        choices: [{ message: { content: null } }],
        usage: { prompt_tokens: 5, completion_tokens: 0 },
      });

      const result = await provider.chatSync(
        [{ role: "user", content: "." }],
        "deepseek-chat",
      );

      expect(result.content).toBe("");
    });
  });

  describe("streamChat", () => {
    it("should yield token chunks", async () => {
      const provider = createProvider();
      const mockClient = (provider as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).client;

      mockClient.chat.completions.create.mockResolvedValueOnce(
        (async function* () {
          yield { choices: [{ delta: { content: "DeepSeek" } }], usage: null };
          yield { choices: [{ delta: { content: " response" } }], usage: null };
          yield { choices: [{ delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 2 } };
        })(),
      );

      const chunks = await collectStream(
        provider.streamChat([{ role: "user", content: "Test" }], "deepseek-chat"),
      );

      const tokens = chunks.filter((c) => c.type === "token");
      expect(tokens).toHaveLength(2);
      expect(tokens[0].content).toBe("DeepSeek");
      expect(tokens[1].content).toBe(" response");

      const done = chunks.find((c) => c.type === "done");
      expect(done).toBeDefined();
      expect(done!.usage?.total_tokens).toBe(10);
    });

    it("should yield done event with zero usage on empty stream", async () => {
      const provider = createProvider();
      const mockClient = (provider as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).client;

      mockClient.chat.completions.create.mockResolvedValueOnce(
        (async function* () {
          yield { choices: [{ delta: {} }], usage: null };
        })(),
      );

      const chunks = await collectStream(
        provider.streamChat([{ role: "user", content: "." }], "deepseek-chat"),
      );

      const done = chunks.find((c) => c.type === "done");
      expect(done).toBeDefined();
    });

    it("should accumulate tool calls across fragments", async () => {
      const provider = createProvider();
      const mockClient = (provider as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).client;

      mockClient.chat.completions.create.mockResolvedValueOnce(
        (async function* () {
          yield {
            choices: [{
              delta: {
                tool_calls: [
                  { index: 0, id: "deepseek_tc_1", function: { name: "web", arguments: '{"q"' } },
                ],
              },
            }],
            usage: null,
          };
          yield {
            choices: [{
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: ':"weather"}' } },
                ],
              },
            }],
            usage: null,
          };
          yield { choices: [{ delta: {} }], usage: { prompt_tokens: 12, completion_tokens: 4 } };
        })(),
      );

      const chunks = await collectStream(
        provider.streamChat(
          [{ role: "user", content: "What's the weather?" }],
          "deepseek-chat",
          "",
          undefined,
          undefined,
          [{ type: "function", function: { name: "web_search", description: "", parameters: { type: "object", properties: {} } } }],
        ),
      );

      const toolCalls = chunks.filter((c) => c.type === "tool_call");
      expect(toolCalls.length).toBeGreaterThanOrEqual(1);
      expect(toolCalls[0].tool_call?.name).toBe("web");
      expect(toolCalls[0].tool_call?.arguments).toContain("weather");
    });

    it("should pass tools to the API when provided", async () => {
      const provider = createProvider();
      const mockClient = (provider as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).client;

      mockClient.chat.completions.create.mockResolvedValueOnce(
        (async function* () {
          yield { choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 0 } };
        })(),
      );

      const tools = [
        { type: "function" as const, function: { name: "search", description: "Search", parameters: { type: "object" as const, properties: {} } } },
      ];

      await collectStream(
        provider.streamChat(
          [{ role: "user", content: "Search" }],
          "deepseek-chat",
          "",
          undefined,
          undefined,
          tools,
        ),
      );

      const callArgs = mockClient.chat.completions.create.mock.calls[0][0];
      expect(callArgs.tools).toEqual(tools);
    });

    it("should set stream: true in API call", async () => {
      const provider = createProvider();
      const mockClient = (provider as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).client;

      mockClient.chat.completions.create.mockResolvedValueOnce(
        (async function* () {
          yield { choices: [{ delta: { content: "x" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } };
        })(),
      );

      await collectStream(
        provider.streamChat([{ role: "user", content: "x" }], "deepseek-chat"),
      );

      const callArgs = mockClient.chat.completions.create.mock.calls[0][0];
      expect(callArgs.stream).toBe(true);
    });
  });

  describe("tool_call message conversion", () => {
    it("should convert tool_calls and tool_call_id in messages", async () => {
      const provider = createProvider();
      const mockClient = (provider as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).client;

      mockClient.chat.completions.create.mockResolvedValueOnce(
        (async function* () {
          yield { choices: [{ delta: { content: "Done" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } };
        })(),
      );

      await collectStream(
        provider.streamChat([
          { role: "user", content: "Calculate 2+2" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "tc1", type: "function",
              function: { name: "calculator", arguments: '{"expr":"2+2"}' },
            }],
          },
          { role: "tool", tool_call_id: "tc1", content: "4" },
        ], "deepseek-chat"),
      );

      const callArgs = mockClient.chat.completions.create.mock.calls[0][0];
      // Should have tool_call_id on the tool message
      const toolMsg = callArgs.messages.find((m: any) => m.role === "tool");
      expect(toolMsg).toBeDefined();
      expect(toolMsg.tool_call_id).toBe("tc1");
      expect(toolMsg.content).toBe("4");
    });
  });
});
