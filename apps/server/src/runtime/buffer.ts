// OutputBuffer — 纯输出缓冲，无持久化，无生命周期
//
// 被 Chat / Voice / Workflow / AgentTrace 等所有流式场景复用。
// V2 预留：泛型 OutputBuffer<T> 支持结构化输出。

export class OutputBuffer {
  private content = "";

  /** 追加输出片段（token / chunk / step） */
  append(token: string): void {
    this.content += token;
  }

  /** 获取完整输出内容 */
  getContent(): string {
    return this.content;
  }

  /** 清空缓冲区 */
  clear(): void {
    this.content = "";
  }

  /** 缓冲区是否为空 */
  get isEmpty(): boolean {
    return this.content.length === 0;
  }
}
