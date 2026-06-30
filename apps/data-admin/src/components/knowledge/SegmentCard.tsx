// 单个分块卡片 —— 分块序号 / 内容截断 / token 数 / 父分块引用
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

// ── 分块数据类型 ────────────────────────────────────

export interface SegmentData {
  id: string;
  content: string;
  chunkIndex: number;
  tokenCount?: number;
  parentChunkId?: string | null;
}

// ── Props ──────────────────────────────────────────

interface SegmentCardProps {
  segment: SegmentData;
  index: number;
}

// ── 组件 ──────────────────────────────────────────

export function SegmentCard({ segment, index }: SegmentCardProps) {
  const [expanded, setExpanded] = useState(false);

  const isTruncated = segment.content.length > 200;
  const displayContent =
    expanded || !isTruncated
      ? segment.content
      : segment.content.slice(0, 200) + "…";

  return (
    <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-3.5 transition-colors hover:border-[hsl(var(--ring))]/30">
      {/* 头部：分块序号 + token 数 */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {/* 分块序号 */}
          <span className="inline-flex items-center justify-center h-5 w-5 rounded-md bg-[hsl(var(--muted))] text-[10px] font-bold text-muted-foreground">
            {index + 1}
          </span>
          <span className="text-[11px] text-muted-foreground">
            分块 #{segment.chunkIndex}
          </span>
        </div>

        {/* token 数 */}
        {segment.tokenCount != null && (
          <span className="text-[10px] text-muted-foreground font-mono">
            {segment.tokenCount} tokens
          </span>
        )}
      </div>

      {/* 父分块引用 */}
      {segment.parentChunkId && (
        <div className="mb-1.5 ml-7">
          <span className="text-[10px] text-muted-foreground bg-[hsl(var(--muted))] rounded px-1.5 py-0.5">
            子分块（父：{segment.parentChunkId.slice(0, 8)}...）
          </span>
        </div>
      )}

      {/* 分块内容 */}
      <div className="ml-7">
        <p className="text-xs text-foreground leading-relaxed whitespace-pre-wrap break-words">
          {displayContent}
        </p>

        {/* 展开/收起按钮 */}
        {segment.content.length > 200 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="inline-flex items-center gap-1 mt-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? (
              <>
                <ChevronDown className="h-3 w-3" />
                收起
              </>
            ) : (
              <>
                <ChevronRight className="h-3 w-3" />
                展开（{segment.content.length} 字符）
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
