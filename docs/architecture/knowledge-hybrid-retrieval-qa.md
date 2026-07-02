# Knowledge Base Hybrid Retrieval — 问答实录

> 2026-07-01，以师生对话方式逐层拆解 AgentForge 知识库的完整数据链路——从"为什么"到"怎么做"到"代码怎么写的"。

---

## 第一课：为什么需要混合检索？

**老师：** 先忘掉所有技术名词，我们从一个场景出发。假设你有一个客服知识库，里面有一篇文档叫《退换货政策》，内容是：

> 自收到商品之日起7天内，您可以申请无理由退货。退货时请确保商品完好，并附上购买凭证。

现在用户问了一句：**"我买了东西不满意怎么退？"**

两种找答案的方式：

**方式A — 语义搜索（Semantic Search）：** 把问题和所有文档都"翻译"成数字向量，然后比对这些向量，找到"意思最接近"的那几条。这就像你问一个老员工："客人想退货怎么办？"——老员工不会逐字匹配，但他能听懂你的意思，指给你正确的文档。

**方式B — 关键词搜索（Keyword Search / BM25）：** 统计每个词在文档里出现的频率和重要性。这就像你用 Ctrl+F 搜"退"字——很直接，但如果用户问的是"不满意怎么办"，而文档里写的却是"退换货政策"，没有"不满意"这三个字，关键词搜索就抓瞎了。

| | 语义搜索 | 关键词搜索 |
|---|---|---|
| 优点 | 懂意思，换个说法也能找到 | 精确匹配，不会漏掉专有名词 |
| 缺点 | 可能把不相关的也召回 | 换个说法就找不到了 |

**混合检索（Hybrid Retrieval）就是要同时用两种方式，取长补短。**

---

## 第二课：两条管线的分工

**老师：** 整个系统可以分为两条独立的"流水线"，各干各的事，时间上互不相关。

**"存"——摄入管线（Ingestion Pipeline）：** 你上传一篇文档 → 系统把它加工好 → 存进多个仓库，方便将来检索。这条管线只在**上传文档时跑一次**。

**"取"——检索管线（Retrieval Pipeline）：** 用户问一个问题 → 系统同时查多个仓库 → 把结果合并排序 → 返回最相关的几条。这条管线在**每次搜索时都跑**。

| | 摄入管线 | 检索管线 |
|---|---|---|
| 干什么 | 买书→分类→贴标签→上架 | 读者问→查目录→找书→递给读者 |
| 什么时候跑 | 有新书来的时候（偶发） | 有读者来问的时候（频繁） |
| 谁负责 | `knowledge-ingestion.ts` | `knowledge.ts` |
| 关键存储 | PG + ES + MinIO | PG + ES（只读，不改） |

**一个关键设计——漏斗：**

```
25 条（粗筛）→ 15 条（去重）→ 5 条（精排）
```

为什么这么设计？因为第一步要多捞一些，宁可捞多了别漏掉；后面几步再逐步挑出最好的。就好像你找简历，先搜到 25 份相关简历，快速筛掉重复的剩 15 份，再仔细读挑出最好的 5 份。

> **学生：** 我消化好了。
>
> **老师：** 好，我们进入第三课。

---

## 第三课：解析器系统 — 不同格式怎么提取文本

**学生：** 分开讨论，先从摄入管线开始，你是如何解析文本的？如果上传的是 markdown、pdf、excel，不同格式的文件你是如何处理的？

**老师：** 系统不是用一个巨大的 `if/else` 来判断文件类型的，而是用了一个**策略模式（插件注册表）**：

```
上传文件
  │
  ▼
ParserRegistry.getParser({ filename, mimeType })
  │
  ├─ 遍历所有注册的解析器
  ├─ 每个解析器说 "我能处理吗？"（canHandle）
  ├─ 按优先级排序（高优先级的先匹配到就抢走）
  └─ 返回 1 个匹配的解析器
```

注册的解析器及优先级（`document-parser/index.ts`）：

```
PDFParser     (优先级 50) ← 最高
WordParser    (优先级 40)
ImageParser   (优先级 30)
VideoParser   (优先级 25)
AudioParser   (优先级 20)
TextParser    (优先级 10) ← 最低，兜底
```

核心逻辑在 `registry.ts`——找到所有声称能处理的解析器，取优先级最高的那个：

```ts
getParser(file: FileMeta): DocumentParser | undefined {
  return this.parsers
    .filter((p) => p.canHandle(file))
    .sort((a, b) => b.priority - a.priority)[0];
}
```

### Markdown / TXT / CSV / JSON / HTML / XML / YAML / LOG

**解析器：`TextParser`（优先级 10）**——这些格式本身就是纯文本，处理极简：

```ts
async parse(buffer: Buffer): Promise<ParsedDocument> {
  const text = buffer.toString("utf-8");       // 直接把字节流转成字符串
  return {
    text,
    metadata: { charCount: text.length, parserName: "text" },
  };
}
```

没有任何解析、没有任何结构提取。Markdown 源码原样保留，给后续环节处理。

> **关于 Excel：** `.xlsx` / `.xls` **目前没有专用解析器**。`.csv` 可以当文本直接读（但读出来的是逗号分隔的原始数据），`.xlsx` 则会上报"无法识别文件类型"。这不是架构的限制，只是还没实现——后续可以加一个 `ExcelParser` 注册进来，优先级设在 35 左右即可。

### PDF

**解析器：`PdfParser`（优先级 50）**——使用 `unpdf` 库（底层是 Mozilla 的 `pdfjs-dist`，和 Firefox 浏览器里用的 PDF 引擎是同一个）：

```ts
const { extractText } = await import("unpdf");
const raw = await extractText(new Uint8Array(buffer), { mergePages: true });
text = raw.text;        // 合并所有页的文本
totalPages = raw.totalPages;
```

PDF 可能出的问题也做了分类处理：
- 加密 PDF → 抛出 "PDF 已加密，请上传未设置密码保护的版本"
- 损坏的 PDF → 抛出 "PDF 文件已损坏或格式无效"
- 其他错误 → 包装成中文错误信息抛出

### Word（.docx）

**解析器：`WordParser`（优先级 40）**——使用 `mammoth` 库，把 Word 文档转换成 **Markdown**。做了两件事：

**① 文本转换：** Word 的排版（标题、粗体、表格、列表）→ 等效的 Markdown 语法。

**② 图片提取：** 文档里内嵌的图片被提取出来，但在文本里只放一个占位符 `{{ASSET:xxx}}`。后续在上传到 MinIO 时，占位符会被替换成真正的 URL：

```
{{ASSET:uuid-123}}  →  ![图片](https://minio/agentforge-docs/doc-xxx/uuid-123.png)
```

这样做是因为图片本身不能做语义搜索，但图片的 alt text 和上下文可以被检索到，而且 MinIO URL 可以用在多模态场景里。

### 总结

| 格式 | 解析器 | 用的库 | 怎么处理 | 输出 |
|------|--------|--------|---------|------|
| `.md` `.txt` `.csv` `.json` `.html` 等 | TextParser | 无 | `buffer.toString("utf-8")` | 原始文本 |
| `.pdf` | PdfParser | unpdf / pdfjs-dist | 提取每一页文字后合并 | 纯文本 + 页数 |
| `.docx` | WordParser | mammoth | 转成 Markdown，图片→占位符 | Markdown + 资产列表 |
| `.xlsx` | ❌ 暂无 | — | 会报"无法识别文件类型" | — |

**核心设计原则：** 所有解析器的输出都是同一个类型 `{ text: string }`。无论输入是什么格式，输出都是一个文本字符串。这让后面的 Normalizer 和 Splitter 不需要关心文件是怎么来的，它们只面对纯文本。

> **学生：** 所以我理解就是调用不同的库，针对不同格式的文件解析出文本信息咯。
>
> **老师：** 对，本质就是这样。每一个解析器只负责一件事——**把特定格式变成纯文本**。不管输入是什么，输出永远是同一个接口，后面的环节不需要知道这文本是从哪儿来的。

---

## 第四课：Normalizer — 文本清洗

**老师：** 解析器吐出来的文本往往很"脏"，比如 PDF 里可能有乱七八糟的换行，Word 转出来的 Markdown 可能有多余空白。Normalizer 的工作就是**在不改变内容的前提下，把格式统一干净**。

### 基础清洗：`cleanText()`

一个纯函数，做了三件事（`cleaner.ts`）：

```
原始文本（解析器输出）
  │
  ├─ ① 统一换行符
  │    \r\n (Windows) → \n
  │    \r   (老 Mac)   → \n
  │
  ├─ ② 收敛空行
  │    3 个以上连续空行 → 压缩成 2 个
  │    （保留段落间距，但去掉大片空白）
  │
  └─ ③ 去头尾空白
       trim()
```

举例——假设 PDF 解析出来的是这样：

```
退换货政策\r\n\r\n\r\n\r\n\r\n自收到商品之日起7天内...\r\n
```

清洗后：

```
退换货政策\n\n自收到商品之日起7天内...
```

只保留了一个段落间距。

### 可选规则：`cleanTextWithRules()`

支持两种**可配置**的额外清洗（每个知识库可以单独设置）：

- **去多余空格（默认开启）：** `"自收到  商品  之日起    7天"` → `"自收到 商品 之日起 7天"`
- **去 URL 和邮箱（默认关闭）：** 把 URL 和邮箱从文本中删除

### 指标计算：`computeMetrics()`

顺便算三个数字（只用于观测，不做判断）：

```
charCount   = 文本总字符数
lineCount   = 总行数
textDensity = charCount / 页数 / 2000   ← 密度指标
```

> **学生：** 询问下，一定会有脏文本嘛？
>
> **老师：** 不是的，你这个直觉很对。大部分情况下 Normalizer 做的事情非常微小，文本进去什么样，出来基本还是什么样。

**真正会产生"脏文本"的场景其实只有 PDF：** PDF 本质上是排版格式（"这段文字放在坐标 x=72, y=500 的位置"），不是文本格式。提取文字时经常出现句子中间莫名换行、大量空白行等问题。

| 格式 | 脏的程度 | 原因 |
|------|---------|------|
| **Markdown / TXT** | 几乎没有 | 本来就是纯文本，自己写的 |
| **Word (.docx)** | 极少 | mammoth 直接转 Markdown，输出已经很干净 |
| **CSV / JSON** | 几乎没有 | 结构化数据 |
| **PDF** | 经常很脏 | 排版格式 → 文本提取有损 |

对于你手动写的一篇干净 Markdown 文档，经过这个函数后**一个字都不会变**。Normalizer 不是为了"清洗"，而是为了"容错"。

---

## 第五课：Quality Gate — 质量门禁

**老师：** 这个环节的名字听起来吓人，但逻辑只有 6 行代码（`knowledge-ingestion.ts`）：

```ts
private evaluateQuality(m: TextMetrics): QualityDecision {
  if (m.charCount === 0) return "reject_scan";
  if (m.textDensity < 0.05 && m.charCount < 100) return "reject_scan";
  if (m.textDensity < 0.1) return "flag_low";
  return "proceed";
}
```

它只判断一个核心问题：**"你上传的文件里到底有没有字？"**

| 条件 | 判决 | 后果 | 典型场景 |
|------|------|------|---------|
| 字符数 = 0 | `reject_scan` | 标记 FAILED，**停止处理** | 纯图片 PDF，没有任何文字 |
| 密度 < 0.05 且字符 < 100 | `reject_scan` | 标记 FAILED，**停止处理** | 扫描件，OCR 没跑出来什么字 |
| 密度 < 0.1 | `flag_low` | 标记 `low`，**继续处理** | 图表多的报告，文字偏少但还有内容 |
| 以上都不满足 | `proceed` | 正常继续 ✅ | 绝大多数文档 |

`reject_scan` 和 `flag_low` 的关键区别：
- `reject_scan` → 直接停止，不抛异常，不触发重试。因为这个文档继续向量化也没有意义——没有文字就搜不出来。
- `flag_low` → 不停，只是贴个标签 `qualityLabel = "low"`。后续搜索时可以用这个标签过滤或降权。

Normalizer 只算指标，不做判断。判断"要不要继续"是 Quality Gate 的职责。

---

## 第六课：Chunking — 文本切块

**老师：** 这是整个 Pipeline 里最精妙的一步。核心问题很简单：一篇 5000 字的文档，你拿去向量化？向量化后是一个 1024 维的向量，但你拿一段 5000 字的文本和一个 10 字的查询做语义相似度比对——精度很差。所以必须切成小块。

### 两层选择：Token 版 vs 字符版

系统有两个 Splitter，但实际使用 **`RecursiveTokenTextSplitter`**。为什么用 Token 版？因为 Embedding API 是按 token 计费和限制的。同样 500 字符，中文可能是 500 tokens，英文可能只有 80 tokens——用字符数来控制不够精确。

### 分隔符降级策略

切分不是一刀切——有个分隔符优先级列表：

```
\n\n  → 段落之间        （最优先，尽量在这里断）
\n    → 行之间
。！？； → 中文句末      （保证完整的一句话，不腰斩）
. ! ?  → 英文句末
，、   → 中文逗号
,      → 英文逗号
空格   → 词之间
""     → 字符级硬切      （最后兜底）
```

**核心算法——贪心合并：** 能拼就拼，拼不下了就输出，超长的降级用下一级分隔符再切。

举个例子，假设 chunkSize 是 800 tokens：

```
段落1：200 tokens
段落2：300 tokens
段落3：400 tokens  ← 这段比较长
段落4：100 tokens

current = 段落1 (200)
200 + 300 = 500 ≤ 800 ✅ → current = 段落1 + 段落2 (500)
500 + 400 = 900 > 800 ❌ → 输出 [段落1+段落2]，current = 段落3
100 + 100 = 200 ≤ 800 ✅ → current = 段落3 + 段落4 (500) → 输出

结果：["段落1\n\n段落2", "段落3\n\n段落4"]
```

### Overlap：防止关键信息被切在边界上

如果刚好在"退货时请确保"和"商品完好，并附上购买凭证"之间断开——用户搜"退货要什么条件"，任何一个单独的 chunk 都不够好。

Overlap 从上一个 chunk 末尾取完整语义单元（完整句子 → 完整行 → 硬截断），拼到下一个 chunk 的头部：

```
Chunk 1:  "...退货时请确保"
Chunk 2:  "...退货时请确保  ← overlap
           商品完好，并附上购买凭证。"
```

### 层次分块（Hierarchical）

**Parent（父块，800 tokens）：** 给用户看的——展示搜索结果时，父块提供完整上下文。
**Child（子块，400 tokens）：** 拿去向量化做搜索的——小块精度更高。

```
Parent Chunk (800 tokens)
  ├── Child 1 (400 tokens)
  ├── Child 2 (400 tokens)
  └── Child 3 (400 tokens)
```

搜索的时候只搜 Child，返回结果时附带 Parent 内容。

### Markdown 标题切分（固定分隔符）

设置 `fixedSeparator: "\n## "`，先按二级标题切，每个 `## 标题` 成为一个独立的 chunk。超过了 800 tokens 的段落才会再递归降级切分。这样做的好处是**按文档的语义结构切分**，每个 chunk 对应一个"小节"，自然就是一段完整信息。

### 总结

```
一篇 5000 字的文档
  ↓
RecursiveTokenTextSplitter
  按优先级找分隔符 → 贪心合并 → 超长降级 → overlap 补头
  ↓
输出：大约 6-8 个 chunk
  每个 500-800 tokens
  相邻之间 120 tokens 重叠
  ↓
拿去向量化
```

---

## 第七课：Embedding — 把文字变成数字

**老师：** 这是整个系统里最"魔法"但原理最简单的一步。计算机不知道"退货"和"退换"是近义词，它只知道这两个字符串不一样。

向量化的思路是：**训练一个大模型，让相似的句子映射到"数字空间"里相近的位置。**

```
"怎么退货？"      → [0.12, -0.34, 0.87, 0.05, ...]  (1024个数字)
"无理由退货流程"  → [0.13, -0.33, 0.85, 0.04, ...]  ← 很接近！
"今天天气真好"    → [-0.78, 0.55, -0.21, 0.93, ...] ← 差很远
```

两个向量的距离越近 → 语义越相似。

### 调用链

在 ingestion 流程中，向量化是这样被调用的：

```
所有 chunk 文本
  ↓
embeddingProvider.embed(texts[])   // 批量调用
  ↓
Promise<number[][]>                // 每个文本 → 一个 1024 维数组
  ↓
写入 PostgreSQL (pgvector)
```

代码里用的是 `getDefaultEmbeddingProvider()`，优先返回 Ollama 本地模型（如果可用）。

Ollama Provider 本质上就是一个 HTTP 请求：

```
POST http://localhost:11434/api/embed
Body: { model: "bge-m3", input: ["退货流程...", "换货流程...", ...] }

Response: {
  embeddings: [
    [0.12, -0.34, ...],   ← 对应 "退货流程..."
    [0.15, -0.31, ...],   ← 对应 "换货流程..."
  ]
}
```

BGE-M3 模型跑在 Ollama 里（本地），收到文本，跑一遍 Transformer，输出 1024 个浮点数。整个过程不需要联网，不需要 API Key。

### 向量维度

维度是模型决定的——是模型的"表达能力"：

| 模型 | 维度 | 类比 |
|------|------|------|
| nomic-embed-text | 768 | 用 768 个坐标定位语义 |
| bge-m3 | 1024 | 用 1024 个坐标，更精细 |
| text-embedding-3-large | 3072 | 3072 维，精度最高但最慢 |

1024 是一个比较平衡的选择。

### 时间成本

在全部 Pipeline 中，Embedding 是最慢的：

```
解析     → 毫秒级  （只是读文件）
清洗     → 毫秒级  （正则替换）
切块     → 毫秒级  （字符串操作）
向量化   → 秒级    （GPU/CPU 推理）
写入     → 毫秒级  （数据库操作）
```

这也是为什么要**批量调用** `embed(texts[])`——每次 HTTP 请求往返有固定开销，一次传 20 个文本比分 20 次传快得多。

---

## 第八课：多路写入 — 同一份数据存四个地方

**老师：** 上一步向量化完了，现在你手里有 `chunkId + chunkText + denseVec(1024维数组)`，接下来把它同时写进多个仓库。

```
chunk text + vector
        │
        ├── ① PostgreSQL (knowledge_chunks) ← 主存储，失败=抛异常，触发重试
        │      ├─ Prisma 插入元数据（id, content, chunkIndex, tokenCount...）
        │      └─ Raw SQL 写入 embedding 向量列
        │
        └── ② Elasticsearch ← 异步写入，失败不阻塞
               └─ bulkIndexDocuments(esDocs)
```

| 存储 | 角色 | 失败处理 |
|------|------|---------|
| **PGVector** | 主引擎（语义搜索） | 抛异常，重试 |
| **Elasticsearch** | BM25 关键词搜索 | warn 日志，不阻塞 |

错误处理的设计原则：**核心路径必须成功，辅助路径可以容错。** 系统在部分组件故障时仍能工作——这为后面的降级策略打下了基础。

> **学生：** 这里我比较好奇，有必要写入那么多的地方嘛？
>
> **老师：** V3.5 已经做了精简——**现在只需要 PG + ES 两个就够了。**

逐条分析（V3.5 更新）：

- **PGVector → 必须。** 语义搜索的主引擎，没它系统就废了。
- **Elasticsearch → 应该要。** BM25 关键词搜索是"混合检索"的另一条腿。但它是可选依赖——代码已经做了降级处理。
- **Milvus（Knowledge Collection）→ 已从摄入路径移除。** 早期 PGVector 不成熟时选用 Milvus 做向量存储，后来 PG vector 列直接加到 PG 表里变成冗余。V3.5 已停止写入，仅 deleteDocument 保留历史数据清理。
- **PG 倒排索引（knowledge_inverted_index）→ 已从摄入路径移除。** V3.5 已停止写入，仅保留 rebuildInvertedIndex 静态方法用于数据修复。新文档不再写入该表。

当前写入路径：

```
chunk text + vector
  │
  ├── PostgreSQL（元数据 + PGVector 向量）← 必须
  └── Elasticsearch（BM25 关键词）        ← 混合检索需要，但可降级
```

**总结：V3.5 已完成清理，技术债务已解决。** 核心只需要 PG + ES 两个就够了。

---

## 第九课：检索管线 — 用户搜索时发生了什么

**老师：** 摄入管线是把文档存进去，检索管线是把它取出来。整个流程就是一个**逐步收窄的漏斗**（`knowledge.ts`）：

```
用户查询
  ↓ ① 向量化
  ↓ ② 并行双路召回（25+25=50条）
  ↓ ③ RRF 融合排序（15条）
  ↓ ④ 相邻去重
  ↓ ⑤ Reranker 精排（5条）
  ↓ ⑥ 附带父块上下文
最终结果
```

### ① 向量化查询

跟摄入管线里向量化文档用的是同一个模型：`const queryVec = await provider.embedSingle(query);`

### ② 并行双路召回

```ts
const [denseResults, sparseResults] = await Promise.all([
  this.searchByVector(queryVec, kbIds, 25),   // Route 1: 语义
  this.searchByKeyword(query, kbIds, 25),      // Route 2: 关键词
]);
```

**Route 1 — PGVector：** `SELECT ... ORDER BY embedding <=> queryVec LIMIT 25`，`<=>` 是 pgvector 余弦距离运算符，`1 - distance` 转换成相似度。

**Route 2 — ES BM25：** BM25 概率检索模型，同时考虑词频（TF）和逆文档频率（IDF）。支持 `fuzziness: "AUTO"` 自动拼写纠错。

两路结果统一格式为 `RawCandidate{ chunkId, content, sourceScore, source }`。**ES 不可用时，`searchByKeyword` 返回 `[]`，RRF 只靠 PGVector 单路排序——降级自动发生。**

### ③ RRF 融合

**核心问题：** 两路分数量纲完全不同——PGVector 是 [0,1] 余弦相似度，ES BM25 是 [0,∞) TF-IDF 加权和。不能直接加和。

**RRF 的解法——不看分数，只看排名：**

```
RRF_score(chunk) = Σ 1 / (60 + rank_in_list)

例子：chunk "退换货政策"
  PGVector 排名 #2  →  1/(60+2) = 0.0161
  ES 排名     #1  →  1/(60+1) = 0.0164
  RRF 总分 = 0.0161 + 0.0164 = 0.0325
```

关键设计——**被两路同时命中的 chunk 获得加分**（共识信号）。只在一路出现则分数偏低。融合后取 topK×3 = 15 条。

### ④ 相邻 Chunk 去重

RRF 融合后的结果里，可能来自同一文档的相邻段落，内容高度重叠——保留两条没必要，浪费 Reranker 的计算。

两阶段去重：

1. **邻接去重：** 同一个 docId，chunkIndex 相差 ≤ 1 → 保留高分那条
2. **文本重叠去重：** bigram Jaccard 相似度 > 0.82 → 保留高分那条

Bigram Jaccard（中英文通用，不需要 tokenizer）：

```
"退换货政策" → bigrams: {"退换", "换货", "货政", "政策"}
"退货政策"   → bigrams: {"退货", "货政", "政策"}

Jaccard = |交集| / |并集| = 2 / 5 = 0.4 < 0.82 → 不算重复
```

### ⑤ Reranker 精排

去重后的候选送入 Reranker。Reranker 用的是 **Cross-Encoder**，与 Embedding 的 Bi-Encoder 不同：

| | Embedding (Bi-Encoder) | Reranker (Cross-Encoder) |
|---|---|---|
| 方式 | query / document 独立编码再比相似度 | query + document 一起喂给模型，挨个打分 |
| 速度 | 快 | 慢 |
| 精度 | 粗筛 | 精细 |
| 适用 | 全库召回 | 少量候选精排 |

这是经典的**粗排→精排两阶段策略：**

```
50条（并行召回）→ 15条（RRF+去重）→ [Reranker Cross-Encoder] → 5条最终结果
```

Reranker 没配置或请求超时 → 直接用 RRF 分数作为最终分数，降级不阻塞。

### ⑥ 附带父块上下文

如果用的是层次分块（hierarchical），每个 Child 都有一个 Parent。查询数据库，把 Parent 的内容附在结果上：

```
Child chunk:  "...7天内退货..."        (400 tokens，精准检索)
Parent chunk: "## 退换货政策\n自收到商品之日起..."  (800 tokens，完整上下文)
```

前端展示给用户的时候，可以用 Parent 的内容呈现，用户看到的是完整段落而非碎片。

### 降级策略总结

| 组件故障 | 系统行为 |
|----------|---------|
| ES 不可用 | `searchByKeyword` 返回 `[]`，仅靠 PGVector 单路 |
| Reranker 不可用 | 用 RRF 融合分数作为最终分数 |
| PGVector 查询失败 | 返回 `[]`，两路都空 → searchHybrid 返回 `[]` |

所有降级仅记录日志，不抛异常阻塞。

---

## 课外讨论：Embedding 模型选型

**学生：** 这个项目嵌入模型是不是用的本地的？

**老师：** 是的，**设计上优先使用本地模型**（Ollama + BGE-M3）。项目支持两种 Embedding Provider：

| Provider | 协议 | 条件 |
|----------|------|------|
| **Ollama** | REST (`/api/embed`) | 始终注册（只要有 OLLAMA_BASE_URL） |
| **OpenAI 兼容** | OpenAI SDK | 需要 `EMBEDDING_API_KEY` |

默认 provider 选择逻辑——Ollama 优先（`embeddings.ts`）：

```ts
export function getDefaultEmbeddingProvider(): EmbeddingProvider | null {
  if (embeddingProviders["ollama"]) return embeddingProviders["ollama"];
  ...
}
```

当前 `apps/server/.env` 配置：
```
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_EMBEDDING_MODEL=bge-m3
```

用的是 **BGE-M3**（BAAI 开源多语言），向量维度 1024。但本地 Ollama 服务当前没有运行，所以实际上获取默认 provider 会返回 null。

---

**学生：** 市场上，是不是可以选择一些嵌入模型，比如 qwen？

**老师：** 对，完全可以换。这个项目的架构**天然支持切换**。

三种接入 Qwen 的方式：

**方式一：DashScope API（最简单）**——阿里云官方，OpenAI 兼容接口。项目 `.env.example` 已经预留了配置：

```env
EMBEDDING_MODEL=text-embedding-v4
EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
EMBEDDING_API_KEY=sk-你的dashscope-key
```

`text-embedding-v3` / `text-embedding-v4` 在 `getEmbeddingDimension` 里已有定义（返回 1024），**开箱即用**。

**方式二：Ollama 本地拉取 Qwen 模型：**

```bash
ollama pull qwen3-embedding
```

修改 `.env`：`OLLAMA_EMBEDDING_MODEL=qwen3-embedding`，在 `getEmbeddingDimension` 里加一行维度映射即可。

**方式三：其他 OpenAI 兼容服务**（硅基流动、Jina AI 等），只要是 OpenAI 兼容接口就能直接接入。

推荐：国内用 DashScope `text-embedding-v4` 最省事（中文效果好、不需要自己跑模型），免费/离线用 Ollama 拉 `bge-m3` 或 `qwen3-embedding`。

---

## 关键文件索引

| 文件 | 职责 |
|------|------|
| `apps/server/src/services/document-parser/index.ts` | 解析器注册（lazy singleton） |
| `apps/server/src/services/document-parser/registry.ts` | ParserRegistry 插件匹配逻辑 |
| `apps/server/src/services/document-parser/parsers/text-parser.ts` | 纯文本文本解析（md/txt/csv/json 等） |
| `apps/server/src/services/document-parser/parsers/pdf-parser.ts` | PDF 解析（unpdf/pdfjs-dist） |
| `apps/server/src/services/document-parser/parsers/word-parser.ts` | Word 解析（mammoth → Markdown） |
| `apps/server/src/services/document-normalizer/normalizer.ts` | 文本清洗编排 |
| `apps/server/src/services/document-normalizer/cleaner.ts` | 清洗函数 + 指标计算 |
| `apps/server/src/services/text-splitter.ts` | RecursiveTokenTextSplitter（含层次分块） |
| `apps/server/src/services/embeddings.ts` | Embedding Provider 注册表（Ollama / OpenAI） |
| `apps/server/src/services/knowledge-ingestion.ts` | 摄入管线主服务（解析→清洗→质控→分块→向量化→多路写入） |
| `apps/server/src/services/knowledge.ts` | 检索管线主服务（双路召回→RRF→去重→Reranker→父块附加） |
| `apps/server/src/services/elasticsearch.ts` | ES 客户端（索引管理 + BM25 搜索） |
| `apps/server/src/services/reranker.ts` | HTTP Reranker 客户端 |
| `apps/server/src/config.ts` | 所有环境变量配置项定义 |
| `docs/architecture/knowledge-hybrid-retrieval.md` | 原始架构文档 |

---

> 全文完。从"为什么需要混合检索"开始，到解析→清洗→质控→切块→向量化→多路写入→并行召回→融合→去重→精排，逐层拆解了 AgentForge 知识库的完整数据链路。
