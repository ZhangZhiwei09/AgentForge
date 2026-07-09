// Embedding 服务模块 —— 将文本转换为向量，供 PGVector 语义搜索使用
// 支持：Ollama 本地模型、OpenAI 兼容 API（DashScope/DeepSeek 等）
import OpenAI from "openai";
import { settings } from "../config.js";
import { CircuitBreaker } from "../lib/circuit-breaker.js";

// Embedding Provider 接口 —— 定义文本向量化的契约
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>; // 批量向量化
  embedSingle(text: string): Promise<number[]>; // 单条向量化（便捷方法）
  readonly dimension: number; // 向量维度
  readonly modelName: string; // 使用的模型名称
}

// 根据模型名称确定向量维度
function getEmbeddingDimension(model: string): number {
  // Ollama 常用模型
  if (model === "bge-m3") return 1024;          // BAAI BGE-M3，多语言
  if (model === "nomic-embed-text") return 768; // Nomic Embed
  if (model === "mxbai-embed-large") return 1024;
  // DashScope
  if (model === "text-embedding-v3" || model === "text-embedding-v4") return 1024;
  // OpenAI
  if (model === "text-embedding-3-large") return 3072;
  if (model === "text-embedding-3-small") return 1536;
  if (model === "text-embedding-ada-002") return 1536;
  // 未知模型：保守默认 1024（适配 bge-m3）
  return 1024;
}

// ── Ollama Embedding Provider ──────────────────────────────

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private _model: string;
  private _dimension: number;
  private baseUrl: string;

  constructor(baseUrl: string = "http://localhost:11434", model: string = "bge-m3") {
    this.baseUrl = baseUrl;
    this._model = model;
    this._dimension = getEmbeddingDimension(model);
  }

  get dimension(): number {
    return this._dimension;
  }

  get modelName(): string {
    return this._model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this._model, input: texts }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Ollama embed failed: HTTP ${response.status} ${body.slice(0, 200)}`);
    }

    const data = (await response.json()) as { embeddings?: number[][] };
    if (!data.embeddings || !Array.isArray(data.embeddings)) {
      throw new Error("Ollama embed: unexpected response format");
    }
    return data.embeddings;
  }

  async embedSingle(text: string): Promise<number[]> {
    const results = await this.embed([text]);
    return results[0];
  }
}

// ── OpenAI Embedding Provider ──────────────────────────────

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private client: OpenAI | null = null;
  private _model: string;
  private _dimension: number;

  constructor(
    apiKey: string,
    baseUrl: string = "https://api.openai.com/v1",
    model: string = "text-embedding-ada-002",
  ) {
    this._model = model;
    this._dimension = getEmbeddingDimension(model);
    if (apiKey) {
      this.client = new OpenAI({
        apiKey,
        baseURL: baseUrl,
      });
    }
  }

  get dimension(): number {
    return this._dimension;
  }

  get modelName(): string {
    return this._model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.client) {
      throw new Error("OpenAI client not configured");
    }
    const response = await this.client.embeddings.create({
      model: this._model,
      input: texts,
    });
    const sorted = response.data.sort((a, b) => a.index - b.index);
    return sorted.map((e) => e.embedding);
  }

  async embedSingle(text: string): Promise<number[]> {
    const results = await this.embed([text]);
    return results[0];
  }
}

// ── Provider 注册表 ────────────────────────────────────────

const embeddingProviders: Record<string, EmbeddingProvider> = {};
let embeddingInitialized = false;

// 惰性初始化：注册 Ollama（本地优先）和 OpenAI 兼容 Provider
function initEmbeddingProviders(): void {
  if (embeddingInitialized) return;

  // Ollama 优先 —— 本地免费，无需 API Key
  try {
    embeddingProviders["ollama"] = new OllamaEmbeddingProvider(
      settings.ollamaBaseUrl,
      settings.ollamaEmbeddingModel,
    );
  } catch {
    // Ollama URL 无效时跳过
  }

  // OpenAI 兼容 Provider（DashScope / OpenAI / 自定义代理）
  if (settings.embeddingApiKey) {
    embeddingProviders["openai"] = new OpenAIEmbeddingProvider(
      settings.embeddingApiKey,
      settings.embeddingBaseUrl,
      settings.embeddingModel || "text-embedding-ada-002",
    );
  }

  embeddingInitialized = true;
}

// 熔断器：每个 embedding provider 一个实例
const embeddingBreakers = new Map<string, CircuitBreaker>();

function getEmbeddingBreaker(providerName: string): CircuitBreaker {
  if (!embeddingBreakers.has(providerName)) {
    embeddingBreakers.set(
      providerName,
      new CircuitBreaker(`embedding-${providerName}`, 5, 30_000),
    );
  }
  return embeddingBreakers.get(providerName)!;
}

/** 用熔断器包装 EmbeddingProvider，对 embed/embedSingle 自动熔断保护 */
function wrapEmbeddingWithBreaker(
  name: string,
  p: EmbeddingProvider,
): EmbeddingProvider {
  const breaker = getEmbeddingBreaker(name);
  return {
    ...p,
    embed: (texts: string[]) => breaker.call(() => p.embed(texts)),
    embedSingle: (text: string) => breaker.call(() => p.embedSingle(text)),
  };
}

// 按名称获取 Embedding Provider（自动包装熔断器）
export function getEmbeddingProvider(name: string): EmbeddingProvider {
  initEmbeddingProviders();
  if (!embeddingProviders[name]) {
    throw new Error(
      `Embedding provider '${name}' not found. Available: ${Object.keys(embeddingProviders).join(", ")}`,
    );
  }
  return wrapEmbeddingWithBreaker(name, embeddingProviders[name]);
}

// 获取默认 Embedding Provider —— Ollama 优先（本地免 Key），其次 OpenAI 兼容
export function getDefaultEmbeddingProvider(): EmbeddingProvider | null {
  initEmbeddingProviders();
  if (embeddingProviders["ollama"]) return embeddingProviders["ollama"];
  if (Object.keys(embeddingProviders).length === 0) return null;
  return Object.values(embeddingProviders)[0];
}

export function listEmbeddingProviders(): Array<{
  name: string;
  model: string;
  dimension: number;
}> {
  initEmbeddingProviders();
  return Object.entries(embeddingProviders).map(([name, p]) => ({
    name,
    model: p.modelName,
    dimension: p.dimension,
  }));
}
