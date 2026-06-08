// Provider 注册中心 —— 管理所有 LLM 厂商的实例化和查找
// 支持 OpenAI、DeepSeek，扩展新厂商只需在此注册即可
import type { LLMProvider } from "./types.js";
import { OpenAIProvider } from "./openai.js";
import { DeepSeekProvider } from "./deepseek.js";
import { settings } from "../config.js";

// 所有已配置的 Provider 实例，key 为厂商名称
const providers: Record<string, LLMProvider> = {};

// 惰性初始化：根据 .env 中有无 API Key 决定是否注册该 Provider
function initProviders(): void {
  if (Object.keys(providers).length > 0) return; // 已初始化则跳过

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

// 按名称获取 Provider，未找到则抛错
export function getProvider(name: string): LLMProvider {
  initProviders();
  const provider = providers[name];
  if (!provider) {
    throw new Error(`Provider '${name}' not configured`);
  }
  return provider;
}

// 列出所有可用 Provider 及其支持的模型（给前端 /api/providers 用）
export function listProviders(): Array<{ type: string; models: Array<{ id: string; name: string; provider: string; max_tokens: number }> }> {
  initProviders();
  const result: Array<{ type: string; models: Array<{ id: string; name: string; provider: string; max_tokens: number }> }> = [];
  for (const [name, p] of Object.entries(providers)) {
    result.push({ type: name, models: p.listModels() });
  }
  return result;
}

// 返回第一个可用 Provider 的名称
export function firstProvider(): string {
  initProviders();
  if (Object.keys(providers).length === 0) {
    throw new Error("No LLM providers configured");
  }
  return Object.keys(providers)[0];
}

// 模型解析逻辑：给定一个 modelId，找到它属于哪个 Provider
// 如果没传 modelId，用 defaultModel；如果找不到匹配，回退到第一个 Provider 的第一个模型
export function resolveModel(modelId?: string | null): [string, string] {
  initProviders();

  const targetModel = modelId || settings.defaultModel;

  // 在所有 Provider 的模型列表中搜索目标模型
  for (const [name, p] of Object.entries(providers)) {
    for (const m of p.listModels()) {
      if (m.id === targetModel) {
        return [name, targetModel]; // 返回 [provider名称, 模型ID]
      }
    }
  }

  // 模型未找到 —— 兜底：用第一个 Provider 的第一个模型
  const first = firstProvider();
  const firstModel = providers[first]?.listModels()[0]?.id || targetModel;
  return [first, firstModel];
}
