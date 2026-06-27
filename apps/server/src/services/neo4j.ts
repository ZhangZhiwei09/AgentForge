// Neo4j 图数据库客户端模块 —— 知识图谱存储与检索
// 提供驱动封装、连接管理、基础 Cypher 操作
// 降级策略：Neo4j 不可用时上层调用方跳过图检索，不影响 RAG 主链路
import neo4j, { type Driver, type Session, type QueryResult } from "neo4j-driver";

// Re-export neo4j namespace for integer conversion
export { neo4j };
import { settings } from "../config.js";
import { logger } from "@agentforge/logger";

// 单例驱动，惰性初始化
let neo4jDriver: Driver | null = null;

export function getNeo4jDriver(): Driver | null {
  if (!neo4jDriver && settings.neo4jUri) {
    try {
      neo4jDriver = neo4j.driver(
        settings.neo4jUri,
        neo4j.auth.basic(settings.neo4jUser, settings.neo4jPassword),
        {
          maxConnectionLifetime: 30 * 60 * 1000, // 30 min
          maxConnectionPoolSize: 10,
          connectionAcquisitionTimeout: 10_000, // 10s
        },
      );
      logger.info({ uri: settings.neo4jUri }, "Neo4j driver created");
    } catch (e) {
      logger.warn(e, "Failed to create Neo4j driver");
      return null;
    }
  }
  return neo4jDriver;
}

// 判断 Neo4j 是否可用
export async function isNeo4jAvailable(): Promise<boolean> {
  const driver = getNeo4jDriver();
  if (!driver) return false;
  try {
    const session = driver.session();
    try {
      await session.run("RETURN 1");
      return true;
    } finally {
      await session.close();
    }
  } catch {
    return false;
  }
}

// 获取一个会话（调用方负责关闭）
export function getNeo4jSession(): Session | null {
  const driver = getNeo4jDriver();
  if (!driver) return null;
  return driver.session();
}

// 快捷方法：执行单条 Cypher 查询并返回结果
export async function runQuery(
  cypher: string,
  params?: Record<string, unknown>,
): Promise<QueryResult | null> {
  const session = getNeo4jSession();
  if (!session) return null;
  try {
    return await session.run(cypher, params);
  } catch (e) {
    logger.warn({ cypher: cypher.slice(0, 100), error: String(e) }, "Neo4j query failed");
    return null;
  } finally {
    await session.close();
  }
}

// 初始化知识图谱所需约束和索引
export async function ensureGraphConstraints(): Promise<void> {
  const driver = getNeo4jDriver();
  if (!driver) return;

  const session = driver.session();
  try {
    // 确保 Entity 节点有唯一约束（name + type 组合）
    await session.run(`
      CREATE CONSTRAINT entity_name_type IF NOT EXISTS
      FOR (e:Entity) REQUIRE (e.name, e.type) IS UNIQUE
    `);
    // 为 Entity name 建索引（加速查询）
    await session.run(`
      CREATE INDEX entity_name IF NOT EXISTS
      FOR (e:Entity) ON (e.name)
    `);
    // 为 Entity type 建索引
    await session.run(`
      CREATE INDEX entity_type IF NOT EXISTS
      FOR (e:Entity) ON (e.type)
    `);

    logger.info("Neo4j graph constraints and indexes ensured");
  } catch (e) {
    logger.warn(e, "Failed to ensure Neo4j graph constraints");
  } finally {
    await session.close();
  }
}

// MERGE 一个 Entity 节点（幂等：name+type 已存在则更新属性）
export async function mergeEntity(params: {
  name: string;
  type: string;
  kbId: string;
  docIds: string[];
  aliases: string[];
}): Promise<void> {
  await runQuery(
    `
    MERGE (e:Entity {name: $name, type: $type})
    ON CREATE SET
      e.kbId = $kbId,
      e.docIds = $docIds,
      e.aliases = $aliases,
      e.createdAt = datetime()
    ON MATCH SET
      e.docIds = apoc.coll.union(coalesce(e.docIds, []), $docIds),
      e.aliases = apoc.coll.union(coalesce(e.aliases, []), $aliases)
    `,
    params,
  );
}

// MERGE 一条 REL 关系（幂等：同 sourceChunkId 的关系不重复创建）
export async function mergeRelation(params: {
  fromName: string;
  fromType: string;
  toName: string;
  toType: string;
  relType: string;
  confidence: number;
  sourceChunkId: string;
  docId: string;
  evidence?: string;
}): Promise<void> {
  await runQuery(
    `
    MATCH (a:Entity {name: $fromName, type: $fromType})
    MATCH (b:Entity {name: $toName, type: $toType})
    MERGE (a)-[r:REL {relType: $relType, sourceChunkId: $sourceChunkId}]->(b)
    ON CREATE SET
      r.confidence = $confidence,
      r.docId = $docId,
      r.evidence = $evidence,
      r.createdAt = datetime()
    ON MATCH SET
      r.confidence = $confidence
    `,
    params,
  );
}

// 按文档 ID 删除所有相关关系和实体（清理孤立实体）
export async function deleteGraphByDocId(docId: string): Promise<void> {
  const session = getNeo4jSession();
  if (!session) return;
  try {
    // 删除来源为该文档的关系
    await session.run(
      `MATCH (:Entity)-[r:REL {docId: $docId}]->(:Entity) DELETE r`,
      { docId },
    );
    // 清理孤立实体（没有任何关系的 Entity）
    await session.run(
      `MATCH (e:Entity) WHERE NOT (e)--() AND $docId IN coalesce(e.docIds, []) DELETE e`,
      { docId },
    );
    logger.info({ docId }, "Graph data cleaned for document");
  } catch (e) {
    logger.warn({ docId, error: String(e) }, "Failed to delete graph data by docId");
  } finally {
    await session.close();
  }
}

// 图检索：从 query 中抽取的实体列表出发，执行 1-3 跳遍历
// 返回实体、关系链、来源 chunkId
export async function queryGraphEntities(
  entityNames: string[],
  maxHops: number = 3,
): Promise<
  Array<{
    entities: Array<{ name: string; type: string }>;
    relations: Array<{
      from: string;
      to: string;
      type: string;
      confidence: number;
      sourceChunkId: string;
    }>;
  }>
> {
  const session = getNeo4jSession();
  if (!session || entityNames.length === 0) return [];

  try {
    // 对每个匹配的实体，查找 1-3 跳内的所有关系
    const result = await session.run(
      `
      MATCH (start:Entity)
      WHERE start.name IN $entityNames
      MATCH path = (start)-[rels:REL*1..${maxHops}]->(end:Entity)
      WITH path, relationships(path) AS relList, nodes(path) AS nodeList
      RETURN
        [n IN nodeList | {name: n.name, type: n.type}] AS entities,
        [r IN relList | {
          from: startNode(r).name,
          to: endNode(r).name,
          type: r.relType,
          confidence: r.confidence,
          sourceChunkId: r.sourceChunkId
        }] AS relations
      LIMIT 10
      `,
      { entityNames },
    );

    return result.records.map((record) => ({
      entities: record.get("entities"),
      relations: record.get("relations"),
    }));
  } catch (e) {
    logger.warn({ entityNames, error: String(e) }, "Neo4j graph query failed");
    return [];
  } finally {
    await session.close();
  }
}

// 获取图谱统计信息
export async function getGraphStats(): Promise<{
  nodeCount: number;
  relationCount: number;
} | null> {
  const result = await runQuery(
    `MATCH (e:Entity) WITH count(e) AS nodes
     OPTIONAL MATCH ()-[r:REL]->()
     RETURN nodes, count(r) AS rels`,
  );
  if (!result || result.records.length === 0) return null;
  const record = result.records[0];
  return {
    nodeCount: neo4j.integer.toNumber(record.get("nodes")),
    relationCount: neo4j.integer.toNumber(record.get("rels")),
  };
}
