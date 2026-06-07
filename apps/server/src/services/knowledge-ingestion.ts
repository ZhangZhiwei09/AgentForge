import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import { getMilvusClient, MILVUS_KNOWLEDGE_COLLECTION, ensureKnowledgeCollection } from "./milvus.js";
import { getDefaultEmbeddingProvider } from "./embeddings.js";
import { RecursiveCharacterTextSplitter } from "./text-splitter.js";
import { BM25SparseEncoder } from "./bm25.js";

let bm25Encoder: BM25SparseEncoder | null = null;

function getBM25(): BM25SparseEncoder {
  if (!bm25Encoder) {
    bm25Encoder = new BM25SparseEncoder();
  }
  return bm25Encoder;
}

export class KnowledgeIngestionService {
  private splitter: RecursiveCharacterTextSplitter;
  private collectionLoaded = false;

  constructor() {
    this.splitter = new RecursiveCharacterTextSplitter(500, 50);
  }

  private async ensureCollection() {
    if (!this.collectionLoaded) {
      await ensureKnowledgeCollection();
      this.collectionLoaded = true;
    }
  }

  async ingestDocument(
    kbId: string,
    title: string,
    content: string,
  ) {
    // 1. Create document record (processing)
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
      // 2. Split text
      const chunks = this.splitter.splitText(content);
      if (!chunks.length) {
        await prisma.knowledgeDocument.update({
          where: { id: doc.id },
          data: { status: "completed", chunkCount: 0 },
        });
        return await prisma.knowledgeDocument.findUnique({ where: { id: doc.id } })!;
      }

      // 3. Ingest chunks
      await this.ingestChunks(doc.id, kbId, chunks);

      // 4. Update document status
      await prisma.knowledgeDocument.update({
        where: { id: doc.id },
        data: { chunkCount: chunks.length, status: "completed" },
      });

      console.log(`[knowledge] Document ingested: ${title} (${chunks.length} chunks)`);
      return (await prisma.knowledgeDocument.findUnique({ where: { id: doc.id } }))!;
    } catch (e) {
      console.error(`[knowledge] Document ingestion failed: ${title}`, e);
      await prisma.knowledgeDocument.update({
        where: { id: doc.id },
        data: { status: "failed" },
      });
      throw e;
    }
  }

  async batchIngest(
    kbId: string,
    documents: Array<{ title: string; content: string }>,
  ) {
    const results = [];
    for (const docData of documents) {
      const doc = await this.ingestDocument(kbId, docData.title, docData.content);
      results.push(doc);
    }
    return results;
  }

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

    // 1. Dense vectors (batch)
    const denseVecs = await provider.embed(chunkTexts);
    if (!denseVecs || denseVecs.length !== chunkTexts.length) {
      throw new Error("Embedding failed or returned mismatched count");
    }

    // 2. Sparse vectors (BM25)
    const bm25 = getBM25();
    const sparseVecs = bm25.encodeDocuments(chunkTexts);
    // If BM25 not fitted, use zero-like sparse vectors
    const sparseVectors = sparseVecs.map((sv) => {
      const vec = new Array(1536).fill(0);
      for (const [idx, val] of Object.entries(sv)) {
        vec[parseInt(idx)] = val;
      }
      return vec;
    });

    // 3. Insert into Milvus
    const chunkIds = chunkTexts.map(() => randomUUID());
    const client = getMilvusClient();

    const mr = await client.insert({
      collection_name: MILVUS_KNOWLEDGE_COLLECTION,
      fields_data: [
        { name: "chunk_id", values: chunkIds },
        { name: "kb_id", values: chunkTexts.map(() => kbId) },
        { name: "dense_vector", values: denseVecs },
        { name: "sparse_vector", values: sparseVectors },
        { name: "content", values: chunkTexts.map((t) => t.slice(0, 4096)) },
      ],
    });

    // 4. Save ChunkModel to PG
    const milvusIds = (mr.IDs as any)?.int_id?.data || [];
    for (let i = 0; i < chunkIds.length; i++) {
      await prisma.knowledgeChunk.create({
        data: {
          id: chunkIds[i],
          documentId: docId,
          knowledgeBaseId: kbId,
          chunkIndex: i,
          content: chunkTexts[i],
          tokenCount: chunkTexts[i].length,
          milvusId: milvusIds[i] ? BigInt(milvusIds[i]) : null,
        },
      });
    }
  }

  async deleteDocument(docId: string): Promise<boolean> {
    const doc = await prisma.knowledgeDocument.findUnique({ where: { id: docId } });
    if (!doc) return false;

    // Get milvus_ids for chunks
    const chunks = await prisma.knowledgeChunk.findMany({
      where: { documentId: docId },
      select: { milvusId: true },
    });
    const milvusIds = chunks.filter((c) => c.milvusId !== null).map((c) => Number(c.milvusId));

    // Delete from Milvus
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
        console.warn(`[knowledge] Milvus delete failed:`, e);
      }
    }

    // Delete from PG
    await prisma.knowledgeChunk.deleteMany({ where: { documentId: docId } });
    await prisma.knowledgeDocument.delete({ where: { id: docId } });

    console.log(`[knowledge] Document deleted: ${docId}, cleaned up ${milvusIds.length} vectors`);
    return true;
  }

  static async rebuildBM25Index(kbId: string): Promise<void> {
    const chunks = await prisma.knowledgeChunk.findMany({
      where: { knowledgeBaseId: kbId, enabled: true },
      select: { content: true },
    });
    const corpus = chunks.map((c) => c.content);
    if (corpus.length > 0) {
      const bm25 = getBM25();
      bm25.fit(corpus);
      console.log(`[bm25] Index rebuilt: kb=${kbId}, corpus=${corpus.length}`);
    }
  }
}

// ── Knowledge Base Seed Data ───────────────────────────────────

const DEFAULT_KB_ID = "kb-a00000-0000-0000-0000-00000000001";

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

export async function seedKnowledgeBase(): Promise<string> {
  // Check if already seeded
  const existing = await prisma.knowledgeBase.findUnique({
    where: { id: DEFAULT_KB_ID },
  });
  if (existing) {
    console.log("[seed] Knowledge base seed data already exists, skipping");
    return DEFAULT_KB_ID;
  }

  // Create knowledge base
  await prisma.knowledgeBase.create({
    data: {
      id: DEFAULT_KB_ID,
      name: "客服FAQ知识库",
      description: "默认客服常见问题知识库，包含退换货、物流、售后、会员、支付等FAQ",
    },
  });

  // Check embedding provider
  const provider = getDefaultEmbeddingProvider();
  if (!provider) {
    console.log("[seed] No embedding provider configured, skipping document vectorization");
    return DEFAULT_KB_ID;
  }

  // Ingest documents
  console.log(`[seed] Ingesting ${SAMPLE_FAQS.length} sample FAQ documents...`);
  try {
    const ingestion = new KnowledgeIngestionService();
    await ingestion.batchIngest(DEFAULT_KB_ID, SAMPLE_FAQS);
    console.log(`[seed] Seed data created: KB=${DEFAULT_KB_ID}, docs=${SAMPLE_FAQS.length}`);
  } catch (e) {
    console.warn(`[seed] Seed data vectorization failed (Milvus may not be running):`, e);
  }

  return DEFAULT_KB_ID;
}
