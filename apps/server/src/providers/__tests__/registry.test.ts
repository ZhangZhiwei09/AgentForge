// Provider Registry tests — resolveModel, getProvider, listProviders, firstProvider,
// circuit-breaker wrapping, lazy initialization, and concurrent safety
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mutable state ──────────────────────────────────────
// vi.hoisted ensures these are available when vi.mock factories execute
const hoisted = vi.hoisted(() => {
  // Mutable config that tests can adjust before re-importing the registry module
  const mutableSettings: Record<string, unknown> = {
    openaiApiKey: "sk-test-openai",
    openaiBaseUrl: "https://api.openai.com/v1",
    deepseekApiKey: "sk-test-deepseek",
    deepseekBaseUrl: "https://api.deepseek.com/v1",
    defaultModel: "gpt-4o-mini",
  };

  // Logs for tracking circuit-breaker interactions across tests
  const breakerCallLog: string[] = [];
  const breakerRecordFailureLog: string[] = [];

  // Flags to control whether mock streamChat throws (for circuit-breaker tests)
  let openaiStreamShouldThrow = false;
  let deepseekStreamShouldThrow = false;

  return {
    mutableSettings,
    breakerCallLog,
    breakerRecordFailureLog,
    openaiStreamShouldThrow,
    deepseekStreamShouldThrow,
  };
});

// ── Mock: config.js ────────────────────────────────────────────
vi.mock("../../config.js", () => ({
  settings: hoisted.mutableSettings,
}));

// ── Mock: circuit-breaker.js ───────────────────────────────────
vi.mock("../../lib/circuit-breaker.js", () => {
  class MockCircuitBreakerOpenError extends Error {
    constructor(name: string) {
      super(`Circuit breaker '${name}' is OPEN`);
      this.name = "CircuitBreakerOpenError";
    }
  }

  class MockCircuitBreaker {
    private name: string;
    constructor(name: string, _failureThreshold?: number, _resetTimeoutMs?: number) {
      this.name = name;
    }
    async call<T>(fn: () => Promise<T>): Promise<T> {
      hoisted.breakerCallLog.push(this.name);
      return fn();
    }
    recordFailure(): void {
      hoisted.breakerRecordFailureLog.push(this.name);
    }
    reset(): void {
      // no-op for tests
    }
    getState(): string {
      return "CLOSED";
    }
  }

  return {
    CircuitBreaker: MockCircuitBreaker,
    CircuitBreakerOpenError: MockCircuitBreakerOpenError,
  };
});

// ── Mock: openai.js ────────────────────────────────────────────
vi.mock("../openai.js", () => {
  class MockOpenAIProvider {
    private apiKey: string;
    private baseUrl: string;
    constructor(apiKey: string, baseUrl: string) {
      this.apiKey = apiKey;
      this.baseUrl = baseUrl;
    }
    listModels() {
      return [
        { id: "gpt-4o", name: "GPT-4o", provider: "openai", max_tokens: 128000 },
        { id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "openai", max_tokens: 128000 },
        { id: "gpt-4-turbo", name: "GPT-4 Turbo", provider: "openai", max_tokens: 128000 },
      ];
    }
    async chatSync() {
      return { content: "mock-openai", usage: { prompt_tokens: 10, completion_tokens: 5 } };
    }
    async *streamChat() {
      if (hoisted.openaiStreamShouldThrow) {
        throw new Error("Simulated OpenAI stream error");
      }
      yield {
        type: "done" as const,
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    }
  }
  return { OpenAIProvider: MockOpenAIProvider };
});

// ── Mock: deepseek.js ──────────────────────────────────────────
vi.mock("../deepseek.js", () => {
  class MockDeepSeekProvider {
    private apiKey: string;
    private baseUrl: string;
    constructor(apiKey: string, baseUrl: string) {
      this.apiKey = apiKey;
      this.baseUrl = baseUrl;
    }
    listModels() {
      return [
        { id: "deepseek-chat", name: "DeepSeek Chat", provider: "deepseek", max_tokens: 65536 },
        { id: "deepseek-reasoner", name: "DeepSeek Reasoner", provider: "deepseek", max_tokens: 65536 },
      ];
    }
    async chatSync() {
      return { content: "mock-deepseek", usage: { prompt_tokens: 8, completion_tokens: 4 } };
    }
    async *streamChat() {
      if (hoisted.deepseekStreamShouldThrow) {
        throw new Error("Simulated DeepSeek stream error");
      }
      yield {
        type: "done" as const,
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    }
  }
  return { DeepSeekProvider: MockDeepSeekProvider };
});

// ── Helpers ────────────────────────────────────────────────────

type RegistryExports = typeof import("../registry.js");

/** Import a fresh copy of the registry module (after module cache reset). */
async function importRegistry(): Promise<RegistryExports> {
  return await import("../registry.js");
}

/** Reset all hoisted state to default values before each test. */
function resetHoistedState(): void {
  hoisted.mutableSettings.openaiApiKey = "sk-test-openai";
  hoisted.mutableSettings.openaiBaseUrl = "https://test.openai.com/v1";
  hoisted.mutableSettings.deepseekApiKey = "sk-test-deepseek";
  hoisted.mutableSettings.deepseekBaseUrl = "https://test.deepseek.com/v1";
  hoisted.mutableSettings.defaultModel = "gpt-4o-mini";
  hoisted.openaiStreamShouldThrow = false;
  hoisted.deepseekStreamShouldThrow = false;
  hoisted.breakerCallLog.length = 0;
  hoisted.breakerRecordFailureLog.length = 0;
}

// ── Tests ──────────────────────────────────────────────────────

describe("Provider Registry", () => {
  beforeEach(async () => {
    resetHoistedState();
    // Reset module cache so the registry module re-executes with fresh
    // module-level state (new providers record, new providerBreakers map).
    vi.resetModules();
  });

  // ── resolveModel ───────────────────────────────────────────

  describe("resolveModel", () => {
    it("resolveModel(null) returns default provider + default model", async () => {
      const { resolveModel } = await importRegistry();

      const result = resolveModel(null);

      // defaultModel = "gpt-4o-mini" belongs to OpenAI
      expect(result).toEqual({ providerName: "openai", modelId: "gpt-4o-mini" });
    });

    it('resolveModel("gpt-4o") returns OpenAI provider + gpt-4o', async () => {
      const { resolveModel } = await importRegistry();

      const result = resolveModel("gpt-4o");

      expect(result).toEqual({ providerName: "openai", modelId: "gpt-4o" });
    });

    it('resolveModel("deepseek-chat") returns DeepSeek provider', async () => {
      const { resolveModel } = await importRegistry();

      const result = resolveModel("deepseek-chat");

      expect(result).toEqual({ providerName: "deepseek", modelId: "deepseek-chat" });
    });

    it('resolveModel("nonexistent-model") falls back to first provider\'s first model', async () => {
      const { resolveModel } = await importRegistry();

      const result = resolveModel("nonexistent-model");

      // Fallback: first provider (openai, registered first) → first model (gpt-4o)
      expect(result).toEqual({ providerName: "openai", modelId: "gpt-4o" });
    });

    it("resolveModel(undefined) uses defaultModel", async () => {
      const { resolveModel } = await importRegistry();

      const result = resolveModel(undefined);

      expect(result).toEqual({ providerName: "openai", modelId: "gpt-4o-mini" });
    });

    it("resolveModel() returns { providerName, modelId } structure (ResolvedModel type)", async () => {
      const { resolveModel } = await importRegistry();

      const result = resolveModel("gpt-4o");

      // Verify the structural shape
      expect(result).toHaveProperty("providerName");
      expect(result).toHaveProperty("modelId");
      expect(typeof result.providerName).toBe("string");
      expect(typeof result.modelId).toBe("string");
      expect(Object.keys(result).sort()).toEqual(["modelId", "providerName"]);
    });

    it("resolveModel when no providers are configured throws via firstProvider", async () => {
      // Remove all API keys so no provider is registered
      hoisted.mutableSettings.openaiApiKey = "";
      hoisted.mutableSettings.deepseekApiKey = "";

      const { resolveModel } = await importRegistry();

      // firstProvider() throws "No LLM providers configured"
      // resolveModel calls firstProvider() in the fallback path,
      // and ALSO firstProvider() is called if targetModel not found
      // With no providers, resolveModel will fail at the firstProvider() call
      expect(() => resolveModel("any-model")).toThrow("No LLM providers configured");
    });

    it("resolveModel with empty string modelId uses defaultModel", async () => {
      const { resolveModel } = await importRegistry();

      // Empty string is falsy, so || falls through to defaultModel
      const result = resolveModel("");

      expect(result).toEqual({ providerName: "openai", modelId: "gpt-4o-mini" });
    });

    it("resolveModel finds model in second registered provider", async () => {
      const { resolveModel } = await importRegistry();

      // deepseek-reasoner is in DeepSeek's model list
      const result = resolveModel("deepseek-reasoner");

      expect(result).toEqual({ providerName: "deepseek", modelId: "deepseek-reasoner" });
    });
  });

  // ── getProvider ────────────────────────────────────────────

  describe("getProvider", () => {
    it('getProvider("openai") returns OpenAI provider instance', async () => {
      const { getProvider } = await importRegistry();

      const provider = getProvider("openai");

      expect(provider).toBeDefined();
      expect(typeof provider.listModels).toBe("function");
      expect(typeof provider.chatSync).toBe("function");
      expect(typeof provider.streamChat).toBe("function");
    });

    it('getProvider("deepseek") returns DeepSeek provider instance', async () => {
      const { getProvider } = await importRegistry();

      const provider = getProvider("deepseek");

      expect(provider).toBeDefined();
      expect(typeof provider.listModels).toBe("function");
      const models = provider.listModels();
      expect(models.some((m) => m.id === "deepseek-chat")).toBe(true);
    });

    it('getProvider("nonexistent") throws an error', async () => {
      const { getProvider } = await importRegistry();

      expect(() => getProvider("nonexistent")).toThrow(
        "Provider 'nonexistent' not configured",
      );
    });

    it("getProvider throws when no providers are configured at all", async () => {
      hoisted.mutableSettings.openaiApiKey = "";
      hoisted.mutableSettings.deepseekApiKey = "";

      const { getProvider } = await importRegistry();

      expect(() => getProvider("openai")).toThrow(
        "Provider 'openai' not configured",
      );
    });
  });

  // ── listProviders ─────────────────────────────────────────

  describe("listProviders", () => {
    it("returns all registered providers with their models", async () => {
      const { listProviders } = await importRegistry();

      const result = listProviders();

      expect(result).toHaveLength(2);

      const openai = result.find((p) => p.type === "openai");
      expect(openai).toBeDefined();
      expect(openai!.models.some((m) => m.id === "gpt-4o")).toBe(true);

      const deepseek = result.find((p) => p.type === "deepseek");
      expect(deepseek).toBeDefined();
      expect(deepseek!.models.some((m) => m.id === "deepseek-chat")).toBe(true);
    });

    it("returns correct model shape for every entry", async () => {
      const { listProviders } = await importRegistry();

      for (const entry of listProviders()) {
        expect(typeof entry.type).toBe("string");
        expect(Array.isArray(entry.models)).toBe(true);
        for (const model of entry.models) {
          expect(model).toHaveProperty("id");
          expect(model).toHaveProperty("name");
          expect(model).toHaveProperty("provider");
          expect(model).toHaveProperty("max_tokens");
          expect(typeof model.max_tokens).toBe("number");
        }
      }
    });

    it("returns empty array when no providers are configured", async () => {
      hoisted.mutableSettings.openaiApiKey = "";
      hoisted.mutableSettings.deepseekApiKey = "";

      const { listProviders } = await importRegistry();

      expect(listProviders()).toEqual([]);
    });
  });

  // ── firstProvider ─────────────────────────────────────────

  describe("firstProvider", () => {
    it("returns the name of the first registered provider", async () => {
      const { firstProvider } = await importRegistry();

      // OpenAI is registered first in initProviders()
      expect(firstProvider()).toBe("openai");
    });

    it("throws when no providers are configured", async () => {
      hoisted.mutableSettings.openaiApiKey = "";
      hoisted.mutableSettings.deepseekApiKey = "";

      const { firstProvider } = await importRegistry();

      expect(() => firstProvider()).toThrow("No LLM providers configured");
    });
  });

  // ── Lazy initialization & API key gating ──────────────────

  describe("initialization", () => {
    it("does not register OpenAI when openaiApiKey is empty", async () => {
      hoisted.mutableSettings.openaiApiKey = "";
      // DeepSeek still has a key
      hoisted.mutableSettings.deepseekApiKey = "sk-deepseek";

      const { getProvider, listProviders } = await importRegistry();

      // Only DeepSeek should be registered
      expect(() => getProvider("openai")).toThrow(
        "Provider 'openai' not configured",
      );
      expect(getProvider("deepseek")).toBeDefined();

      const providers = listProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0].type).toBe("deepseek");
    });

    it("does not register DeepSeek when deepseekApiKey is empty", async () => {
      hoisted.mutableSettings.deepseekApiKey = "";
      hoisted.mutableSettings.openaiApiKey = "sk-openai";

      const { getProvider, listProviders } = await importRegistry();

      expect(getProvider("openai")).toBeDefined();
      expect(() => getProvider("deepseek")).toThrow(
        "Provider 'deepseek' not configured",
      );

      const providers = listProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0].type).toBe("openai");
    });

    it("registers neither provider when both API keys are empty", async () => {
      hoisted.mutableSettings.openaiApiKey = "";
      hoisted.mutableSettings.deepseekApiKey = "";

      const { listProviders, firstProvider } = await importRegistry();

      expect(listProviders()).toEqual([]);
      expect(() => firstProvider()).toThrow("No LLM providers configured");
    });

    it("initializes providers lazily on first call", async () => {
      // No explicit init call — the registry initializes on first access
      const { getProvider } = await importRegistry();

      // First call triggers initProviders() internally
      const provider = getProvider("openai");
      expect(provider).toBeDefined();
    });
  });

  // ── Circuit breaker wrapping ──────────────────────────────

  describe("circuit breaker wrapping", () => {
    it("wraps chatSync with circuit breaker call()", async () => {
      const { getProvider } = await importRegistry();

      const provider = getProvider("openai");
      const result = await provider.chatSync(
        [{ role: "user", content: "Hello" }],
        "gpt-4o-mini",
      );

      // The circuit breaker's call() should have been invoked
      expect(hoisted.breakerCallLog.length).toBeGreaterThanOrEqual(1);
      expect(hoisted.breakerCallLog).toContain("llm-openai");
      // chatSync returns the underlying provider's result
      expect(result.content).toBe("mock-openai");
    });

    it("wraps DeepSeek chatSync with its own breaker instance", async () => {
      const { getProvider } = await importRegistry();

      const provider = getProvider("deepseek");
      await provider.chatSync(
        [{ role: "user", content: "Hello" }],
        "deepseek-chat",
      );

      // Each provider gets its own breaker (llm-openai, llm-deepseek)
      expect(hoisted.breakerCallLog).toContain("llm-deepseek");
    });

    it("calls recordFailure when streamChat throws", async () => {
      hoisted.openaiStreamShouldThrow = true;

      const { getProvider } = await importRegistry();

      const provider = getProvider("openai");

      try {
        for await (const _chunk of provider.streamChat(
          [{ role: "user", content: "Hello" }],
          "gpt-4o-mini",
        )) {
          // should not reach here
        }
      } catch (e) {
        // Expected — the error propagates through the wrapper
        expect((e as Error).message).toBe("Simulated OpenAI stream error");
      }

      // breaker.recordFailure() should have been called
      expect(hoisted.breakerRecordFailureLog).toContain("llm-openai");
    });

    it("does NOT call recordFailure when streamChat succeeds", async () => {
      hoisted.openaiStreamShouldThrow = false;

      const { getProvider } = await importRegistry();

      const provider = getProvider("openai");
      for await (const _chunk of provider.streamChat(
        [{ role: "user", content: "Hello" }],
        "gpt-4o-mini",
      )) {
        // Normal streaming
      }

      // No recordFailure should be logged for successful streams
      expect(hoisted.breakerRecordFailureLog).not.toContain("llm-openai");
    });

    it("breaker instances are named per provider", async () => {
      const { getProvider } = await importRegistry();

      // Trigger both breakers
      await getProvider("openai").chatSync(
        [{ role: "user", content: "Hi" }],
        "gpt-4o-mini",
      );
      await getProvider("deepseek").chatSync(
        [{ role: "user", content: "Hi" }],
        "deepseek-chat",
      );

      // Each provider's breaker logs should be distinct
      const uniqueBreakers = [...new Set(hoisted.breakerCallLog)];
      expect(uniqueBreakers).toHaveLength(2);
      expect(uniqueBreakers).toContain("llm-openai");
      expect(uniqueBreakers).toContain("llm-deepseek");
    });
  });

  // ── Caching / instance reuse ──────────────────────────────

  describe("caching", () => {
    it("getProvider returns the same instance on repeated calls", async () => {
      const { getProvider } = await importRegistry();

      const provider1 = getProvider("openai");
      const provider2 = getProvider("openai");

      expect(provider1).toBe(provider2);
    });

    it("getProvider returns different instances for different providers", async () => {
      const { getProvider } = await importRegistry();

      const openai = getProvider("openai");
      const deepseek = getProvider("deepseek");

      expect(openai).not.toBe(deepseek);
    });

    it("resolveModel reuses the same provider after initialization", async () => {
      const { getProvider, resolveModel } = await importRegistry();

      const providerFromGet = getProvider("openai");
      const { providerName } = resolveModel("gpt-4o");
      const providerFromName = getProvider(providerName);

      // resolveModel("gpt-4o") returns providerName "openai",
      // getProvider("openai") should return the same instance both times
      expect(providerFromGet).toBe(providerFromName);
      // Subsequent calls still return the same instance
      expect(getProvider("openai")).toBe(providerFromGet);
    });

    it("listProviders and getProvider share the same instances", async () => {
      const { getProvider, listProviders } = await importRegistry();

      const openaiBefore = getProvider("openai");
      // listProviders should not reinitialize
      const models = listProviders()[0].models;
      const openaiAfter = getProvider("openai");

      expect(openaiBefore).toBe(openaiAfter);
      // Models should match what the openai instance reports
      expect(models.some((m) => m.id === "gpt-4o")).toBe(true);
    });
  });

  // ── Concurrent safety ─────────────────────────────────────

  describe("concurrent initialization", () => {
    it("handles multiple concurrent resolveModel calls without error", async () => {
      const { resolveModel } = await importRegistry();

      const results = await Promise.all([
        Promise.resolve(resolveModel("gpt-4o")),
        Promise.resolve(resolveModel("deepseek-chat")),
        Promise.resolve(resolveModel(null)),
        Promise.resolve(resolveModel("gpt-4o-mini")),
      ]);

      expect(results).toEqual([
        { providerName: "openai", modelId: "gpt-4o" },
        { providerName: "deepseek", modelId: "deepseek-chat" },
        { providerName: "openai", modelId: "gpt-4o-mini" },
        { providerName: "openai", modelId: "gpt-4o-mini" },
      ]);
    });

    it("handles mixed concurrent getProvider / resolveModel / listProviders / firstProvider", async () => {
      const registry = await importRegistry();

      const results = await Promise.all([
        Promise.resolve(registry.getProvider("openai")),
        Promise.resolve(registry.resolveModel("deepseek-chat")),
        Promise.resolve(registry.listProviders()),
        Promise.resolve(registry.firstProvider()),
      ]);

      // All calls should succeed
      expect(results[0]).toBeDefined();
      expect(results[1]).toEqual({ providerName: "deepseek", modelId: "deepseek-chat" });
      expect(results[2].length).toBeGreaterThanOrEqual(2);
      expect(results[3]).toBe("openai");
    });

    it("handles rapid repeated resolveModel calls consistently", async () => {
      const { resolveModel } = await importRegistry();

      // Rapid sequential calls — all should use the same initialized providers
      for (let i = 0; i < 100; i++) {
        expect(resolveModel("gpt-4o")).toEqual({
          providerName: "openai",
          modelId: "gpt-4o",
        });
      }
    });

    it("handles rapid repeated getProvider calls consistently", async () => {
      const { getProvider } = await importRegistry();

      const instances: unknown[] = [];
      for (let i = 0; i < 50; i++) {
        instances.push(getProvider("openai"));
      }

      // All 50 calls returned the exact same instance
      const first = instances[0];
      for (const instance of instances) {
        expect(instance).toBe(first);
      }
    });
  });

  // ── Edge cases ────────────────────────────────────────────

  describe("edge cases", () => {
    it("resolveModel with model from a different provider works correctly", async () => {
      const { resolveModel } = await importRegistry();

      // The default model "gpt-4o-mini" is in OpenAI's list
      const result = resolveModel("gpt-4o-mini");
      expect(result.providerName).toBe("openai");
      expect(result.modelId).toBe("gpt-4o-mini");
    });

    it("resolveModel falls back correctly when defaultModel is not in any provider", async () => {
      hoisted.mutableSettings.defaultModel = "no-such-model";
      const { resolveModel } = await importRegistry();

      // No provider has "no-such-model" → falls back to first provider's first model
      const result = resolveModel(null);

      expect(result).toEqual({ providerName: "openai", modelId: "gpt-4o" });
    });

    it("initProviders is idempotent (calling multiple registry functions does not reinitialize)", async () => {
      const { getProvider, listProviders } = await importRegistry();

      // Trigger initialization
      getProvider("openai");

      // Subsequent calls should not add duplicate entries
      const result = listProviders();
      expect(result).toHaveLength(2); // Only openai and deepseek, no duplicates
    });

    it("getProvider preserves listModels correctness on wrapped provider", async () => {
      const { getProvider } = await importRegistry();

      const openai = getProvider("openai");
      const models = openai.listModels();

      expect(models.some((m) => m.id === "gpt-4o")).toBe(true);
      expect(models.some((m) => m.id === "gpt-4o-mini")).toBe(true);
      expect(models.some((m) => m.id === "gpt-4-turbo")).toBe(true);
    });
  });
});
