export type ProviderType = "openai" | "deepseek";

export interface ModelInfo {
  id: string;
  name: string;
  provider: ProviderType;
  max_tokens: number;
}

export interface LLMProviderInfo {
  type: ProviderType;
  models: ModelInfo[];
}
