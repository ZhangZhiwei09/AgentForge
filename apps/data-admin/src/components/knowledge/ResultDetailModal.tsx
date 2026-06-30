// 分块详情模态框 —— 完整内容 / 元数据 / 分数详情
import { useEffect, useRef } from "react";
import type { HitTestingResultDTO } from "@agentforge/shared-types";
import { X, FileText, Hash, Clock, Layers } from "lucide-react";

// ── Props ────────────────────────────────────────

interface ResultDetailModalProps {
  result: HitTestingResultDTO | null;
  open: boolean;
  onClose: () => void;
}

// ── 得分颜色工具 ──────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 0.8) return "bg-green-100 text-green-700";
  if (score >= 0.5) return "bg-amber-100 text-amber-700";
  return "bg-red-100 text-red-500";
}

function sourceBadgeColor(source: string): string {
  const s = source.toLowerCase();
  if (s.includes("pgvector") || s.includes("vector"))
    return "bg-purple-100 text-purple-700";
  if (s.includes("elastic") || s.includes("keyword"))
    return "bg-blue-100 text-blue-700";
  return "bg-gray-100 text-gray-600";
}

// ── 组件 ──────────────────────────────────────────

export function ResultDetailModal({
  result,
  open,
  onClose,
}: ResultDetailModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  // Escape 键关闭
  useEffect(() => {
    if (!open) return;
    function handleEsc(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [open, onClose]);

  // 禁止背景滚动
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  if (!open || !result) return null;

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  };

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in"
    >
      <div className="relative w-full max-w-2xl max-h-[85vh] mx-4 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] shadow-xl flex flex-col">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[hsl(var(--border))] shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold text-foreground truncate">
              分块详情
            </span>
            <span className="text-[11px] text-muted-foreground">
              #{result.chunkIndex}
            </span>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--accent))] transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 内容区域 */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* 元数据行 */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <FileText className="h-3 w-3" />
              {result.document.title}
            </span>
            <span className="flex items-center gap-1">
              <Hash className="h-3 w-3" />
              Chunk #{result.chunkIndex}
            </span>
            <span className="flex items-center gap-1">
              <Layers className="h-3 w-3" />
              {result.content.length} 字符
            </span>
          </div>

          {/* 分数详情 */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground mr-1">得分：</span>
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-mono font-medium ${scoreColor(result.score)}`}
            >
              最终 {result.score.toFixed(4)}
            </span>
            {result.fusionScore != null && (
              <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-mono bg-cyan-50 text-cyan-700">
                RRF 融合 {result.fusionScore.toFixed(3)}
              </span>
            )}
            {result.rerankScore != null && (
              <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-mono bg-pink-50 text-pink-700">
                Rerank {result.rerankScore.toFixed(4)}
              </span>
            )}
          </div>

          {/* 召回来源 */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground">召回来源：</span>
            {result.recallSources.map((source) => (
              <span
                key={source}
                className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${sourceBadgeColor(source)}`}
              >
                {source}
              </span>
            ))}
          </div>

          {/* 分隔线 */}
          <div className="border-t border-[hsl(var(--border))]" />

          {/* 完整分块内容 */}
          <div>
            <h4 className="text-xs font-semibold text-foreground mb-2">
              分块内容
            </h4>
            <pre className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/50 p-3 text-xs text-foreground leading-relaxed whitespace-pre-wrap font-sans max-h-60 overflow-y-auto">
              {result.content}
            </pre>
          </div>

          {/* 父分块完整内容（如有） */}
          {result.parentChunk?.content && (
            <div>
              <h4 className="text-xs font-semibold text-foreground mb-2">
                父分块
              </h4>
              <pre className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/50 p-3 text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap font-sans max-h-60 overflow-y-auto">
                {result.parentChunk.content}
              </pre>
            </div>
          )}
        </div>

        {/* 底部操作栏 */}
        <div className="flex items-center justify-end px-5 py-3 border-t border-[hsl(var(--border))] shrink-0">
          <button
            onClick={onClose}
            className="rounded-lg border border-[hsl(var(--border))] px-3 py-1.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--accent))] transition-colors"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
