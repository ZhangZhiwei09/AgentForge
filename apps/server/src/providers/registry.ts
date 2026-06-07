import type { LLMProvider } from "./types.js";
import { OpenAIProvider } from "./openai.js";
import { DeepSeekProvider } from "./deepseek.js";
import { settings } from "../config.js";

const providers: Record<string, LLMProvider> = {};

function initProviders(): void {
  if (Object.keys(providers).length > 0) return;

  if (settings.openaiApiKey) {
    providers["openai"] = new OpenAIProvider(
      settings.openaiApiKey,
      settings.openaiBaseUrl,
    );
  }
  if (settings.deepseekApiKey) {
    providers["deepseek"] = new DeepSeekProvider(
      settings.deepseekApiKey,
      settings.deepseekBaseUrl,
    );
  }
}

export function getProvider(name: string): LLMProvider {
  initProviders();
  const provider = providers[name];
  if (!provider) {
    throw new Error(`Provider '${name}' not configured`);
  }
  return provider;
}

export function listProviders(): Array<{ type: string; models: Array<{ id: string; name: string; provider: string; max_tokens: number }> }> {
  initProviders();
  const result: Array<{ type: string; models: Array<{ id: string; name: string; provider: string; max_tokens: number }> }> = [];
  for (const [name, p] of Object.entries(providers)) {
    result.push({ type: name, models: p.listModels() });
  }
  return result;
}

export function firstProvider(): string {
  initProviders();
  if (Object.keys(providers).length === 0) {
    throw new Error("No LLM providers configured");
  }
  return Object.keys(providers)[0];
}

export function resolveModel(modelId?: string | null): [string, string] {
  initProviders();

  const targetModel = modelId || settings.defaultModel;

  // Search all providers for the target model
  for (const [name, p] of Object.entries(providers)) {
    for (const m of p.listModels()) {
      if (m.id === targetModel) {
        return [name, targetModel];
      }
    }
  }

  // Model not found — fallback: use first provider's first model
  const first = firstProvider();
  const firstModel = providers[first]?.listModels()[0]?.id || targetModel;
  return [first, firstModel];
}
