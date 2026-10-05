// ── 引用卡片与过程时间轴共享类型 ──
//
// 消息级元数据，区别于 ContentBlock（正文内富媒体卡片）：
//   - 经 SSE 增量/一次性下发给前端渲染
//   - 持久化到 Message.metadata，供历史会话回放
// 后端 apps/server 与前端 apps/customer-service 共用本文件，避免两端各写一份。

/** 引用卡片条目：index 与回答正文中的 [n] 一一对应 */
export interface CitationCard {
  /** 资料编号，从 1 开始，与正文里的 [n] 一致 */
  index: number;
  /** 真实文档 ID（非合成值），用于后续跳转原文 */
  docId: string;
  docTitle: string;
  /** 正文摘录，约 200 字符，仅用于卡片展示 */
  excerpt: string;
  score: number;
}

/** 过程时间轴的一步：Agent 本轮"去查了什么" */
export interface TraceStep {
  /** 单调递增序号；前端按 seq 更新已存在的步骤 */
  seq: number;
  kind: "retrieval" | "tool";
  /** 中文描述，如「检索知识库」 */
  label: string;
  status: "running" | "done" | "failed";
  /** 查询词或工具名 */
  detail?: string;
  /** 命中条数（检索/工具返回的条数） */
  hitCount?: number;
}

/**
 * Message.metadata 中承载的引用与过程数据。
 *
 * <p>历史回放时从数据库读出，属外部数据：读取方必须先校验再取用，
 * 不得直接断言为其类型（旧版本或脏数据可能污染该列）。</p>
 */
export interface MessageCitationsMeta {
  citations?: CitationCard[];
  traces?: TraceStep[];
}
