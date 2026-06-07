export interface StreamChunk {
  type: "token" | "done";
  content?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface LLMProvider {
  streamChat(
    messages: Array<{ role: string; content: string }>,
    model: string,
    systemPrompt?: string,
    temperature?: number,
    maxTokens?: number,
  ): AsyncGenerator<StreamChunk>;
  listModels(): Array<{ id: string; name: string; provider: string; max_tokens: number }>;
}
