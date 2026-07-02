// KnowledgeIngestionService tests — V3.5: 验证摄入不再依赖 Milvus 和 inverted-index
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock 工厂被提升到文件顶部，因此所有 mock 对象必须使用 vi.hoisted()
const {
  mockPrisma,
  mockEmbed,
  mockMilvusInsert,
  mockMilvusDelete,
  mockEnsureKnowledgeCollection,
} = vi.hoisted(() => ({
  mockPrisma: {
    knowledgeChunk: {
      create: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    knowledgeDocument: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    knowledgeInvertedIndex: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    $executeRawUnsafe: vi.fn(),
  },
  mockEmbed: vi.fn(),
  mockMilvusInsert: vi.fn(),
  mockMilvusDelete: vi.fn(),
  mockEnsureKnowledgeCollection: vi.fn(),
}));

vi.mock("../../db.js", () => ({ prisma: mockPrisma }));

vi.mock("../embeddings.js", () => ({
  getDefaultEmbeddingProvider: vi.fn(() => ({
    modelName: "test-model",
    embed: mockEmbed,
  })),
}));

vi.mock("../tokenizer.js", () => ({
  tokenize: vi.fn(() => ["test", "token"]),
}));

vi.mock("../embedding-tokenizer.js", () => ({
  countEmbeddingTokens: vi.fn(() => 42),
}));

vi.mock("../elasticsearch.js", () => ({
  bulkIndexDocuments: vi.fn(),
  deleteByDocumentIds: vi.fn(),
  isESAvailable: vi.fn(() => false),
  ensureKnowledgeIndex: vi.fn(),
}));

vi.mock("../milvus.js", () => ({
  getMilvusClient: vi.fn(() => ({
    insert: mockMilvusInsert,
    delete: mockMilvusDelete,
  })),
  MILVUS_KNOWLEDGE_COLLECTION: "knowledge_collection",
  ensureKnowledgeCollection: mockEnsureKnowledgeCollection,
}));

vi.mock("../../config.js", () => ({
  settings: {
    kbChunkSizeTokens: 512,
    kbChunkOverlapTokens: 50,
    kbChildChunkSizeTokens: 400,
    kbChildChunkOverlapTokens: 60,
  },
}));

vi.mock("../agent-runtime/citation-verifier.js", () => ({
  invalidateCitationCache: vi.fn(),
}));

vi.mock("@agentforge/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { KnowledgeIngestionService } from "../knowledge-ingestion.js";
import { prisma } from "../../db.js";
import { bulkIndexDocuments, ensureKnowledgeIndex, isESAvailable } from "../elasticsearch.js";

describe("KnowledgeIngestionService — ingestChunks", () => {
  let service: KnowledgeIngestionService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new KnowledgeIngestionService();
    // 预计算 embedding：根据输入动态生成 N 个 1024 维向量
    mockEmbed.mockImplementation(async (texts: string[]) =>
      texts.map(() =>
        Array.from({ length: 1024 }, () => Math.random() * 2 - 1),
      ),
    );
    // mock doc title for ES
    mockPrisma.knowledgeDocument.findUnique.mockResolvedValue({ title: "Test Doc" });
    // mock updateDocumentStatus
    mockPrisma.knowledgeDocument.update.mockResolvedValue({});
    // mock chunk create
    mockPrisma.knowledgeChunk.create.mockResolvedValue({});
    // mock raw SQL
    mockPrisma.$executeRawUnsafe.mockResolvedValue(1);
  });

  describe("Milvus-free ingestion", () => {
    it("不应在摄入期间调用 Milvus insert", async () => {
      await (service as any).ingestChunks("doc-1", "kb-1", ["chunk-a", "chunk-b"]);

      expect(mockMilvusInsert).not.toHaveBeenCalled();
    });

    it("不应在摄入期间调用 ensureKnowledgeCollection", async () => {
      await (service as any).ingestChunks("doc-1", "kb-1", ["chunk-a", "chunk-b"]);

      expect(mockEnsureKnowledgeCollection).not.toHaveBeenCalled();
    });

    it("创建的 chunk 不应包含 milvusId 字段", async () => {
      await (service as any).ingestChunks("doc-1", "kb-1", ["chunk-a", "chunk-b"]);

      const createCalls = mockPrisma.knowledgeChunk.create.mock.calls;
      expect(createCalls.length).toBeGreaterThanOrEqual(1);

      for (const call of createCalls) {
        const data = call[0].data;
        expect(data).not.toHaveProperty("milvusId");
        expect(data).toHaveProperty("id");
        expect(data).toHaveProperty("documentId", "doc-1");
        expect(data).toHaveProperty("knowledgeBaseId", "kb-1");
        expect(data).toHaveProperty("content");
        expect(data).toHaveProperty("tokenCount");
      }
    });
  });

  describe("No inverted-index writes", () => {
    it("不应在摄入期间写入 knowledgeInvertedIndex", async () => {
      await (service as any).ingestChunks("doc-1", "kb-1", ["chunk-a", "chunk-b"]);

      expect(mockPrisma.knowledgeInvertedIndex.createMany).not.toHaveBeenCalled();
    });
  });

  describe("PGVector + ES writes preserved", () => {
    it("应继续写入 PGVector embedding", async () => {
      await (service as any).ingestChunks("doc-1", "kb-1", ["chunk-a"]);

      expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalled();
      const rawCalls = mockPrisma.$executeRawUnsafe.mock.calls;
      const vectorUpdates = rawCalls.filter(
        (call: unknown[]) =>
          typeof call[0] === "string" && (call[0] as string).includes("SET embedding"),
      );
      expect(vectorUpdates.length).toBeGreaterThanOrEqual(1);
    });

    it("应继续写入 ES 索引（ES 可用时）", async () => {
      (isESAvailable as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);

      await (service as any).ingestChunks("doc-1", "kb-1", ["chunk-a", "chunk-b"]);

      expect(ensureKnowledgeIndex).toHaveBeenCalled();
      expect(bulkIndexDocuments).toHaveBeenCalled();
      const esDocs = (bulkIndexDocuments as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(esDocs).toHaveLength(2);
      expect(esDocs[0]).toHaveProperty("chunkId");
      expect(esDocs[0]).toHaveProperty("kbId", "kb-1");
      expect(esDocs[0]).toHaveProperty("content", "chunk-a");
    });

    it("应在 ES 不可用时优雅降级（不抛异常）", async () => {
      (isESAvailable as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

      await expect(
        (service as any).ingestChunks("doc-1", "kb-1", ["chunk-a"]),
      ).resolves.toBeUndefined();

      expect(bulkIndexDocuments).not.toHaveBeenCalled();
    });
  });

  describe("层次分块路径", () => {
    it("子分块应通过 childParentMap 映射到父分块（不含 milvusId）", async () => {
      const childParentMap = new Map<number, string>();
      childParentMap.set(0, "parent-id-1");
      childParentMap.set(1, "parent-id-1");
      childParentMap.set(2, "parent-id-2");

      await (service as any).ingestChunks(
        "doc-1",
        "kb-1",
        ["child-a", "child-b", "child-c"],
        "text",
        "good",
        childParentMap,
      );

      const createCalls = mockPrisma.knowledgeChunk.create.mock.calls;
      expect(createCalls).toHaveLength(3);
      // 验证父分块映射
      expect(createCalls[0][0].data.parentChunkId).toBe("parent-id-1");
      expect(createCalls[1][0].data.parentChunkId).toBe("parent-id-1");
      expect(createCalls[2][0].data.parentChunkId).toBe("parent-id-2");
      // 验证不含 milvusId
      for (const call of createCalls) {
        expect(call[0].data).not.toHaveProperty("milvusId");
      }
    });
  });
});

describe("KnowledgeIngestionService — deleteDocument (历史清理保留)", () => {
  let service: KnowledgeIngestionService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new KnowledgeIngestionService();
  });

  it("新文档（无 milvusId）删除时不应调用 Milvus delete", async () => {
    mockPrisma.knowledgeDocument.findUnique.mockResolvedValue({
      id: "doc-new",
      knowledgeBaseId: "kb-1",
      title: "New Doc",
    });
    mockPrisma.knowledgeChunk.findMany.mockResolvedValue([
      { id: "chunk-1", milvusId: null },
      { id: "chunk-2", milvusId: null },
    ]);
    mockPrisma.knowledgeInvertedIndex.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.knowledgeChunk.deleteMany.mockResolvedValue({ count: 2 });
    mockPrisma.knowledgeDocument.delete.mockResolvedValue({});

    await service.deleteDocument("doc-new");

    // milvusIds 应为空，所以 delete 不应被调用
    expect(mockMilvusDelete).not.toHaveBeenCalled();
  });

  it("历史文档（有 milvusId）删除时应继续清理 Milvus", async () => {
    mockPrisma.knowledgeDocument.findUnique.mockResolvedValue({
      id: "doc-old",
      knowledgeBaseId: "kb-1",
      title: "Old Doc",
    });
    mockPrisma.knowledgeChunk.findMany.mockResolvedValue([
      { id: "chunk-1", milvusId: BigInt(1001) },
      { id: "chunk-2", milvusId: BigInt(1002) },
    ]);
    mockPrisma.knowledgeInvertedIndex.deleteMany.mockResolvedValue({ count: 10 });
    mockPrisma.knowledgeChunk.deleteMany.mockResolvedValue({ count: 2 });
    mockPrisma.knowledgeDocument.delete.mockResolvedValue({});

    await service.deleteDocument("doc-old");

    // 历史数据的 Milvus 清理应继续工作
    expect(mockEnsureKnowledgeCollection).toHaveBeenCalled();
    expect(mockMilvusDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        collection_name: "knowledge_collection",
        filter: expect.stringContaining("1001"),
      }),
    );

    // 倒排索引清理应继续工作
    expect(mockPrisma.knowledgeInvertedIndex.deleteMany).toHaveBeenCalledWith({
      where: { chunkId: { in: ["chunk-1", "chunk-2"] } },
    });
  });
});
