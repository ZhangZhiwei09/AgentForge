// Provider 注册中心 —— 管理所有 LLM 厂商的实例化和查找
// 支持 OpenAI、DeepSeek，扩展新厂商只需在此注册即可
import type { LLMProvider } from "./types.js";
import { OpenAIProvider } from "./openai.js";
import { DeepSeekProvider } from "./deepseek.js";
import { settings } from "../config.js";
import { CircuitBreaker } from "../lib/circuit-breaker.js";

// 所有已配置的 Provider 实例，key 为厂商名称
const providers: Record<string, LLMProvider> = {};

// 熔断器：每个 Provider 一个实例，独立计数
const providerBreakers = new Map<string, CircuitBreaker>();

function getBreaker(providerName: string): CircuitBreaker {
  if (!providerBreakers.has(providerName)) {
    providerBreakers.set(
      providerName,
      new CircuitBreaker(`llm-${providerName}`, 5, 30_000),
    );
  }
  return providerBreakers.get(providerName)!;
}

/** 用熔断器包装 LLMProvider，对 chatSync/streamChat 调用自动熔断保护 */
function wrapWithCircuitBreaker(
  name: string,
  provider: LLMProvider,
): LLMProvider {
  const breaker = getBreaker(name);
  const originalChatSync = provider.chatSync.bind(provider);
  const originalStreamChat = provider.streamChat.bind(provider);

  return {
    // 显式绑定原型方法：spread 操作符不会拷贝 class 原型上的方法
    listModels: provider.listModels.bind(provider),
    chatSync: async (...args: Parameters<LLMProvider["chatSync"]>) =>
      breaker.call(() => originalChatSync(...args)),
    streamChat: async function* (
      ...args: Parameters<LLMProvider["streamChat"]>
    ) {
      try {
        yield* originalStreamChat(...args);
      } catch (e) {
        // 流内错误通知熔断器（chatSync 有 call() 包装，streamChat 手动记录）
        breaker.recordFailure();
        throw e;
      }
    },
  };
}

// 惰性初始化：根据 .env 中有无 API Key 决定是否注册该 Provider
function initProviders(): void {
  if (Object.keys(providers).length > 0) return; // 已初始化则跳过

  if (settings.openaiApiKey) {
    const raw = new OpenAIProvider(
      settings.openaiApiKey,
      settings.openaiBaseUrl,
    );
    providers["openai"] = wrapWithCircuitBreaker("openai", raw);
  }
  if (settings.deepseekApiKey) {
    const raw = new DeepSeekProvider(
      settings.deepseekApiKey,
      settings.deepseekBaseUrl,
    );
    providers["deepseek"] = wrapWithCircuitBreaker("deepseek", raw);
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
export function listProviders(): Array<{
  type: string;
  models: Array<{
    id: string;
    name: string;
    provider: string;
    max_tokens: number;
  }>;
}> {
  initProviders();
  const result: Array<{
    type: string;
    models: Array<{
      id: string;
      name: string;
      provider: string;
      max_tokens: number;
    }>;
  }> = [];
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
