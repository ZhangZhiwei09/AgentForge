// Embedding 服务模块 —— 将文本转换为向量，供 Milvus 语义搜索使用
// 目前只支持 OpenAI Embedding API，未来可扩展本地模型或其他厂商
import OpenAI from "openai";
import { settings } from "../config.js";

// Embedding Provider 接口 —— 定义文本向量化的契约
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>; // 批量向量化
  embedSingle(text: string): Promise<number[]>; // 单条向量化（便捷方法）
  readonly dimension: number; // 向量维度
  readonly modelName: string; // 使用的模型名称
}

// 根据模型名称确定向量维度
function getEmbeddingDimension(model: string): number {
  // DashScope text-embedding-v3 → 1024
  if (model === "text-embedding-v3" || model === "text-embedding-v4") return 1024;
  // OpenAI text-embedding-3-large → 3072（默认）或 1024/256
  if (model === "text-embedding-3-large") return 3072;
  // OpenAI text-embedding-3-small → 1536（默认）或 512
  if (model === "text-embedding-3-small") return 1536;
  // OpenAI text-embedding-ada-002 → 1536
  if (model === "text-embedding-ada-002") return 1536;
  // 未知模型：保守默认 1536
  return 1536;
}

// OpenAI Embedding 实现
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
    // 根据模型名称确定向量维度
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

  // 批量 embedding：一次 API 调用处理多条文本，比逐条调用效率高
  async embed(texts: string[]): Promise<number[][]> {
    if (!this.client) {
      throw new Error("OpenAI client not configured");
    }
    const response = await this.client.embeddings.create({
      model: this._model,
      input: texts,
    });
    // 按 index 排序确保顺序与输入一致
    const sorted = response.data.sort((a, b) => a.index - b.index);
    return sorted.map((e) => e.embedding);
  }

  async embedSingle(text: string): Promise<number[]> {
    const results = await this.embed([text]);
    return results[0];
  }
}

// ── Provider 注册表 ──────────────────────────────────

const embeddingProviders: Record<string, EmbeddingProvider> = {};
let embeddingInitialized = false;

// 惰性初始化：根据 settings 注册可用的 Embedding Provider
function initEmbeddingProviders(): void {
  if (embeddingInitialized) return;

  if (settings.openaiApiKey) {
    embeddingProviders["openai"] = new OpenAIEmbeddingProvider(
      settings.openaiApiKey,
      settings.openaiBaseUrl,
      settings.embeddingModel || "text-embedding-ada-002",
    );
  }
  embeddingInitialized = true;
}

// 按名称获取 Embedding Provider
export function getEmbeddingProvider(name: string): EmbeddingProvider {
  initEmbeddingProviders();
  if (!embeddingProviders[name]) {
    throw new Error(
      `Embedding provider '${name}' not found. Available: ${Object.keys(embeddingProviders).join(", ")}`,
    );
  }
  return embeddingProviders[name];
}

// 获取默认 Embedding Provider（有且仅有一个时的便利方法）
export function getDefaultEmbeddingProvider(): EmbeddingProvider | null {
  initEmbeddingProviders();
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
