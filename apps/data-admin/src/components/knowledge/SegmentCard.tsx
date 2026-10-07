// 单个分块卡片 —— 分块序号 / 内容截断 / token 数 / 父分块引用
import { useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Pencil,
  X,
} from "lucide-react";

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
  onSave: (content: string) => Promise<unknown>;
}

// ── 组件 ──────────────────────────────────────────

export function SegmentCard({ segment, index, onSave }: SegmentCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftContent, setDraftContent] = useState(segment.content);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const isTruncated = segment.content.length > 500;
  const displayContent =
    expanded || !isTruncated
      ? segment.content
      : segment.content.slice(0, 500) + "…";

  const handleStartEditing = () => {
    setDraftContent(segment.content);
    setSaveError(null);
    setEditing(true);
    setExpanded(true);
  };

  const handleCancel = () => {
    setDraftContent(segment.content);
    setSaveError(null);
    setEditing(false);
  };

  const handleSave = async () => {
    if (!draftContent.trim()) {
      setSaveError("切片内容不能为空");
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      await onSave(draftContent);
      setEditing(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

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

        <div className="flex items-center gap-2">
          {segment.tokenCount != null && (
            <span className="text-[10px] text-muted-foreground font-mono">
              {segment.tokenCount} tokens
            </span>
          )}
          {!editing && (
            <button
              onClick={handleStartEditing}
              className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-[hsl(var(--accent))] hover:text-foreground transition-colors"
              title="编辑切片"
            >
              <Pencil className="h-3 w-3" />
              编辑
            </button>
          )}
        </div>
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
        {editing ? (
          <div className="space-y-2">
            <textarea
              value={draftContent}
              onChange={(event) => setDraftContent(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                  event.preventDefault();
                  void handleSave();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  handleCancel();
                }
              }}
              autoFocus
              rows={Math.min(16, Math.max(6, draftContent.split("\n").length + 2))}
              className="w-full resize-y rounded-md border border-[hsl(var(--ring))] bg-[hsl(var(--background))] px-3 py-2 text-xs leading-relaxed text-foreground outline-none focus:ring-1 focus:ring-[hsl(var(--ring))]"
              aria-label={`编辑分块 ${segment.chunkIndex} 内容`}
            />
            {saveError && (
              <p className="text-[11px] text-red-500">{saveError}</p>
            )}
            <div className="flex items-center gap-2">
              <button
                onClick={() => void handleSave()}
                disabled={saving}
                className="inline-flex items-center gap-1 rounded-md bg-[hsl(var(--primary))] px-2.5 py-1.5 text-[11px] font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Check className="h-3 w-3" />
                )}
                {saving ? "保存中..." : "保存"}
              </button>
              <button
                onClick={handleCancel}
                disabled={saving}
                className="inline-flex items-center gap-1 rounded-md border border-[hsl(var(--border))] px-2.5 py-1.5 text-[11px] text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                <X className="h-3 w-3" />
                取消
              </button>
            </div>
          </div>
        ) : (
          <p className="text-xs text-foreground leading-relaxed whitespace-pre-wrap break-words">
            {displayContent}
          </p>
        )}

        {/* 展开/收起按钮 */}
        {!editing && segment.content.length > 200 && (
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
