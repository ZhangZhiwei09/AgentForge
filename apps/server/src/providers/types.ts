// LLM Provider 抽象接口 —— 定义所有 LLM 厂商必须实现的契约
// 业务层（services）只依赖这个接口，不直接依赖具体实现

// LLM 流式响应的每个片段
export interface StreamChunk {
  type: "token" | "done"; // token = 增量文本，done = 流结束，附带 token 用量
  content?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// 所有 LLM Provider 必须实现此接口
export interface LLMProvider {
  // 流式聊天：接收消息列表 + 系统提示词 → 逐个 yield token 片段
  streamChat(
    messages: Array<{ role: string; content: string }>,
    model: string,
    systemPrompt?: string,
    temperature?: number,
    maxTokens?: number,
  ): AsyncGenerator<StreamChunk>;
  // 返回该厂商支持的模型列表
  listModels(): Array<{ id: string; name: string; provider: string; max_tokens: number }>;
}
