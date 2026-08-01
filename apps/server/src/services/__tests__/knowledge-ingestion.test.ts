// KnowledgeIngestionService tests — V3.5: 验证摄入不依赖 Milvus 和 inverted-index
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock 工厂被提升到文件顶部，因此所有 mock 对象必须使用 vi.hoisted()
const {
  mockPrisma,
  mockEmbed,
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
    $executeRawUnsafe: vi.fn(),
  },
  mockEmbed: vi.fn(),
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
    it("子分块应通过 childParentMap 映射到父分块", async () => {
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
    });
  });
});

describe("KnowledgeIngestionService — deleteDocument", () => {
  let service: KnowledgeIngestionService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new KnowledgeIngestionService();
  });

  it("删除文档时应清理 PG chunks 和 ES 索引", async () => {
    mockPrisma.knowledgeDocument.findUnique.mockResolvedValue({
      id: "doc-1",
      knowledgeBaseId: "kb-1",
      title: "Test Doc",
    });
    mockPrisma.knowledgeChunk.findMany.mockResolvedValue([
      { id: "chunk-1" },
      { id: "chunk-2" },
    ]);
    mockPrisma.knowledgeChunk.deleteMany.mockResolvedValue({ count: 2 });
    mockPrisma.knowledgeDocument.delete.mockResolvedValue({});

    await service.deleteDocument("doc-1");

    // 验证 PG chunk 删除
    expect(mockPrisma.knowledgeChunk.findMany).toHaveBeenCalledWith({
      where: { documentId: "doc-1" },
      select: { id: true },
    });
    expect(mockPrisma.knowledgeChunk.deleteMany).toHaveBeenCalled();
    expect(mockPrisma.knowledgeDocument.delete).toHaveBeenCalled();
  });
});
