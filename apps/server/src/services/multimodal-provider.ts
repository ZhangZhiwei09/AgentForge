// Multimodal LLM Provider — extends OpenAI-compatible providers with vision support
// Enables sending images (video frames) alongside text to vision-capable models
import OpenAI from "openai";
import { settings } from "../config.js";
import { logger } from "@agentforge/logger";
import type { ToolDefinition } from "@agentforge/shared-types";

// ---- Types ----

export interface ImageContent {
  type: "image_url";
  image_url: {
    url: string; // data:image/jpeg;base64,... or https://...
    detail?: "low" | "high" | "auto";
  };
}

export interface TextContent {
  type: "text";
  text: string;
}

export type MultimodalContent = TextContent | ImageContent;

export interface MultimodalMessage {
  role: "user" | "assistant" | "system";
  content: string | MultimodalContent[];
}

export interface MultimodalStreamChunk {
  type: "token" | "done" | "error";
  content?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface MultimodalSyncResult {
  content: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

// ---- Multimodal Provider Interface ----

export interface MultimodalLLMProvider {
  streamChat(
    messages: MultimodalMessage[],
    model: string,
    systemPrompt?: string,
    temperature?: number,
    maxTokens?: number,
    tools?: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<MultimodalStreamChunk>;

  chatSync(
    messages: MultimodalMessage[],
    model: string,
    systemPrompt?: string,
    temperature?: number,
    maxTokens?: number,
  ): Promise<MultimodalSyncResult>;

  readonly providerName: string;
  listModels(): Array<{
    id: string;
    name: string;
    provider: string;
    max_tokens: number;
    supportsVision: boolean;
  }>;
}

// ---- OpenAI Multimodal Provider ----

class OpenAIMultimodalProvider implements MultimodalLLMProvider {
  private client: OpenAI;

  constructor(apiKey: string, baseUrl: string = "https://api.openai.com/v1") {
    this.client = new OpenAI({ apiKey, baseURL: baseUrl });
  }

  get providerName(): string {
    return "openai-multimodal";
  }

  listModels() {
    return [
      {
        id: "gpt-4o",
        name: "GPT-4o",
        provider: "openai",
        max_tokens: 128000,
        supportsVision: true,
      },
      {
        id: "gpt-4o-mini",
        name: "GPT-4o Mini",
        provider: "openai",
        max_tokens: 128000,
        supportsVision: true,
      },
      {
        id: "gpt-4-turbo",
        name: "GPT-4 Turbo",
        provider: "openai",
        max_tokens: 128000,
        supportsVision: true,
      },
    ];
  }

  async *streamChat(
    messages: MultimodalMessage[],
    model: string,
    systemPrompt?: string,
    temperature: number = 0.7,
    maxTokens?: number,
    tools?: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<MultimodalStreamChunk> {
    const formattedMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    // System prompt
    if (systemPrompt) {
      formattedMessages.push({ role: "system", content: systemPrompt });
    }

    // Convert multimodal messages to OpenAI format
    for (const msg of messages) {
      if (typeof msg.content === "string") {
        formattedMessages.push({
          role: msg.role as "user" | "assistant",
          content: msg.content,
        });
      } else {
        // Multimodal content array (text + images)
        const parts: OpenAI.Chat.ChatCompletionContentPart[] = [];
        for (const part of msg.content) {
          if (part.type === "text") {
            parts.push({ type: "text", text: part.text });
          } else if (part.type === "image_url") {
            parts.push({
              type: "image_url",
              image_url: {
                url: part.image_url.url,
                detail: part.image_url.detail || "auto",
              },
            });
          }
        }
        formattedMessages.push({
          role: msg.role as "user",
          content: parts,
        });
      }
    }

    // OpenAI tool format conversion
    const openaiTools = tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters as unknown as Record<string, unknown>,
      },
    }));

    const stream = await this.client.chat.completions.create({
      model,
      messages: formattedMessages,
      temperature,
      max_tokens: maxTokens || undefined,
      tools: openaiTools?.length ? openaiTools : undefined,
      stream: true,
    });

    let totalPrompt = 0;
    let totalCompletion = 0;

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;

      if (delta?.content) {
        yield { type: "token", content: delta.content };
      }

      if (chunk.usage) {
        totalPrompt = chunk.usage.prompt_tokens || 0;
        totalCompletion = chunk.usage.completion_tokens || 0;
      }
    }

    yield {
      type: "done",
      usage: {
        prompt_tokens: totalPrompt,
        completion_tokens: totalCompletion,
        total_tokens: totalPrompt + totalCompletion,
      },
    };
  }

  async chatSync(
    messages: MultimodalMessage[],
    model: string,
    systemPrompt?: string,
    temperature: number = 0.7,
    maxTokens?: number,
  ): Promise<MultimodalSyncResult> {
    const formattedMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    if (systemPrompt) {
      formattedMessages.push({ role: "system", content: systemPrompt });
    }

    for (const msg of messages) {
      if (typeof msg.content === "string") {
        formattedMessages.push({
          role: msg.role as "user" | "assistant",
          content: msg.content,
        });
      } else {
        const parts: OpenAI.Chat.ChatCompletionContentPart[] = [];
        for (const part of msg.content) {
          if (part.type === "text") {
            parts.push({ type: "text", text: part.text });
          } else if (part.type === "image_url") {
            parts.push({
              type: "image_url",
              image_url: {
                url: part.image_url.url,
                detail: part.image_url.detail || "auto",
              },
            });
          }
        }
        formattedMessages.push({
          role: msg.role as "user",
          content: parts,
        });
      }
    }

    const response = await this.client.chat.completions.create({
      model,
      messages: formattedMessages,
      temperature,
      max_tokens: maxTokens || undefined,
    });

    const content = response.choices?.[0]?.message?.content || "";
    const usage = response.usage
      ? {
          prompt_tokens: response.usage.prompt_tokens || 0,
          completion_tokens: response.usage.completion_tokens || 0,
        }
      : { prompt_tokens: 0, completion_tokens: 0 };

    return { content, usage };
  }
}

// ---- Lazy Registry (same pattern as audio-providers.ts) ----

const multimodalProviders: Record<string, MultimodalLLMProvider> = {};
let initialized = false;

function initMultimodalProviders(): void {
  if (initialized) return;

  if (settings.openaiApiKey) {
    multimodalProviders["openai"] = new OpenAIMultimodalProvider(
      settings.openaiApiKey,
      settings.openaiBaseUrl,
    );
    logger.info(
      "Multimodal provider initialized (OpenAI GPT-4o / GPT-4o-mini)",
    );
  } else {
    logger.warn(
      "No OpenAI API key configured — multimodal provider unavailable",
    );
  }

  initialized = true;
}

export function getMultimodalProvider(name?: string): MultimodalLLMProvider {
  initMultimodalProviders();
  const n = name || "openai";
  if (!multimodalProviders[n]) {
    throw new Error(
      `Multimodal provider '${n}' is not configured. Set OPENAI_API_KEY in .env.`,
    );
  }
  return multimodalProviders[n];
}

export function listMultimodalModels(): Array<{
  id: string;
  name: string;
  provider: string;
  max_tokens: number;
  supportsVision: boolean;
}> {
  initMultimodalProviders();
  const provider = Object.values(multimodalProviders)[0];
  return provider?.listModels() ?? [];
}

// Helper: build a multimodal message with text + images
export function buildVisionMessage(
  text: string,
  imageBase64List: string[],
  detail: "low" | "high" | "auto" = "auto",
): MultimodalMessage {
  const content: MultimodalContent[] = [{ type: "text", text }];

  for (const img of imageBase64List) {
    content.push({
      type: "image_url",
      image_url: {
        url: `data:image/jpeg;base64,${img}`,
        detail,
      },
    });
  }

  return { role: "user", content };
}
