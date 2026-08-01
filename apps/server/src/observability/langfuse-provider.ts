// LangfuseProvider —— Langfuse 观测后端实现
//
// 本文件是唯一允许 import { Langfuse } from "langfuse" 的文件。
// 业务代码只能通过 ObservabilityProvider 接口消费观测能力。
//
// 安全策略：
// - 所有操作 try/catch，失败降级为 Noop，绝不抛异常
// - createTrace 即使 Langfuse 服务挂了也返回 NoopTrace
// - end() 幂等保护，重复调用只生效第一次

import { Langfuse } from "langfuse";
import type { LangfuseTraceClient, LangfuseGenerationClient } from "langfuse";
import type {
  ObservabilityProvider,
  ObservabilityTrace,
  ObservabilityGeneration,
  TraceParams,
  GenerationParams,
} from "./provider.js";
import { NoopTrace, NoopGeneration } from "./provider.js";
import { logger } from "@agentforge/logger";

// ═══════════════════════════════════════════════════════
// LangfuseGeneration
// ═══════════════════════════════════════════════════════

class LangfuseGeneration implements ObservabilityGeneration {
  private _ended = false;

  constructor(private gen: LangfuseGenerationClient) {}

  update(params: {
    output?: unknown;
    usage?: GenerationParams["usage"];
    metadata?: Record<string, unknown>;
  }): void {
    if (this._ended) return;
    try {
      this.gen.update({
        output: params.output,
        usage: params.usage
          ? {
              promptTokens: params.usage.promptTokens,
              completionTokens: params.usage.completionTokens,
              total: params.usage.totalTokens,
            }
          : undefined,
        metadata: params.metadata,
      });
    } catch (err) {
      logger.warn(err, "Langfuse generation update failed");
    }
  }

  end(params?: {
    output?: unknown;
    usage?: GenerationParams["usage"];
  }): void {
    if (this._ended) return;
    this._ended = true;
    try {
      this.gen.end(
        params
          ? {
              output: params.output,
              usage: params.usage
                ? {
                    promptTokens: params.usage.promptTokens,
                    completionTokens: params.usage.completionTokens,
                    total: params.usage.totalTokens,
                  }
                : undefined,
            }
          : undefined,
      );
    } catch (err) {
      logger.warn(err, "Langfuse generation end failed");
    }
  }
}

// ═══════════════════════════════════════════════════════
// LangfuseTrace
// ═══════════════════════════════════════════════════════

class LangfuseTrace implements ObservabilityTrace {
  private _ended = false;

  constructor(private trace: LangfuseTraceClient) {}

  generation(params: GenerationParams): ObservabilityGeneration {
    if (this._ended) return new NoopGeneration();
    try {
      const gen = this.trace.generation({
        name: params.name,
        model: params.model,
        input: params.input,
        output: params.output,
        usage: params.usage
          ? {
              promptTokens: params.usage.promptTokens,
              completionTokens: params.usage.completionTokens,
              total: params.usage.totalTokens,
            }
          : undefined,
        metadata: params.metadata,
      });
      return new LangfuseGeneration(gen);
    } catch (err) {
      logger.warn(err, "Langfuse generation creation failed — falling back to Noop");
      return new NoopGeneration();
    }
  }

  update(params: {
    output?: unknown;
    metadata?: Record<string, unknown>;
  }): void {
    if (this._ended) return;
    try {
      this.trace.update({
        output: params.output,
        metadata: params.metadata,
      });
    } catch (err) {
      logger.warn(err, "Langfuse trace update failed");
    }
  }

  end(): void {
    if (this._ended) return;
    this._ended = true;
    // LangfuseTraceClient 没有 end()，只需标记结束状态
    // 数据通过 update() 已提交，SDK 定时 flush
  }
}

// ═══════════════════════════════════════════════════════
// LangfuseProvider
// ═══════════════════════════════════════════════════════

export class LangfuseProvider implements ObservabilityProvider {
  readonly name = "langfuse";
  private client: Langfuse;

  constructor(config: {
    baseUrl: string;
    publicKey: string;
    secretKey: string;
  }) {
    this.client = new Langfuse({
      baseUrl: config.baseUrl,
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      flushAt: 5,
      flushInterval: 2000,
    });
  }

  createTrace(params: TraceParams): ObservabilityTrace {
    try {
      const trace = this.client.trace({
        name: params.name,
        input: params.input,
        metadata: params.metadata,
      });
      return new LangfuseTrace(trace);
    } catch (err) {
      logger.warn(err, "Langfuse createTrace failed — falling back to NoopTrace");
      return new NoopTrace();
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.client.flushAsync();
      await this.client.shutdownAsync();
    } catch (err) {
      logger.warn(err, "Langfuse shutdown failed");
    }
  }
}
