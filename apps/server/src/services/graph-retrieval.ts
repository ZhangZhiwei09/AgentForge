// 知识图谱检索服务 —— LLM 从 query 抽取实体，Neo4j 1-3 跳遍历，返回推理链路
//
// 处理流程：
//   用户查询 → LLM 抽取实体名 → Neo4j 1-3 跳遍历（Cypher MATCH path）
//   → 返回实体链 + 关系链 + 证据 chunkId + 置信度
//
// 降级策略：Neo4j 不可用时返回空结果，不影响 RAG 主链路
import { getProvider, listProviders } from "../providers/registry.js";
import { settings } from "../config.js";
import { logger } from "@agentforge/logger";
import { parseJSONFromLLMResponse } from "../lib/json-utils.js";
import {
  isNeo4jAvailable,
  queryGraphEntities,
} from "./neo4j.js";

// ── 类型 ──────────────────────────────────────────────────

export interface GraphEntity {
  name: string;
  type: string;
  aliases: string[];
}

export interface GraphRelation {
  from: string;
  to: string;
  type: string;
  confidence: number;
  sourceChunkId: string;
}

export interface GraphRetrievalResult {
  entities: GraphEntity[];
  reasoningChains: Array<{
    entities: Array<{ name: string; type: string }>;
    relations: GraphRelation[];
  }>;
  evidenceChunkIds: string[];
  confidence: number;
}

// ── LLM Prompt ────────────────────────────────────────────

const ENTITY_EXTRACTION_PROMPT = `你是一个查询分析助手。从用户问题中提取关键实体名称。

## 实体识别规则
- 识别问题中提到的具体概念、对象、政策、条件、流程、角色等
- 实体名称应简洁明确，是用户问题中的核心名词或短语
- 最多提取 5 个最重要的实体

## 输出格式
返回 JSON 对象：{"entities": ["实体1", "实体2", ...]}

如果问题中没有明确的实体，返回 {"entities": []}。

示例：
- 问："退换货需要什么条件？" → {"entities": ["退换货", "条件"]}
- 问："金卡会员有什么权益？" → {"entities": ["金卡会员", "权益"]}
- 问："物流配送要多久？" → {"entities": ["物流配送"]}`;

export class GraphRetrievalService {
  /**
   * 从用户查询中检索知识图谱推理链路
   */
  async retrieve(
    query: string,
    kbIds?: string[],
  ): Promise<GraphRetrievalResult | null> {
    // 1. 检查 Neo4j 是否可用
    const neo4jAvailable = await isNeo4jAvailable();
    if (!neo4jAvailable) {
      logger.debug("Neo4j unavailable, skipping graph retrieval");
      return null;
    }

    try {
      // 2. LLM 抽取实体名
      const entityNames = await this.extractEntitiesFromQuery(query);
      if (!entityNames || entityNames.length === 0) {
        return null;
      }

      // 3. Neo4j 图遍历
      const graphPaths = await queryGraphEntities(entityNames, 3); // 1-3 跳

      if (!graphPaths || graphPaths.length === 0) {
        return null;
      }

      // 4. 提取证据 chunkId 列表
      const evidenceChunkIds = [
        ...new Set(
          graphPaths.flatMap((path) =>
            path.relations.map((r) => r.sourceChunkId),
          ),
        ),
      ];

      // 5. 计算置信度（基于关系置信度的平均值）
      const allRelations = graphPaths.flatMap((p) => p.relations);
      const avgConfidence =
        allRelations.length > 0
          ? allRelations.reduce((sum, r) => sum + r.confidence, 0) /
            allRelations.length
          : 0;

      return {
        entities: entityNames.map((name) => ({
          name,
          type: "unknown",
          aliases: [],
        })),
        reasoningChains: graphPaths,
        evidenceChunkIds,
        confidence: Math.round(avgConfidence * 100) / 100,
      };
    } catch (e) {
      logger.warn(e, "Graph retrieval failed");
      return null;
    }
  }

  // ── 私有方法 ────────────────────────────────────────────

  private async extractEntitiesFromQuery(
    query: string,
  ): Promise<string[] | null> {
    const providerName = this.getLLMProvider();
    if (!providerName) return null;

    const provider = getProvider(providerName);
    const model = settings.defaultModel;

    try {
      const result = await provider.chatSync(
        [{ role: "user", content: query }],
        model,
        ENTITY_EXTRACTION_PROMPT,
        0.1,
        300,
        true, // JSON mode
      );

      const parsed = parseJSONFromLLMResponse(result.content);
      if (!parsed || typeof parsed !== "object") return null;

      const entities = (parsed as Record<string, unknown>).entities;
      if (!Array.isArray(entities) || entities.length === 0) return null;

      return entities.filter(
        (e): e is string => typeof e === "string" && e.length > 0,
      );
    } catch (e) {
      logger.warn(e, "Entity extraction from query failed");
      return null;
    }
  }

  private getLLMProvider(): string | null {
    const providers = listProviders();
    if (providers.length === 0) return null;
    return providers[0].type;
  }
}

// 单例
let retrievalInstance: GraphRetrievalService | undefined;

export function getGraphRetrievalService(): GraphRetrievalService {
  if (!retrievalInstance) {
    retrievalInstance = new GraphRetrievalService();
  }
  return retrievalInstance;
}
