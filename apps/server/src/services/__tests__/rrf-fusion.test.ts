// RRF (Reciprocal Rank Fusion) 融合算法单元测试
// 覆盖场景：正常双路融合、单路结果、空结果、去重、稳定排序、边界条件

import { describe, it, expect } from "vitest";
import { rrfFusion } from "../knowledge.js";
import type { RawCandidate } from "../knowledge.js";

// 测试辅助：创建模拟的 RawCandidate
function makeCandidate(
  chunkId: string,
  source: "pgvector" | "elasticsearch",
  sourceScore: number,
): RawCandidate {
  return {
    chunkId,
    docId: `doc-${chunkId}`,
    kbId: "kb-test",
    content: `Content of ${chunkId}`,
    docTitle: `Title ${chunkId}`,
    chunkIndex: 0,
    sourceScore,
    source,
  };
}

describe("rrfFusion", () => {
  it("应该正确融合双路召回结果并去重", () => {
    // A 在两边都排第一 → RRF 分数最高
    const dense: RawCandidate[] = [
      makeCandidate("A", "pgvector", 0.9),
      makeCandidate("B", "pgvector", 0.8),
      makeCandidate("C", "pgvector", 0.7),
    ];

    const sparse: RawCandidate[] = [
      makeCandidate("A", "elasticsearch", 5.0),
      makeCandidate("D", "elasticsearch", 4.0),
      makeCandidate("B", "elasticsearch", 3.0),
    ];

    const result = rrfFusion(dense, sparse, 10);

    // A 在两个列表中都排第一 → RRF 分数 = 1/(60+1) + 1/(60+1) ≈ 0.0328
    expect(result[0].chunkId).toBe("A");
    expect(result[0].recallSources).toContain("pgvector");
    expect(result[0].recallSources).toContain("elasticsearch");

    // B 在 dense 排第二 + sparse 排第三 → RRF = 1/(60+2) + 1/(60+3)
    expect(result[1].chunkId).toBe("B");

    // 验证有 4 个唯一结果
    expect(result).toHaveLength(4);
  });

  it("应该正确处理只有一路结果（ES 不可用场景）", () => {
    const dense: RawCandidate[] = [
      makeCandidate("X", "pgvector", 0.9),
      makeCandidate("Y", "pgvector", 0.8),
      makeCandidate("Z", "pgvector", 0.5),
    ];

    const result = rrfFusion(dense, [], 10);

    // 只用 PGVector 排序，按 RRF 分数（rank 1, 2, 3）
    expect(result).toHaveLength(3);
    expect(result[0].chunkId).toBe("X");
    expect(result[1].chunkId).toBe("Y");
    expect(result[2].chunkId).toBe("Z");
    expect(result[0].recallSources).toEqual(["pgvector"]);
  });

  it("应该正确处理 PGVector 无结果只有 ES 有结果", () => {
    const sparse: RawCandidate[] = [
      makeCandidate("M", "elasticsearch", 8.0),
      makeCandidate("N", "elasticsearch", 6.0),
    ];

    const result = rrfFusion([], sparse, 10);

    expect(result).toHaveLength(2);
    expect(result[0].chunkId).toBe("M");
    expect(result[1].chunkId).toBe("N");
    expect(result[0].recallSources).toEqual(["elasticsearch"]);
  });

  it("两路都为空时返回空数组", () => {
    const result = rrfFusion([], [], 10);
    expect(result).toEqual([]);
  });

  it("应该按 RRF 分数降序排列（排名靠前的结果融合分数更高）", () => {
    const dense: RawCandidate[] = [
      makeCandidate("P1", "pgvector", 0.95),
      makeCandidate("P2", "pgvector", 0.4),
    ];

    const sparse: RawCandidate[] = [
      makeCandidate("P1", "elasticsearch", 7.0),
      makeCandidate("P2", "elasticsearch", 6.0),
    ];

    const result = rrfFusion(dense, sparse, 10);

    // P1 在两个列表都排第一 → RRF 最高
    expect(result[0].chunkId).toBe("P1");
    expect(result[0].fusionScore).toBeGreaterThan(result[1].fusionScore);

    // P2 在两个列表都排第二
    expect(result[1].chunkId).toBe("P2");
  });

  it("应该尊重 topK 参数限制返回数量", () => {
    const dense: RawCandidate[] = Array.from({ length: 10 }, (_, i) =>
      makeCandidate(`D${i}`, "pgvector", 1 - i * 0.1),
    );

    const sparse: RawCandidate[] = Array.from({ length: 10 }, (_, i) =>
      makeCandidate(`S${i}`, "elasticsearch", 10 - i),
    );

    const result = rrfFusion(dense, sparse, 5);

    // 20 个候选去重后可能有 20 个，但只返回 topK=5
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it("单路结果的 RRF 分数应随排名单调递减", () => {
    const dense: RawCandidate[] = Array.from({ length: 5 }, (_, i) =>
      makeCandidate(`E${i}`, "pgvector", 1 - i * 0.2),
    );

    const result = rrfFusion(dense, [], 10);

    // 验证 RRF 分数递减
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].fusionScore).toBeGreaterThanOrEqual(
        result[i].fusionScore,
      );
    }
  });

  it("跨路重叠的结果应标记双来源", () => {
    const dense: RawCandidate[] = [
      makeCandidate("shared", "pgvector", 0.9),
    ];
    const sparse: RawCandidate[] = [
      makeCandidate("shared", "elasticsearch", 8.0),
      makeCandidate("only_es", "elasticsearch", 7.0),
    ];

    const result = rrfFusion(dense, sparse, 10);

    const shared = result.find((r) => r.chunkId === "shared");
    expect(shared?.recallSources).toHaveLength(2);
    expect(shared?.recallSources).toContain("pgvector");
    expect(shared?.recallSources).toContain("elasticsearch");

    const onlyEs = result.find((r) => r.chunkId === "only_es");
    expect(onlyEs?.recallSources).toEqual(["elasticsearch"]);
  });

  it("大量候选时应保持稳定排序", () => {
    const dense: RawCandidate[] = Array.from({ length: 50 }, (_, i) =>
      makeCandidate(`bigD${i}`, "pgvector", Math.random()),
    );
    const sparse: RawCandidate[] = Array.from({ length: 50 }, (_, i) =>
      makeCandidate(`bigS${i}`, "elasticsearch", Math.random() * 10),
    );

    const result = rrfFusion(dense, sparse, 30);

    expect(result.length).toBeLessThanOrEqual(30);
    // 验证分数降序
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].fusionScore).toBeGreaterThanOrEqual(
        result[i].fusionScore,
      );
    }
  });
});
