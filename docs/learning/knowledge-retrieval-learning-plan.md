# AgentForge 知识检索系统 —— 学习总结与计划

> 学习日期：2026-07-04  
> 学习方式：交互式教学 + 模拟面试  
> 更新记录：第二轮深入 Reranker 原理与实现

---

## 一、今日学习总结

### 1.1 覆盖的知识点

| 环节 | 核心内容 | 一轮 | 二轮 |
|------|---------|:----:|:----:|
| **向量化（Embedding）** | 文本 → 稠密向量，同一模型生成，同一向量空间 | ✅ | ✅ |
| **PGVector 语义检索** | 余弦相似度，查"意思相近"的 chunk | △ | ✅ |
| **ES 关键词检索** | BM25 + 倒排索引 + standard analyzer，查"字面匹配" | ✅ | ✅ |
| **ES vs PG 分工** | ES 只存搜索字段，PG 是元数据源头 + 向量存储 | ✅ | ✅ |
| **chunkId 桥梁** | 两条路都返回 chunkId，最终回 PG 查完整数据 | ✅ | ✅ |
| **RRF 融合** | `1/(k+rank)`，k=60，双路分数累加后重排 | △ | ✅ |
| **Bigram Jaccard 去重** | 字符二元组交集/并集，阈值 0.82 | △ | ✅ |
| **Reranker 模型原理** | Cross-Encoder, Self-Attention, [CLS]+Head+sigmoid | ✗ | ✅ |
| **Reranker 实现** | HTTP 客户端 → 独立 GPU 服务，三层降级，默认不启用 | ✗ | ✅ |
| **Hard Negatives** | 训练数据关键——看起来相关但答不了的样本 | ✗ | ✅ |

> 一轮 = 初次学习 / 二轮 = 本次深入回顾  
> ✅ 理解到位 / △ 有印象但需巩固 / ✗ 没记住

> 图例：✅ 理解到位 / △ 有印象但需巩固 / ✗ 没记住

### 1.2 完整检索数据流

```
用户 Query: "退换货需要什么条件？"
    │
    ├─→ provider.embed(query) ──→ PGVector 余弦相似度检索 ──→ [{chunkId, score}, ...]
    │                                                              │
    └─→ ES BM25 match 查询 ────→ [{chunkId, score}, ...]         │
                                     │                              │
                                     └──────────┬───────────────────┘
                                                │
                                          RRF 融合 (k=60)
                                         1/(60+rank) 累加
                                                │
                                         Bigram Jaccard 去重
                                          阈值: 0.82
                                                │
                                          Reranker 精排
                                    (query+chunk 一起读)
                                                │
                                     chunkId → PG 查完整元数据
                                                │
                                          返回最终结果
```

### 1.3 面试考察结果

**能答对的：**
- ES/PG 分工（ES 只做关键词检索，PG 管元数据）
- chunkId 作为检索结果与元数据的桥梁
- 去重阈值 0.82

**方向性错误：**
- 把 PGVector（语义检索）和 ES（关键词检索）的职责说反了

**完全没记住：**
- RRF 公式 `1/(k+rank)`
- Bigram Jaccard 算法名称
- Reranker 的本质区别（"分开算 vs 一起读"）

**核心短板：** 概念理解到位，但专业术语和公式记忆不牢，面试场景下会丢分。

---

## 二、关键概念速查

### 2.1 RRF（Reciprocal Rank Fusion）

```
RRF_score(chunk) = Σ 1 / (k + rank_i)

k = 60（常数）
rank_i = chunk 在第 i 条路上的排名（从 1 开始）
```

**示例：**

| chunkId | PGVector 排名 | ES 排名 | RRF 计算 | 最终分数 |
|---------|:-----------:|:-----:|---------|:-------:|
| chk-C | 2 | 1 | 1/62 + 1/61 | **0.0325** |
| chk-A | 1 | 3 | 1/61 + 1/63 | 0.0323 |
| chk-D | - | 2 | 0 + 1/62 | 0.0161 |
| chk-B | 3 | - | 1/63 + 0 | 0.0159 |

**核心思想：** 两条路都排名靠前的 chunk，RRF 分数自然高，融合后排名靠前。

### 2.2 Bigram Jaccard 去重

```
Bigram:   "退换货流程" → {"退换", "换货", "货流", "流程"}
Jaccard:  |A ∩ B| / |A ∪ B|
阈值:     0.82（可通过 KB_DEDUPE_SIMILARITY_THRESHOLD 环境变量调整）
```

**代码位置：** `apps/server/src/services/knowledge.ts`
- `computeTokenOverlap()` — 计算 Bigram Jaccard
- `toBigramSet()` — 生成字符二元组集合
- `dedupeAdjacentChunks()` — 去重主逻辑

**阈值含义：** Jaccard ≥ 0.82 意味着两个 chunk 的字符级重叠超过 82%，判定为近乎重复，只保留分数更高的那个。

### 2.3 Reranker vs PGVector

| 维度 | PGVector | Reranker |
|------|----------|----------|
| 比较方式 | 各自独立向量化，算余弦距离 | query + chunk 拼一起，模型通读 |
| 模型看到什么 | 向量，没见过 query 和 chunk 放一起 | 完整文本，理解语义关系 |
| 速度 | 快（可建索引） | 慢（每次都要推理） |
| 精度 | 粗糙 | 精准 |
| 适用范围 | 全库扫 | 仅精排候选集（几十条） |

**一句话区别：** PGVector 比的是"向量像不像"，Reranker 比的是"内容能不能回答"。

### 2.4 Reranker 深度原理：为什么 query+chunk 就能打分

#### Bi-Encoder vs Cross-Encoder（架构层面）

这是理解 Reranker 最关键的概念：

```
═══ Bi-Encoder（PGVector / Embedding） ═══

    Query                          Chunk-A
    "退换货条件"                    "退货需要7天内提供凭证"
       │                               │
       ▼                               ▼
   Encoder                          Encoder       ← 各自独立，互不影响
       │                               │
       ▼                               ▼
   [0.02, -0.45, ...]             [0.15, -0.33, ...]
       │                               │
       └──────────┬────────────────────┘
                  ▼
          cos_similarity(vec_q, vec_a) = 0.83

问题：Encoder 只看了各自文本，不知道对方在问什么/答什么。


═══ Cross-Encoder（Reranker） ═══

    Query + Chunk-A 拼成一句话
    ┌─────────────────────────────────────────────┐
    │ "退换货需要什么条件？[SEP] 退货需要7天内提供凭证"   │
    └─────────────────────────────────────────────┘
                       │
                       ▼
                   Reranker                     ← 同时看到 query 和 document
                       │
                       ▼
                 relevance_score = 0.92

优势：模型真正"理解了"这个 chunk 能不能回答这个 query。
```

#### 模型怎么输出分数（技术细节）

```
输入: "退换货需要什么条件？[SEP] 退货需要7天内提供凭证"
    │
    ▼
┌─────────────────────────────────────┐
│          BERT / 基座模型              │
│  (多层 Transformer，Self-Attention)   │
│                                     │
│  每一层都在让 query 和 chunk 彼此"对话" │
│  - "退换货" 和 "退货" 互相注意         │
│  - "条件" 和 "提供凭证" 互相注意       │
│  - 关键词之间的语义关系被逐层理解      │
│                                     │
│  输出: [CLS] token 的隐向量 h         │
│  (这个向量浓缩了整个句对的信息)         │
└─────────────────────────────────────┘
    │
    │  h = [0.23, -0.81, 0.45, ...]  (768维)
    ▼
┌──────────────────────┐
│   线性分类头 (Head)    │  ← 一个全连接层
│   y = sigmoid(W·h+b) │  ← sigmoid 压缩到 0~1
└──────────────────────┘
    │
    ▼
  relevance_score = 0.92
```

**关键点：** `[CLS]` 聚合了整句的全局信息。Self-Attention 中 query 和 chunk 的词会**直接互相计算注意力权重**：

```
"退换货" 看到 "退货" → 注意力权重 0.87  ← 强相关
"退换货" 看到 "凭证" → 注意力权重 0.42
"退换货" 看到 "满意" → 注意力权重 0.03  ← 无关，权重低
```

#### 训练数据：模型凭什么知道什么是"相关"

**正样本 (label=1, 相关):**
```
query: "退换货需要什么条件？"
chunk: "退换货申请需要在7天内提交，提供购买凭证和商品完好证明"
→ 模型学到：query 问"条件"，chunk 给出具体条件 → 高分
```

**负样本 (label=0, 不相关):**
```
query: "退换货需要什么条件？"
chunk: "我们提供最优质的客户服务，确保您的满意度"
→ 模型学到：看起来主题相关但实际没有回答问题 → 低分
```

**Hard Negatives（关键——让模型变聪明的数据）:**
```
Query: "退换货需要什么条件？"

Easy Negative: "北京市今天晴转多云"             → 模型秒学会打 0.01
Hard Negative: "退款将在7个工作日内原路返回"     → 需要分辨"退款 ≠ 退换货"
Hard Negative: "我们提供优质的客户服务"          → 需要分辨"相关话题 ≠ 回答了问题"
```

训练过程：几万条人工标注的 (query, chunk, label) → 交叉熵损失函数 → 梯度下降 → 模型逐渐逼近人类判断。

#### Reranker 为什么能消灭假阳性

| chunk | 内容 | PGVector | Reranker |
|-------|------|:--------:|:--------:|
| chk-A | "退换货申请需要在7天内提交，提供购买凭证..." | 0.87 | **0.92** ✅ |
| chk-B | "我们提供最优质的客户服务，确保您的满意度" | 0.81 | **0.05** ✗ |
| chk-C | "退款将在审核通过后7个工作日内原路返回" | 0.78 | **0.31** ✗ |

**PGVector 的问题：** "客户服务"和"退换货"在向量空间里相近（都是客服场景），但它不是答案。这就是 False Positive。

**Reranker 的解决：** 训练时大量注入 Hard Negatives，模型学会了分辨"看起来相关"和"真正能回答"。

#### 为什么不能只用 Reranker

```
PGVector: 扫 100,000 个 chunk → 10ms    ← 快，适合全库扫
Reranker: 扫 30 个 chunk → 200ms        ← 慢，每次都要模型推理

全库 Rerank: 100,000 × 200ms = 不现实
```

所以架构是**两级漏斗**：

```
全库 100,000 chunks
    │
    ▼ PGVector + ES 粗筛（快：~10ms）
    │
30 个候选 (topK*5 召回，去重后约 20-30 条)
    │
    ▼ Reranker 精排（慢：~200ms，但只有 30 条）
    │
5 条最终结果
```

### 2.5 Reranker 代码实现

#### 架构：独立 HTTP 服务

Reranker 不在 Node.js 进程内，是一个独立部署的 GPU 推理服务：

```
┌──────────────────────────────────┐
│  AgentForge Server (Node.js)     │
│  reranker.ts  ← HTTP 客户端(116行) │
│  POST /rerank ──────────────────►│
└──────────────────────────────────┘
                  │ HTTP
                  ▼
┌──────────────────────────────────┐
│  Reranker 服务 (独立部署)          │
│  FastAPI / vLLM / TGI            │
│  加载模型: bge-reranker-v2-m3    │
│  GPU 推理                        │
└──────────────────────────────────┘
```

#### 配置

```typescript
// config.ts
rerankerBaseUrl: process.env.RERANKER_BASE_URL || "",  // 如 http://localhost:8080
rerankerModel: process.env.RERANKER_MODEL || "",       // 如 bge-reranker-v2-m3
```

```bash
# .env.example（默认为空，不启用）
RERANKER_BASE_URL=
RERANKER_MODEL=
```

#### 请求/响应格式

**请求体：**
```json
{
  "model": "bge-reranker-v2-m3",
  "query": "退换货需要什么条件？",
  "documents": [
    { "text": "退换货申请需要在7天内...", "id": "chk-A" },
    { "text": "物流配送通常需要3-5天...", "id": "chk-B" }
  ],
  "topK": 5
}
```

**响应体：**
```json
{
  "results": [
    { "index": 0, "relevance_score": 0.92 },
    { "index": 1, "relevance_score": 0.15 }
  ]
}
```

兼容三套主流 Reranker API：Cohere（`relevance_score`）、BAAI bge-reranker、Jina（`score`）。

#### 三层降级保护

| 场景 | 处理方式 |
|------|---------|
| 环境变量没配 `RERANKER_BASE_URL` | `isConfigured()` 返回 false，跳过，用 RRF 分数 |
| HTTP 请求失败 / 超时（5s AbortController） | catch 后 `return []`，上层用 RRF 分数 |
| 响应结果为空数组 | 用 RRF 分数 |

任何环节出问题都不阻塞主链路，静默回退到 RRF 分数——graceful degradation。

#### 默认不启用

`.env.example` 中 `RERANKER_BASE_URL` 和 `RERANKER_MODEL` 均为空，开发环境默认链路：

```
query → PGVector + ES → RRF 融合 → Bigram Jaccard 去重 → 返回 ✅
                                                          ↓
                                              Reranker ❌ (没配，跳过)
```

如需开启，需自行部署 Reranker 服务并填入环境变量。

---

## 三、针对性学习计划

### 第一轮：巩固今天的内容（约 30 分钟）

| 步骤 | 内容 | 目标 |
|:----:|------|------|
| 1 | 手写完整检索流程图（从 query 进来到结果返回） | 理顺各环节顺序，不再搞反 PGVector/ES |
| 2 | 默写 RRF 公式 `1/(k+rank)`，k=60 | 公式刻进肌肉记忆 |
| 3 | 默写 Bigram Jaccard = 交集/并集，阈值 0.82 | 会算会解释 |
| 4 | 用一句话说清 Reranker 和 PGVector 的区别 | "分开算 vs 一起读" |

**关键文件复习：**
- `apps/server/src/services/knowledge.ts` — RRF 融合、去重、Reranker、混合检索主流程
- `apps/server/src/services/elasticsearch.ts` — ES 索引结构和 BM25 搜索
- `apps/server/src/services/knowledge-ingestion.ts` — chunk 入库（embedding + PGVector + ES 索引）

### 第二轮：知识图谱检索（约 1 小时）

| 内容 | 文件 | 学习重点 |
|------|------|---------|
| 图谱构建 | `services/graph-extraction.ts` | LLM 抽取实体/关系 → Neo4j + PG 双写 |
| 图谱查询 | `services/graph-retrieval.ts` | query → LLM 抽实体 → Neo4j 1-3 跳遍历 → 推理链路 |
| Neo4j 操作 | `services/neo4j.ts` | MERGE 幂等写入、Cypher 变长路径查询、约束/索引 |
| 上下文注入 | `services/agent-runtime/knowledge-context.ts` | 图谱推理链格式化为 Markdown 注入 Prompt |

**学习目标：**
- [ ] 理解 LLM 怎么从文档中抽实体和关系（System Prompt + json_mode）
- [ ] 理解 Neo4j 的 MERGE 怎么写（ON CREATE / ON MATCH）
- [ ] 理解 `MATCH path = (start)-[rels:REL*1..3]->(end:Entity)` 的变长路径语法
- [ ] 理解图谱检索结果怎么变成 Prompt 里的 Markdown

### 第三轮：Agent Runtime 全链路（约 1 小时）

| 内容 | 学习重点 |
|------|---------|
| 4-route 分类器 | SAFETY / CHAT / TASK / HUMAN 四种路由的职责和分流逻辑 |
| ReAct 循环 | Thought → Action → Observation 的迭代过程 |
| 工具调用 | `search_knowledge_base` 工具怎么被 Agent 调用 |
| 最终 Prompt 组装 | RAG 结果 + 图谱推理链 + Memory → 完整 System Prompt |

**关键文件：**
- `apps/server/src/services/agent-runtime/` — Agent 执行器核心
- `docs/runtime/execution-runtime-v1.md` — Runtime 架构文档
- `docs/architecture/overview.md` — 整体架构概览

---

## 四、面试话术模板

### Q: 你们的混合检索是怎么做的？

> 我们用了多路召回 + 融合重排的架构。用户的 query 同时走两条路：PGVector 做语义检索，通过 embedding 向量算余弦相似度；Elasticsearch 做关键词检索，用 BM25 匹配。两条路返回的 chunkId 用 RRF 公式 `1/(k+rank)` 融合，k 取 60。然后 Bigram Jaccard 去重，阈值 0.82，去掉字面高度重叠的 chunk。最后过 Reranker 精排——它把 query 和每个 chunk 拼在一起让模型通读打分，比 PGVector 只看向量的方式精准很多。

### Q: RRF 的 k=60 是什么意思？

> k 是调节因子，放在分母里防止小 rank 的分数差距过大。比如 k=60 时，rank 1 和 rank 2 的分数分别是 1/61 和 1/62，差距很小。如果 k=0，那就是 1/1 和 1/2，第一名分数是第二名的两倍，对排名太敏感了。学术界推荐 60，我们沿用这个值。

### Q: 为什么有了 PGVector 还要 Reranker？

> PGVector 是 Bi-Encoder——query 和 chunk 各自独立编码成向量，再算余弦距离。模型没真正"读"过两者放在一起的内容，所以会出现假阳性（向量相近但实际不相关）。Reranker 是 Cross-Encoder——把 query 和每个候选 chunk 拼在一起让模型通读，通过 Self-Attention 让两者互相"看见"，再用 [CLS] + 线性分类头输出精确的相关性分数。代价是速度慢，所以我们只对 RRF 融合后的候选集（几十条）做 Reranker，不全库扫。

### Q: Reranker 的分数是怎么来的？

> Cross-Encoder 底层是 BERT 架构。输入 `query [SEP] chunk`，经过多层 Transformer 的 Self-Attention，query 和 chunk 中的词直接互相计算注意力权重。第一层拿到的 [CLS] token 隐向量浓缩了整句信息，过一层线性分类头（全连接层），接 sigmoid 压缩到 0~1。这个 0~1 的值就是 relevance_score。模型的能力来自训练数据——几万条人工标注的 (query, chunk, 相关/不相关) 样本，关键是用大量 Hard Negatives（看起来相关但实际答不了）来训练，模型才学会分辨假阳性。

### Q: Reranker 在代码里是怎么实现的？

> AgentForge 只负责一个 116 行的 HTTP 客户端（`reranker.ts`），真正的模型推理在独立 GPU 服务上（FastAPI/vLLM/TGI）。POST /rerank 发 query + documents[]，收到 `[{index, relevance_score}]` 后按分数重排。默认不启用（`RERANKER_BASE_URL` 为空），三层降级保护：没配→跳过、HTTP 失败→回退、返回空→回退。所有异常静默回退到 RRF 分数，不阻塞主链路。

---

## 五、知识点快速自查卡

| 问题 | 答案 |
|------|------|
| PGVector 做什么检索？ | **语义检索**（向量余弦相似度） |
| ES 做什么检索？ | **关键词检索**（BM25） |
| RRF 公式？ | `1/(60 + rank)` |
| RRF k 值？ | **60** |
| 去重算法？ | **Bigram Jaccard** |
| 去重阈值？ | **0.82** |
| 阈值环境变量？ | `KB_DEDUPE_SIMILARITY_THRESHOLD` |
| Bi-Encoder vs Cross-Encoder？ | Bi: 各自独立编码后算距离 / Cross: 拼一起通读打分 |
| Reranker 核心区别？ | **分开算 vs 一起读** |
| Reranker 模型架构？ | BERT + [CLS] 隐向量 + 线性分类头 + sigmoid |
| Cross-Encoder 关键机制？ | Self-Attention 让 query 和 chunk 的词互相直接看见 |
| 分数怎么从模型输出？ | [CLS] h(768维) → W·h+b → sigmoid → 0~1 |
| Hard Negatives 是什么？ | 看起来相关但实际不能回答的样本，训练模型分辨假阳性 |
| PGVector vs Reranker 速度？ | PGVector 快（全库），Reranker 慢（仅候选集） |
| Reranker 实现方式？ | HTTP POST /rerank → 独立 GPU 推理服务 |
| Reranker 默认启用吗？ | **不启用**，RERANKER_BASE_URL 默认为空 |
| Reranker 降级策略？ | 未配/请求失败/返回空 → 静默回退到 RRF 分数 |
| Reranker 兼容哪些 API？ | Cohere (`relevance_score`) / Jina (`score`) / BAAI |
| ES 存完整元数据吗？ | **不存**，只存搜索字段，PG 是数据源头 |
| 两条路谁先谁后？ | **并行**，同时跑，结果 RRF 融合 |
| 完整链路？ | Query → PGVector+ES 并行 → RRF → Bigram 去重 → Reranker → PG 元数据
