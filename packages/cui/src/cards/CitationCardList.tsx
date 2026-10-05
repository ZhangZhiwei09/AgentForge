// CitationCardList —— 回答下方的引用文档卡片（横向滑动）
//
// 卡片停在对话里展示摘录，点正文的 [n] 会滚动定位到对应卡片。
// 按 Spec 方案 A：卡片纯展示、不可点 —— customer-service 没有文档详情路由，
// 不做「查看原文」入口，避免死链或误导性 affordance。

import { FileText } from "lucide-react";
import { cn } from "../utils/cn";
import type { CitationCard } from "@agentforge/shared-types";

/** 引用卡片的 DOM 锚点 id；scope 用于隔离同一页面里的多条消息 */
export function citeAnchorId(scope: string, index: number): string {
  return `cite-${scope}-${index}`;
}

/** 滚动到引用卡片并短暂高亮；找不到锚点时静默返回 */
export function scrollToCite(scope: string, index: number): void {
  const el = document.getElementById(citeAnchorId(scope, index));
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  // 用内联样式做一次性高亮，免于引入额外的全局动画样式表
  el.style.boxShadow = "0 0 0 2px rgba(59, 130, 246, 0.45)";
  window.setTimeout(() => {
    el.style.boxShadow = "";
  }, 900);
}

/**
 * 只保留回答正文里实际标注了 [n] 的卡片。
 * 正文一个 [n] 都没标时回退为展示全部召回条目（后端无法预知模型会引用哪几条）。
 */
export function filterCitedCards(
  cards: CitationCard[],
  answer: string,
): CitationCard[] {
  const used = new Set(
    [...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])),
  );
  if (!used.size) return cards;
  return cards.filter((c) => used.has(c.index));
}

interface Props {
  cards: CitationCard[];
  /** 锚点作用域，通常传消息 id */
  scope: string;
  /** 覆写根容器 className */
  className?: string;
}

export function CitationCardList({ cards, scope, className }: Props) {
  if (!cards.length) return null;

  return (
    <div className={cn("mt-3", className)}>
      <div className="mb-1.5 text-[11px] font-semibold text-[hsl(var(--muted-foreground))]">
        引用文档 ({cards.length})
      </div>
      <div
        className="flex gap-2 overflow-x-auto pb-2"
        style={{ scrollSnapType: "x proximity" }}
      >
        {cards.map((c) => (
          <CitationItem key={`${c.docId}-${c.index}`} card={c} scope={scope} />
        ))}
      </div>
    </div>
  );
}

function CitationItem({ card, scope }: { card: CitationCard; scope: string }) {
  return (
    <div
      id={citeAnchorId(scope, card.index)}
      className="flex w-[220px] shrink-0 flex-col rounded-lg border border-[hsl(var(--cs-border))] bg-white p-2.5 shadow-sm transition-colors hover:border-blue-300"
      style={{ scrollSnapAlign: "start" }}
    >
      <div className="flex items-start gap-1.5">
        <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500" />
        <span
          className="line-clamp-2 text-[11px] font-medium leading-snug text-[hsl(var(--foreground))]"
          title={card.docTitle}
        >
          [{card.index}] {card.docTitle}
        </span>
      </div>

      <p className="mt-1 line-clamp-3 flex-1 text-[10px] leading-relaxed text-[hsl(var(--muted-foreground))]">
        {card.excerpt}
      </p>

      <div className="mt-1.5 text-right text-[10px] font-mono text-[hsl(var(--muted-foreground))]">
        相似度 {card.score.toFixed(2)}
      </div>
    </div>
  );
}

export default CitationCardList;
