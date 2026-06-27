// 知识图谱抽取服务 —— LLM 从文档 chunk 中抽取实体和关系，写入 Neo4j + PG
//
// 处理流程：
//   文档 chunk 内容 → LLM 抽取实体/关系 → Neo4j MERGE 实体节点 + 关系
//   → PG KnowledgeGraphEntity/KnowledgeGraphRelation 冗余存储（审计/回退）
//
// 设计原则：
//   - 图谱抽取失败不阻塞文档摄取主流程（仅警告日志）
//   - 使用 Chinese prompt 抽取
//   - confidence 低于阈值的关系不写入
import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import { getProvider, listProviders } from "../providers/registry.js";
import { settings } from "../config.js";
import { logger } from "@agentforge/logger";
import { parseJSONFromLLMResponse } from "../lib/json-utils.js";
import {
  isNeo4jAvailable,
  mergeEntity,
  mergeRelation,
  deleteGraphByDocId,
} from "./neo4j.js";

// ── 类型 ──────────────────────────────────────────────────

interface ExtractedEntity {
  name: string;
  type: string;           // 实体类型，如 "政策"、"条件"、"角色"、"指标"
  aliases: string[];
}

interface ExtractedRelation {
  fromEntity: string;
  fromType: string;
  toEntity: string;
  toType: string;
  relType: string;        // 关系类型，如 "需要"、"属于"、"限制"、"包含"
  confidence: number;
  evidence: string;       // 原文证据片段
}

interface ExtractionResult {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
}

const MIN_CONFIDENCE = 0.6; // 低于此置信度的关系不写入

const EXTRACTION_SYSTEM_PROMPT = `你是一个知识图谱构建助手。分析给定的文本段落，提取其中的实体和关系。

## 实体抽取规则
- 识别文本中的重要概念、对象、角色、条件、指标、政策等作为实体
- 每个实体需要：名称（name）、类型（type，如"政策"、"条件"、"角色"、"指标"、"流程"、"限制"）、别名列表（aliases）
- 实体名称应简洁明确

## 关系抽取规则
- 识别实体之间的语义关系
- 关系类型：需要、属于、限制、包含、触发、依赖、等价于、先于
- 每条关系需要置信度（0.0-1.0），仅提取明确成立的关系
- 提供原文证据片段（evidence）

## 输出格式
返回 JSON 对象：{"entities": [...], "relations": [...]}

如果文本中没有明显的实体关系，返回空的 entities 和 relations 数组。`;

export class GraphExtractionService {
  /**
   * 从单个 chunk 抽取实体关系并写入 Neo4j + PG
   */
  async extractFromChunk(
    chunkId: string,
    content: string,
    kbId: string,
    docId: string,
  ): Promise<void> {
    const providerName = this.getLLMProvider();
    if (!providerName) {
      logger.info("No LLM provider available, skipping graph extraction");
      return;
    }

    try {
      // 1. LLM 抽取
      const extraction = await this.extractWithLLM(content, providerName);
      if (
        !extraction ||
        (extraction.entities.length === 0 && extraction.relations.length === 0)
      ) {
        return;
      }

      // 2. 写入 Neo4j
      const neo4jAvailable = await isNeo4jAvailable();
      for (const entity of extraction.entities) {
        // PG 冗余存储
        await this.upsertEntityPG(entity, kbId, docId);

        // Neo4j 存储（可用时）
        if (neo4jAvailable) {
          await mergeEntity({
            name: entity.name,
            type: entity.type,
            kbId,
            docIds: [docId],
            aliases: entity.aliases,
          }).catch((e) =>
            logger.warn({ entity: entity.name }, e, "Neo4j mergeEntity failed"),
          );
        }
      }

      // 写入关系
      for (const rel of extraction.relations) {
        if (rel.confidence < MIN_CONFIDENCE) continue;

        // PG 冗余存储
        await this.insertRelationPG(rel, chunkId, docId);

        // Neo4j 存储（可用时）
        if (neo4jAvailable) {
          await mergeRelation({
            fromName: rel.fromEntity,
            fromType: rel.fromType,
            toName: rel.toEntity,
            toType: rel.toType,
            relType: rel.relType,
            confidence: rel.confidence,
            sourceChunkId: chunkId,
            docId,
            evidence: rel.evidence.slice(0, 500),
          }).catch((e) =>
            logger.warn(
              { from: rel.fromEntity, to: rel.toEntity },
              e,
              "Neo4j mergeRelation failed",
            ),
          );
        }
      }

      logger.info(
        {
          chunkId,
          entities: extraction.entities.length,
          relations: extraction.relations.length,
          neo4j: neo4jAvailable,
        },
        "Graph extraction completed",
      );
    } catch (e) {
      // 图谱抽取失败不抛异常，不阻塞文档摄取主流程
      logger.warn({ chunkId, error: String(e) }, "Graph extraction failed (non-blocking)");
    }
  }

  /**
   * 按文档 ID 删除所有相关图谱数据（Neo4j + PG）
   */
  async deleteByDocument(docId: string): Promise<void> {
    try {
      // Neo4j 清理
      await deleteGraphByDocId(docId).catch((e) =>
        logger.warn({ docId }, e, "Neo4j graph cleanup failed"),
      );

      // PG 清理
      await prisma.knowledgeGraphRelation.deleteMany({
        where: { docId },
      });
      // 注：Entity 的 docIds 数组清理较复杂，暂不自动删除
      // 后续可通过定期清理孤立实体任务处理

      logger.info({ docId }, "Graph data cleaned for document");
    } catch (e) {
      logger.warn({ docId, error: String(e) }, "Graph cleanup failed");
    }
  }

  // ── 私有方法 ────────────────────────────────────────────

  private async extractWithLLM(
    content: string,
    providerName: string,
  ): Promise<ExtractionResult | null> {
    const provider = getProvider(providerName);
    const model = settings.defaultModel;
    const truncatedContent = content.slice(0, 3000); // 控制 token

    const userMessage = `请分析以下文本，提取实体和关系：\n\n${truncatedContent}`;

    try {
      const result = await provider.chatSync(
        [{ role: "user", content: userMessage }],
        model,
        EXTRACTION_SYSTEM_PROMPT,
        0.1, // 低温度保证稳定抽取
        1500,
        true, // JSON mode
      );

      const parsed = parseJSONFromLLMResponse(result.content);
      if (!parsed || typeof parsed !== "object") return null;

      const obj = parsed as Record<string, unknown>;
      return {
        entities: Array.isArray(obj.entities) ? (obj.entities as ExtractedEntity[]) : [],
        relations: Array.isArray(obj.relations) ? (obj.relations as ExtractedRelation[]) : [],
      };
    } catch (e) {
      logger.warn(e, "Graph extraction LLM call failed");
      return null;
    }
  }

  private async upsertEntityPG(
    entity: ExtractedEntity,
    kbId: string,
    docId: string,
  ): Promise<void> {
    try {
      const existing = await prisma.knowledgeGraphEntity.findFirst({
        where: { name: entity.name, type: entity.type },
      });

      if (existing) {
        // 追加新 docId 到列表
        const newDocIds = [...new Set([...existing.docIds, docId])];
        const newAliases = [
          ...new Set([...existing.aliases, ...entity.aliases]),
        ];
        await prisma.knowledgeGraphEntity.update({
          where: { id: existing.id },
          data: { docIds: newDocIds, aliases: newAliases },
        });
      } else {
        await prisma.knowledgeGraphEntity.create({
          data: {
            id: randomUUID(),
            name: entity.name,
            type: entity.type,
            kbId,
            docIds: [docId],
            aliases: entity.aliases,
          },
        });
      }
    } catch (e) {
      logger.warn({ entity: entity.name, error: String(e) }, "PG entity upsert failed");
    }
  }

  private async insertRelationPG(
    rel: ExtractedRelation,
    chunkId: string,
    docId: string,
  ): Promise<void> {
    try {
      await prisma.knowledgeGraphRelation.create({
        data: {
          id: randomUUID(),
          fromEntityId: "", // 名称引用（不强制外键）
          toEntityId: "",   // 名称引用
          relType: rel.relType,
          confidence: rel.confidence,
          sourceChunkId: chunkId,
          docId,
          evidence: rel.evidence?.slice(0, 2000) ?? null,
        },
      });
    } catch (e) {
      logger.warn(
        { from: rel.fromEntity, to: rel.toEntity, error: String(e) },
        "PG relation insert failed",
      );
    }
  }

  private getLLMProvider(): string | null {
    const providers = listProviders();
    if (providers.length === 0) return null;
    return providers[0].type;
  }
}

// 单例
let extractionInstance: GraphExtractionService | undefined;

export function getGraphExtractionService(): GraphExtractionService {
  if (!extractionInstance) {
    extractionInstance = new GraphExtractionService();
  }
  return extractionInstance;
}
