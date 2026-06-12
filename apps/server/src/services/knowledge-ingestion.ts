// 知识库文档摄取服务 —— 将文档切分、向量化，写入 Milvus 和 PostgreSQL
// 摄取流程：创建 Document 记录 → 文本切分 → 生成 embedding → 写入 Milvus → 保存 chunk 元数据到 PG
// 同时包含种子数据（客服 FAQ）和种子函数
import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import {
  getMilvusClient,
  MILVUS_KNOWLEDGE_COLLECTION,
  ensureKnowledgeCollection,
} from "./milvus.js";
import { getDefaultEmbeddingProvider } from "./embeddings.js";
import { RecursiveCharacterTextSplitter } from "./text-splitter.js";
import { tokenize, getTokenCount } from "./tokenizer.js";
import { logger } from "@agentforge/logger";

export class KnowledgeIngestionService {
  private splitter: RecursiveCharacterTextSplitter;
  private collectionLoaded = false;

  constructor() {
    // 每块 500 字符，相邻块重叠 50 字符
    this.splitter = new RecursiveCharacterTextSplitter(500, 50);
  }

  private async ensureCollection() {
    if (!this.collectionLoaded) {
      await ensureKnowledgeCollection();
      this.collectionLoaded = true;
    }
  }

  // 摄取单篇文档：创建记录 → 切分 → 向量化 → 双写
  async ingestDocument(kbId: string, title: string, content: string) {
    // 1. 创建 Document 记录，状态标记为 processing
    const doc = await prisma.knowledgeDocument.create({
      data: {
        id: randomUUID(),
        knowledgeBaseId: kbId,
        title,
        content,
        chunkCount: 0,
        status: "processing",
      },
    });

    try {
      // 2. 文本切分为 chunk
      const chunks = this.splitter.splitText(content);
      if (!chunks.length) {
        // 空内容：直接标记完成
        await prisma.knowledgeDocument.update({
          where: { id: doc.id },
          data: { status: "completed", chunkCount: 0 },
        });
        return await prisma.knowledgeDocument.findUnique({
          where: { id: doc.id },
        })!;
      }

      // 3. 逐 chunk 向量化并写入 Milvus + PG
      await this.ingestChunks(doc.id, kbId, chunks);

      // 4. 更新文档状态为 completed
      await prisma.knowledgeDocument.update({
        where: { id: doc.id },
        data: { chunkCount: chunks.length, status: "completed" },
      });

      logger.info({ title, chunks: chunks.length }, "Document ingested");
      return (await prisma.knowledgeDocument.findUnique({
        where: { id: doc.id },
      }))!;
    } catch (e) {
      // 摄取失败：标记为 failed，抛出异常让调用方感知
      logger.error(e, `Document ingestion failed: ${title}`);
      await prisma.knowledgeDocument.update({
        where: { id: doc.id },
        data: { status: "failed" },
      });
      throw e;
    }
  }

  // 批量摄取：逐文档串行处理（避免并发写入 Milvus 的竞态问题）
  async batchIngest(
    kbId: string,
    documents: Array<{ title: string; content: string }>,
  ) {
    const results = [];
    for (const docData of documents) {
      const doc = await this.ingestDocument(
        kbId,
        docData.title,
        docData.content,
      );
      results.push(doc);
    }
    return results;
  }

  // P1-1: Worker 专用方法 — 处理已创建的文档（文档由路由预创建为 status: "pending"）
  // 与 ingestDocument() 的区别：不创建新文档记录，只做切片→向量化→双写→更新状态
  async processExistingDocument(docId: string, kbId: string): Promise<void> {
    const doc = await prisma.knowledgeDocument.findUnique({
      where: { id: docId },
    });
    if (!doc) throw new Error(`Document ${docId} not found`);

    try {
      // 状态转换: pending → processing
      await prisma.knowledgeDocument.update({
        where: { id: docId },
        data: { status: "processing" },
      });

      // 文本切分
      const chunks = this.splitter.splitText(doc.content);
      if (!chunks.length) {
        await prisma.knowledgeDocument.update({
          where: { id: docId },
          data: { status: "completed", chunkCount: 0 },
        });
        return;
      }

      // 向量化 + 双写
      await this.ingestChunks(docId, kbId, chunks);

      // 标记完成
      await prisma.knowledgeDocument.update({
        where: { id: docId },
        data: { chunkCount: chunks.length, status: "completed" },
      });

      logger.info(
        { docId, chunks: chunks.length },
        "Document processed by worker",
      );
    } catch (e) {
      logger.error(
        { docId, error: (e as Error).message },
        "Worker document processing failed",
      );
      await prisma.knowledgeDocument.update({
        where: { id: docId },
        data: { status: "failed" },
      });
      throw e; // 重新抛出让 BullMQ 重试
    }
  }

  // Chunk 向量化 + 双写核心逻辑
  private async ingestChunks(
    docId: string,
    kbId: string,
    chunkTexts: string[],
  ) {
    const provider = getDefaultEmbeddingProvider();
    if (!provider) {
      throw new Error("No embedding provider configured");
    }

    await this.ensureCollection();

    // 1. 批量生成 dense 向量（一次 API 调用，比逐条调用效率高）
    const denseVecs = await provider.embed(chunkTexts);
    if (!denseVecs || denseVecs.length !== chunkTexts.length) {
      throw new Error("Embedding failed or returned mismatched count");
    }

    // 2. 批量插入 Milvus（行式格式：每个元素是一个 field→value 对象）
    const chunkIds = chunkTexts.map(() => randomUUID());
    const client = getMilvusClient();

    // Milvus SDK v2.x: fields_data 是行数组，每行是 { fieldName: value } 对象
    const rows = chunkTexts.map((text, i) => ({
      chunk_id: chunkIds[i],
      kb_id: kbId,
      dense_vector: denseVecs[i],
      content: text.slice(0, 4096), // Milvus VarChar 最长 4096
    }));

    const mr = await client.insert({
      collection_name: MILVUS_KNOWLEDGE_COLLECTION,
      fields_data: rows,
    });

    // 3. 保存 chunk 元数据到 PG（包含 Milvus 返回的内部 ID）
    const milvusIds = (mr.IDs as any)?.int_id?.data || [];
    for (let i = 0; i < chunkIds.length; i++) {
      await prisma.knowledgeChunk.create({
        data: {
          id: chunkIds[i],
          documentId: docId,
          knowledgeBaseId: kbId,
          chunkIndex: i,
          content: chunkTexts[i],
          tokenCount: getTokenCount(chunkTexts[i]),
          milvusId: milvusIds[i] ? BigInt(milvusIds[i]) : null,
        },
      });
    }

    // 4. 构建倒排索引: jieba 分词 → 统计 term freq → 批量写入
    for (let i = 0; i < chunkTexts.length; i++) {
      const tokens = tokenize(chunkTexts[i]);
      const termFreqMap = new Map<string, number>();
      for (const t of tokens) {
        termFreqMap.set(t, (termFreqMap.get(t) ?? 0) + 1);
      }
      if (termFreqMap.size > 0) {
        await prisma.knowledgeInvertedIndex.createMany({
          data: Array.from(termFreqMap.entries()).map(([term, freq]) => ({
            id: randomUUID(),
            term,
            chunkId: chunkIds[i],
            kbId,
            termFreq: freq,
          })),
        });
      }
    }
  }

  // 删除文档：同时清理 PG 和 Milvus 中的数据
  async deleteDocument(docId: string): Promise<boolean> {
    const doc = await prisma.knowledgeDocument.findUnique({
      where: { id: docId },
    });
    if (!doc) return false;

    // 查出所有 chunk 的 milvus ID
    const chunks = await prisma.knowledgeChunk.findMany({
      where: { documentId: docId },
      select: { id: true, milvusId: true },
    });
    const milvusIds = chunks
      .filter((c) => c.milvusId !== null)
      .map((c) => Number(c.milvusId));

    // 从 Milvus 删除向量
    if (milvusIds.length > 0) {
      try {
        await this.ensureCollection();
        const client = getMilvusClient();
        const idExpr = milvusIds.join(", ");
        await client.delete({
          collection_name: MILVUS_KNOWLEDGE_COLLECTION,
          filter: `id in [${idExpr}]`,
        });
      } catch (e) {
        logger.warn(e, "Milvus delete failed during document cleanup");
      }
    }

    // 清理倒排索引（用 chunk ID 精确删除）
    const chunkIds = chunks.map((c) => c.id);
    await prisma.knowledgeInvertedIndex.deleteMany({
      where: { chunkId: { in: chunkIds } },
    });

    // 从 PG 删除（CASCADE 会自动删关联的 chunks 和 inverted_index）
    await prisma.knowledgeChunk.deleteMany({ where: { documentId: docId } });
    await prisma.knowledgeDocument.delete({ where: { id: docId } });

    logger.info({ docId, vectors: milvusIds.length }, "Document deleted");
    return true;
  }

  // 重建倒排索引：清空旧索引 → 重新分词 → 写入
  static async rebuildInvertedIndex(kbId?: string): Promise<void> {
    const whereClause: any = { enabled: true };
    if (kbId) whereClause.knowledgeBaseId = kbId;

    const chunks = await prisma.knowledgeChunk.findMany({
      where: whereClause,
      select: { id: true, content: true, knowledgeBaseId: true },
    });

    if (chunks.length === 0) {
      logger.info("No chunks to rebuild inverted index");
      return;
    }

    // 清空目标 KB 的旧索引
    if (kbId) {
      await prisma.knowledgeInvertedIndex.deleteMany({ where: { kbId } });
    } else {
      const kbIds = [...new Set(chunks.map((c) => c.knowledgeBaseId))];
      await prisma.knowledgeInvertedIndex.deleteMany({
        where: { kbId: { in: kbIds } },
      });
    }

    // 逐 chunk 重建分词和倒排索引
    for (const chunk of chunks) {
      const tokens = tokenize(chunk.content);
      const termFreqMap = new Map<string, number>();
      for (const t of tokens) {
        termFreqMap.set(t, (termFreqMap.get(t) ?? 0) + 1);
      }

      // 更新 tokenCount
      await prisma.knowledgeChunk.update({
        where: { id: chunk.id },
        data: { tokenCount: tokens.length },
      });

      // 写入倒排索引
      if (termFreqMap.size > 0) {
        await prisma.knowledgeInvertedIndex.createMany({
          data: Array.from(termFreqMap.entries()).map(([term, freq]) => ({
            id: randomUUID(),
            term,
            chunkId: chunk.id,
            kbId: chunk.knowledgeBaseId,
            termFreq: freq,
          })),
        });
      }
    }

    logger.info({ chunks: chunks.length }, "Inverted index rebuilt");
  }
}

// ════════════════════════════════════════════════════════════════
// 种子数据：客服 FAQ 知识库
// ════════════════════════════════════════════════════════════════

const DEFAULT_KB_ID = "kb-a00000-0000-0000-0000-00000000001";

// 5 篇示例 FAQ 文档（中文客服场景）
const SAMPLE_FAQS = [
  {
    title: "退换货政策",
    content: `退换货政策说明：\n\n1. 自收到商品之日起7天内，可以申请无理由退货。商品需保持原包装完整，配件齐全，不影响二次销售。\n\n2. 如商品存在质量问题，自收到商品之日起15天内可以申请换货或退货。需提供清晰的问题照片或视频作为凭证。\n\n3. 退货运费承担规则：因商品质量问题导致的退货，运费由商家承担。因个人原因退货，运费由买家承担。\n\n4. 退款处理时间：收到退回商品并确认无误后，1-3个工作日内原路退款到支付账户。\n\n5. 以下情况不支持退换货：已使用影响二次销售的商品、超过退换货期限、缺少原包装或配件。`,
  },
  {
    title: "物流配送说明",
    content: `物流配送说明：\n\n1. 全国包邮（港澳台及偏远地区除外），默认使用中通快递发货。偏远地区可能需要补运费差价。\n\n2. 下单后48小时内发货，节假日顺延。预售商品以商品页面标注的发货时间为准。\n\n3. 配送时效：一线城市1-2天，二线城市2-3天，三四线城市3-5天。具体以快递公司为准。\n\n4. 物流查询：发货后会短信通知快递单号，也可在订单详情页查看物流信息。\n\n5. 如遇到包裹丢失或破损，请在签收前检查，如有问题当场拒收并联系客服处理。`,
  },
  {
    title: "售后服务流程",
    content: `售后服务流程：\n\n1. 在线客服时间：工作日 9:00-18:00，周末 10:00-17:00。非工作时间可留言，客服上线后第一时间回复。\n\n2. 电话客服热线：400-123-4567，服务时间同在线客服。\n\n3. 售后问题处理流程：提交问题 → 客服审核（1小时内响应） → 确定解决方案 → 执行处理。\n\n4. 投诉建议：如对服务不满意，可发送邮件至 feedback@example.com，我们会在24小时内回复。\n\n5. 常见问题可先查阅帮助中心，大部分问题都可以自助解决，无需等待客服。`,
  },
  {
    title: "会员权益说明",
    content: `会员权益说明：\n\n普通会员：注册即享，享受积分累积（消费1元=1积分），积分可兑换优惠券。\n\n银卡会员：年消费满2000元自动升级，享受9.5折优惠、专属客服通道、生日双倍积分。\n\n金卡会员：年消费满5000元自动升级，享受9折优惠、免运费、优先发货、专属礼品包装。\n\n钻石会员：年消费满10000元自动升级，享受8.5折优惠、专属顾问1对1服务、新品优先体验、线下活动邀请。\n\n会员等级有效期为1年，到期后根据上一年消费重新评定等级。`,
  },
  {
    title: "支付方式说明",
    content: `支付方式说明：\n\n1. 支持的支付方式：微信支付、支付宝、银行卡（储蓄卡/信用卡）、Apple Pay。\n\n2. 分期付款：单笔订单满500元可申请分期，支持3期、6期、12期，部分银行支持免息分期。\n\n3. 优惠券使用：在下单页面选择可用优惠券，可与部分促销活动叠加使用。部分限时折扣商品不支持优惠券。\n\n4. 支付安全：所有支付均通过PCI-DSS认证的第三方支付平台处理，我们不会保存您的银行卡信息。\n\n5. 支付遇到问题：如支付失败，请检查银行卡余额和限额，或尝试更换支付方式。仍无法解决请联系客服。`,
  },
];

// 种子函数：启动时检查并创建默认知识库 + 5 篇 FAQ
export async function seedKnowledgeBase(): Promise<string> {
  // 幂等检查：已存在则跳过
  const existing = await prisma.knowledgeBase.findUnique({
    where: { id: DEFAULT_KB_ID },
  });
  if (existing) {
    logger.info("Knowledge base seed data already exists, skipping");
    return DEFAULT_KB_ID;
  }

  // 创建知识库记录
  await prisma.knowledgeBase.create({
    data: {
      id: DEFAULT_KB_ID,
      name: "客服FAQ知识库",
      description:
        "默认客服常见问题知识库，包含退换货、物流、售后、会员、支付等FAQ",
    },
  });

  // 检查 embedding provider 是否可用
  const provider = getDefaultEmbeddingProvider();
  if (!provider) {
    logger.info(
      "No embedding provider configured, skipping document vectorization",
    );
    return DEFAULT_KB_ID;
  }

  // 批量摄取 FAQ 文档
  logger.info(
    { count: SAMPLE_FAQS.length },
    "Ingesting sample FAQ documents...",
  );
  try {
    const ingestion = new KnowledgeIngestionService();
    await ingestion.batchIngest(DEFAULT_KB_ID, SAMPLE_FAQS);
    logger.info(
      { kbId: DEFAULT_KB_ID, docs: SAMPLE_FAQS.length },
      "Seed data created",
    );
  } catch (e) {
    logger.warn(
      e,
      "Seed data vectorization failed (Milvus may not be running)",
    );
  }

  return DEFAULT_KB_ID;
}
