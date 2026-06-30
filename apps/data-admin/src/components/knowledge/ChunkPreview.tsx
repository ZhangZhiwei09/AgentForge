// 分块预览面板 —— 显示预计分块数量与前 3 个分块的预览内容
import type { ChunkPreviewResponseDTO } from "@agentforge/shared-types";
import { FileText, Layers } from "lucide-react";

// ── Props ────────────────────────────────────────

interface ChunkPreviewProps {
  preview: ChunkPreviewResponseDTO | null;
  loading: boolean;
}

// ── 骨架屏 ────────────────────────────────────────

function SkeletonPreview() {
  return (
    <div className="space-y-3 animate-pulse">
      <div className="h-4 w-24 bg-[hsl(var(--muted))] rounded" />
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="rounded-lg border border-[hsl(var(--border))] p-3 space-y-2"
        >
          <div className="h-3 w-12 bg-[hsl(var(--muted))] rounded" />
          <div className="space-y-1.5">
            <div className="h-3 w-full bg-[hsl(var(--muted))] rounded" />
            <div className="h-3 w-3/4 bg-[hsl(var(--muted))] rounded" />
            <div className="h-3 w-1/2 bg-[hsl(var(--muted))] rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── 空状态 ────────────────────────────────────────

function EmptyPreview() {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center space-y-2">
      <Layers className="h-8 w-8 text-muted-foreground opacity-30" />
      <p className="text-xs text-muted-foreground">
        调整分块参数后将自动预览
      </p>
    </div>
  );
}

// ── 组件 ──────────────────────────────────────────

export function ChunkPreview({ preview, loading }: ChunkPreviewProps) {
  if (loading) return <SkeletonPreview />;
  if (!preview || preview.total === 0) return <EmptyPreview />;

  return (
    <div className="space-y-3">
      {/* 预计分块数量 */}
      <div className="flex items-center gap-2">
        <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-[hsl(var(--cs-primary))]/10">
          <FileText className="h-3.5 w-3.5 text-[hsl(var(--cs-primary))]" />
        </div>
        <div>
          <p className="text-sm font-semibold text-foreground">
            {preview.total} 个分块
          </p>
          <p className="text-[10px] text-muted-foreground">
            {preview.chunkStructure === "hierarchical"
              ? "父子层级结构"
              : "段落平铺结构"}
          </p>
        </div>
      </div>

      {/* 预览分块列表 */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">
          前 {preview.preview.length} 个分块预览
        </p>
        {preview.preview.map((chunk) => (
          <div
            key={chunk.index}
            className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/30 p-3 space-y-1.5"
          >
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center rounded bg-[hsl(var(--cs-primary))]/10 px-1.5 py-0.5 text-[10px] font-medium text-[hsl(var(--cs-primary))]">
                #{chunk.index + 1}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {chunk.tokenCount} tokens
              </span>
            </div>
            <p className="text-xs text-foreground leading-relaxed line-clamp-3">
              {chunk.content}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
