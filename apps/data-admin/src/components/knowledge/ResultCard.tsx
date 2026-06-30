// 单条检索结果卡片 —— 排名 / 得分 / 来源 / 分块内容
import { useState } from "react";
import type { HitTestingResultDTO } from "@agentforge/shared-types";
import { ChevronDown, ChevronRight, ExternalLink, FileText } from "lucide-react";

// ── Props ────────────────────────────────────────

interface ResultCardProps {
  result: HitTestingResultDTO;
  index: number;
  onViewDetail: (result: HitTestingResultDTO) => void;
}

// ── 得分颜色 ──────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 0.8) return "text-green-600 bg-green-50";
  if (score >= 0.5) return "text-amber-600 bg-amber-50";
  return "text-red-500 bg-red-50";
}

function sourceBadgeColor(source: string): string {
  if (source.toLowerCase().includes("pgvector") || source.toLowerCase().includes("vector"))
    return "bg-purple-100 text-purple-700";
  if (source.toLowerCase().includes("elastic") || source.toLowerCase().includes("keyword"))
    return "bg-blue-100 text-blue-700";
  return "bg-gray-100 text-gray-600";
}

// ── 组件 ──────────────────────────────────────────

export function ResultCard({ result, index, onViewDetail }: ResultCardProps) {
  const [expanded, setExpanded] = useState(false);
  const hasParentChunk = !!result.parentChunk?.content;

  // 内容截断 ~300 字符
  const contentTruncated =
    result.content.length > 300
      ? result.content.slice(0, 300) + "…"
      : result.content;

  return (
    <div
      className="group rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-4 cursor-pointer
        transition-all hover:-translate-y-0.5 hover:border-[hsl(var(--ring))]/50 hover:shadow-md"
      onClick={() => onViewDetail(result)}
    >
      {/* 头部：排名 + 分数 */}
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-[hsl(var(--muted))] text-[11px] font-bold text-muted-foreground">
            {index + 1}
          </span>
          <span className="text-[11px] text-muted-foreground truncate max-w-[200px]">
            {result.document.title}
          </span>
        </div>

        {/* 分数标签组 */}
        <div className="flex items-center gap-1.5">
          {/* 最终得分 */}
          <span
            className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-mono font-medium ${scoreColor(result.score)}`}
            title="最终得分"
          >
            {result.score.toFixed(4)}
          </span>

          {/* RRF 融合分 */}
          {result.fusionScore != null && (
            <span
              className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-mono bg-cyan-50 text-cyan-700"
              title="RRF 融合分"
            >
              RRF {result.fusionScore.toFixed(3)}
            </span>
          )}

          {/* Rerank 分 */}
          {result.rerankScore != null && (
            <span
              className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-mono bg-pink-50 text-pink-700"
              title="Rerank 分"
            >
              Rerank {result.rerankScore.toFixed(4)}
            </span>
          )}
        </div>
      </div>

      {/* 分块内容 */}
      <p className="text-xs text-foreground leading-relaxed line-clamp-4 mb-2">
        {contentTruncated}
      </p>

      {/* 父分块内容（折叠区域） */}
      {hasParentChunk && (
        <div className="mb-2">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            父分块
          </button>
          {expanded && (
            <div className="mt-1.5 ml-3.5 pl-2.5 border-l-2 border-[hsl(var(--border))]">
              <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-3">
                {result.parentChunk!.content}
              </p>
            </div>
          )}
        </div>
      )}

      {/* 底部元信息 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* 召回来源标签 */}
          <div className="flex items-center gap-1">
            {result.recallSources.map((source) => (
              <span
                key={source}
                className={`inline-flex items-center rounded px-1 py-0.5 text-[9px] font-medium ${sourceBadgeColor(source)}`}
              >
                {source}
              </span>
            ))}
          </div>

          {/* 文档信息 */}
          <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
            <FileText className="h-2.5 w-2.5" />
            Chunk #{result.chunkIndex}
          </span>
        </div>

        {/* 查看详情按钮 */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onViewDetail(result);
          }}
          className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors opacity-0 group-hover:opacity-100"
        >
          详情
          <ExternalLink className="h-2.5 w-2.5" />
        </button>
      </div>
    </div>
  );
}
