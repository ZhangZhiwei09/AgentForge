// 搜索结果列表容器 —— 总数 / 耗时 / 空 / 加载 / 错误状态
import type { HitTestingResultDTO } from "@agentforge/shared-types";
import { Search, AlertCircle, RotateCw, FileSearch } from "lucide-react";
import { ResultCard } from "./ResultCard";

// ── Props ────────────────────────────────────────

interface ResultListProps {
  results: HitTestingResultDTO[] | null;
  loading: boolean;
  error: string | null;
  elapsedMs?: number;
  onViewDetail: (result: HitTestingResultDTO) => void;
  onRetry?: () => void;
}

// ── 骨架屏 ────────────────────────────────────────

function SkeletonList() {
  return (
    <div className="space-y-3 animate-pulse">
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-4 space-y-3"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="h-6 w-6 rounded-full bg-[hsl(var(--muted))]" />
              <div className="h-3 w-32 bg-[hsl(var(--muted))] rounded" />
            </div>
            <div className="flex items-center gap-1.5">
              <div className="h-4 w-14 bg-[hsl(var(--muted))] rounded-full" />
            </div>
          </div>
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

// ── 空状态：未搜索 ──────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center space-y-3">
      <Search className="h-10 w-10 text-muted-foreground opacity-25" />
      <p className="text-xs text-muted-foreground">
        输入查询文本并点击发送，测试检索效果
      </p>
      <p className="text-[11px] text-muted-foreground/60">
        支持混合检索、语义检索、关键词检索三种模式
      </p>
    </div>
  );
}

// ── 空状态：搜索无结果 ───────────────────────────────

function NoResultsState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center space-y-3">
      <FileSearch className="h-10 w-10 text-muted-foreground opacity-25" />
      <p className="text-xs text-muted-foreground font-medium">
        未找到匹配结果
      </p>
      <p className="text-[11px] text-muted-foreground/60">
        尝试调整检索方法或降低过滤阈值
      </p>
    </div>
  );
}

// ── 错误状态 ──────────────────────────────────────

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center space-y-3">
      <div className="flex items-center justify-center h-10 w-10 rounded-full bg-red-50">
        <AlertCircle className="h-5 w-5 text-red-500" />
      </div>
      <p className="text-xs text-red-600 font-medium">
        检索请求失败
      </p>
      <p className="text-[11px] text-muted-foreground max-w-xs">
        {message}
      </p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[hsl(var(--border))] px-3 py-1.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--accent))] transition-colors"
        >
          <RotateCw className="h-3 w-3" />
          重试
        </button>
      )}
    </div>
  );
}

// ── 组件 ──────────────────────────────────────────

export function ResultList({
  results,
  loading,
  error,
  elapsedMs,
  onViewDetail,
  onRetry,
}: ResultListProps) {
  // 加载中
  if (loading) {
    return (
      <div className="space-y-3">
        <div className="h-4 w-32 bg-[hsl(var(--muted))] rounded animate-pulse" />
        <SkeletonList />
      </div>
    );
  }

  // 错误状态
  if (error) {
    return <ErrorState message={error} onRetry={onRetry} />;
  }

  // 未搜索
  if (results === null) {
    return <EmptyState />;
  }

  // 无结果
  if (results.length === 0) {
    return <NoResultsState />;
  }

  // 有结果
  return (
    <div className="space-y-3">
      {/* 统计摘要 */}
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>
          {results.length} 条结果
        </span>
        {elapsedMs != null && (
          <>
            <span className="text-[hsl(var(--border))]">|</span>
            <span>{elapsedMs} ms</span>
          </>
        )}
      </div>

      {/* 结果卡片列表 */}
      <div className="space-y-2.5">
        {results.map((result, i) => (
          <ResultCard
            key={result.chunkId}
            result={result}
            index={i}
            onViewDetail={onViewDetail}
          />
        ))}
      </div>
    </div>
  );
}
