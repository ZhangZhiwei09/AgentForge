import OpenAI from "openai";
import { settings } from "../config.js";

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  embedSingle(text: string): Promise<number[]>;
  readonly dimension: number;
  readonly modelName: string;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private client: OpenAI | null = null;
  private _model: string;

  constructor(apiKey: string, baseUrl: string = "https://api.openai.com/v1", model: string = "text-embedding-ada-002") {
    this._model = model;
    if (apiKey) {
      this.client = new OpenAI({
        apiKey,
        baseURL: baseUrl,
      });
    }
  }

  get dimension(): number {
    return 1536;
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

// Embedding provider registry
const embeddingProviders: Record<string, EmbeddingProvider> = {};
let embeddingInitialized = false;

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

export function getEmbeddingProvider(name: string): EmbeddingProvider {
  initEmbeddingProviders();
  if (!embeddingProviders[name]) {
    throw new Error(`Embedding provider '${name}' not found. Available: ${Object.keys(embeddingProviders).join(", ")}`);
  }
  return embeddingProviders[name];
}

export function getDefaultEmbeddingProvider(): EmbeddingProvider | null {
  initEmbeddingProviders();
  if (Object.keys(embeddingProviders).length === 0) return null;
  return Object.values(embeddingProviders)[0];
}

export function listEmbeddingProviders(): Array<{ name: string; model: string; dimension: number }> {
  initEmbeddingProviders();
  return Object.entries(embeddingProviders).map(([name, p]) => ({
    name,
    model: p.modelName,
    dimension: p.dimension,
  }));
}
