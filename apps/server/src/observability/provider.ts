// ObservabilityProvider —— Runtime 可观测性抽象
//
// 设计要点：
// - Runtime 只依赖此接口，不感知具体观测后端（Langfuse / LangSmith / OTel）
// - 所有观测后端实现 ObservabilityProvider 后即可接入
// - Span 暂不对外开放 —— 将在 ExecutionTree + RuntimeEvent 落地后由 Runtime 自动生成
//
// ⚠️  禁止业务代码手工创建 Span。未来 Span 由 RuntimeEvent 驱动。

export interface TraceParams {
  name: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
}

export interface GenerationParams {
  name: string;
  model: string;
  input?: unknown;
  output?: unknown;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  metadata?: Record<string, unknown>;
}

export interface ObservabilityTrace {
  /** 创建一个 Generation（LLM 调用记录），自动挂在此 Trace 下 */
  generation(params: GenerationParams): ObservabilityGeneration;
  /** 更新 Trace 级别元数据（output / metadata） */
  update(params: {
    output?: unknown;
    metadata?: Record<string, unknown>;
  }): void;
  /** 结束 Trace。幂等 —— 重复调用只生效第一次 */
  end(): void;
}

export interface ObservabilityGeneration {
  /** 更新 Generation 元数据 */
  update(params: {
    output?: unknown;
    usage?: GenerationParams["usage"];
    metadata?: Record<string, unknown>;
  }): void;
  /** 结束 Generation 并可选填充 output + usage。幂等。 */
  end(params?: {
    output?: unknown;
    usage?: GenerationParams["usage"];
  }): void;
}

export interface ObservabilityProvider {
  readonly name: string;
  /** 创建 Trace。永远返回合法对象（启用=真实 Trace，禁用=NoopTrace） */
  createTrace(params: TraceParams): ObservabilityTrace;
  /** 优雅关闭，flush 待发送数据 */
  shutdown(): Promise<void>;
}

// ═══════════════════════════════════════════════════════
// Noop 实现（LANGFUSE_ENABLED=false 时使用）
// ═══════════════════════════════════════════════════════

export class NoopGeneration implements ObservabilityGeneration {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  update(): void {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  end(): void {}
}

export class NoopTrace implements ObservabilityTrace {
  generation(_params: GenerationParams): ObservabilityGeneration {
    return new NoopGeneration();
  }
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  update(): void {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  end(): void {}
}

export class NoopProvider implements ObservabilityProvider {
  readonly name = "noop";
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  createTrace(_params: TraceParams): ObservabilityTrace {
    return new NoopTrace();
  }
  async shutdown(): Promise<void> {
    /* no-op */
  }
}
