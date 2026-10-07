// 分块列表容器 —— 加载 / 空 / 搜索筛选 / 列表四种状态
import { useState } from "react";
import { Search, X, Layers } from "lucide-react";
import { SegmentCard } from "./SegmentCard";
import type { SegmentData } from "./SegmentCard";

// ── 骨架屏 ──────────────────────────────────────────

function SkeletonSegment() {
  return (
    <div className="rounded-lg border border-[hsl(var(--border))] p-3.5 animate-pulse">
      <div className="flex items-center justify-between mb-2">
        <div className="h-4 w-24 rounded bg-[hsl(var(--muted))]" />
        <div className="h-3 w-16 rounded bg-[hsl(var(--muted))]" />
      </div>
      <div className="space-y-1.5 ml-7">
        <div className="h-3 w-full rounded bg-[hsl(var(--muted))]" />
        <div className="h-3 w-3/4 rounded bg-[hsl(var(--muted))]" />
      </div>
    </div>
  );
}

// ── Props ──────────────────────────────────────────

interface SegmentListProps {
  chunks: SegmentData[];
  loading: boolean;
  onSave: (chunkId: string, content: string) => Promise<unknown>;
}

// ── 组件 ──────────────────────────────────────────

export function SegmentList({ chunks, loading, onSave }: SegmentListProps) {
  const [searchText, setSearchText] = useState("");

  // ── 加载状态 ──────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 mb-1">
          <Layers className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium text-foreground">分块列表</h2>
        </div>
        {Array.from({ length: 3 }).map((_, i) => (
          <SkeletonSegment key={i} />
        ))}
      </div>
    );
  }

  // ── 空状态 ──────────────────────────────────────

  if (chunks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <div className="rounded-full bg-[hsl(var(--muted))]/50 p-3 mb-3">
          <Layers className="h-6 w-6 text-muted-foreground opacity-40" />
        </div>
        <p className="text-sm font-medium text-foreground mb-1">
          尚未分块
        </p>
        <p className="text-xs text-muted-foreground">
          文档处理完成后将自动生成分块数据
        </p>
      </div>
    );
  }

  // ── 内容搜索筛选 ────────────────────────────────

  const filteredChunks = searchText.trim()
    ? chunks.filter((c) =>
        c.content.toLowerCase().includes(searchText.toLowerCase()),
      )
    : chunks;

  return (
    <div className="space-y-3">
      {/* 标题 + 搜索 */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium text-foreground">
            分块列表
          </h2>
          <span className="text-[10px] text-muted-foreground bg-[hsl(var(--muted))] rounded px-1.5 py-0.5">
            {chunks.length}
          </span>
        </div>

        {/* 搜索输入 */}
        <div className="relative w-48">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="搜索分块内容..."
            className="w-full rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] pl-7 pr-6 py-1 text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ring))]"
          />
          {searchText && (
            <button
              onClick={() => setSearchText("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted-foreground hover:text-foreground"
              title="清除搜索"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          )}
        </div>
      </div>

      {/* 分块列表 */}
      {filteredChunks.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-8">
          无匹配分块
        </p>
      ) : (
        <div className="space-y-2">
          {filteredChunks.map((chunk, i) => (
            <SegmentCard
              key={chunk.id}
              segment={chunk}
              index={i}
              onSave={(content) => onSave(chunk.id, content)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
