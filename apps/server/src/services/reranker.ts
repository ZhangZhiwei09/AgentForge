// HTTP Reranker 客户端 —— 对多路召回结果进行精排
// 通过 HTTP POST 发送 query + documents 到独立部署的 Reranker 模型服务
// 降级策略：Reranker 不可用时，调用方直接使用 RRF 融合分数作为最终排序
import { settings } from "../config.js";
import { logger } from "@agentforge/logger";

// Reranker 响应格式（兼容主流 reranker API: Cohere v2 / BAAI bge-reranker / Jina）
interface RerankerResponse {
  results?: Array<{
    index: number;
    relevance_score: number;
    score?: number; // 备选字段名
  }>;
}

// Reranker 单条输入文档
export interface RerankerDocument {
  text: string;
  id?: string;
  meta?: Record<string, unknown>;
}

// Reranker 精排结果
export interface RerankerResult {
  index: number;
  score: number;
}

// Reranker HTTP 请求
export interface RerankerRequest {
  query: string;
  documents: RerankerDocument[];
  topK?: number;
}

export class RerankerService {
  // 判断 Reranker 是否已配置
  isConfigured(): boolean {
    return !!(settings.rerankerBaseUrl && settings.rerankerModel);
  }

  // 发送精排请求
  async rerank(
    query: string,
    documents: RerankerDocument[],
    topK: number = 10,
  ): Promise<RerankerResult[]> {
    if (!this.isConfigured()) return [];

    const url = `${settings.rerankerBaseUrl}/rerank`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s 超时

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.getAuthHeader()),
        },
        body: JSON.stringify({
          model: settings.rerankerModel,
          query,
          documents,
          topK,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        logger.warn(
          { status: response.status },
          "Reranker request failed",
        );
        return [];
      }

      const data: RerankerResponse = await response.json();

      if (data.results && Array.isArray(data.results)) {
        return data.results.map((r) => ({
          index: r.index,
          score: r.relevance_score ?? r.score ?? 0,
        }));
      }

      return [];
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        logger.warn("Reranker request timeout");
      } else {
        logger.warn(e, "Reranker request error");
      }
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  // 认证头（如需 API Key 可在此扩展）
  private getAuthHeader(): Record<string, string> {
    // 当前版本默认无鉴权，预留扩展点
    return {};
  }
}

// 单例
let rerankerInstance: RerankerService | null = null;

export function getReranker(): RerankerService {
  if (!rerankerInstance) {
    rerankerInstance = new RerankerService();
  }
  return rerankerInstance;
}
