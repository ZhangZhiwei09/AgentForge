import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronLeft, ChevronRight, Loader2, RefreshCw, ThumbsDown, ThumbsUp } from "lucide-react";
import { client } from "@agentforge/ui";
import type { FeedbackQueryParams } from "@agentforge/shared-types";

const FILTERS = [
  { value: "negative", label: "负面" },
  { value: "positive", label: "正面" },
  { value: "all", label: "全部" },
] as const;

export function FeedbackPage() {
  const [filter, setFilter] = useState<NonNullable<FeedbackQueryParams["type"]>>("negative");
  const [page, setPage] = useState(1);
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["knowledge", "feedback", filter, page],
    queryFn: () => client.getFeedback(filter, page, 15),
    retry: false,
  });

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link to="/admin/cs/knowledge" aria-label="返回知识库" title="返回知识库"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-[hsl(var(--muted))] hover:text-foreground">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </Link>
          <h1 className="text-base font-semibold">用户反馈</h1>
        </div>
        <div className="flex items-center gap-2">
          <div role="group" aria-label="反馈筛选" className="flex rounded-md border p-0.5">
            {FILTERS.map(({ value, label }) => (
              <button key={value} type="button" aria-pressed={filter === value}
                onClick={() => { setFilter(value); setPage(1); }}
                className={`rounded px-3 py-1.5 text-xs font-medium ${
                  filter === value
                    ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                    : "text-muted-foreground hover:bg-[hsl(var(--muted))]"
                }`}>
                {label}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => void refetch()} aria-label="刷新反馈" title="刷新反馈"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-[hsl(var(--muted))]">
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {isLoading && (
        <div role="status" aria-label="加载反馈" className="flex justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}
      {isError && (
        <div role="alert" className="space-y-3 py-8 text-sm">
          <p className="break-words text-red-600">{error instanceof Error ? error.message : "无法加载反馈"}</p>
          <button type="button" onClick={() => void refetch()}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            重试
          </button>
        </div>
      )}
      {!isLoading && !isError && data && (
        <>
          {data.feedback.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">暂无反馈数据</p>
          ) : (
            <ul className="divide-y border-y">
              {data.feedback.map((item) => (
                <li key={item.id} className="min-w-0 space-y-3 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className={`inline-flex items-center gap-1.5 ${item.rating === "positive" ? "text-green-700" : "text-red-600"}`}>
                      {item.rating === "positive"
                        ? <ThumbsUp className="h-3.5 w-3.5" aria-hidden="true" />
                        : <ThumbsDown className="h-3.5 w-3.5" aria-hidden="true" />}
                      {item.rating === "positive" ? "正面" : "负面"}
                    </span>
                    <time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString("zh-CN")}</time>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{item.user_message || "用户消息不可用"}</p>
                  {item.comment && (
                    <p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">
                      <span className="text-muted-foreground">反馈：</span>{item.comment}
                    </p>
                  )}
                  <details className="text-xs text-muted-foreground">
                    <summary className="w-fit cursor-pointer">诊断回复</summary>
                    <p className="mt-2 whitespace-pre-wrap break-words leading-relaxed [overflow-wrap:anywhere]">
                      {item.assistant_message || "回复不可用"}
                    </p>
                  </details>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>共 {data.pagination.total} 条</span>
            {data.pagination.totalPages > 1 && (
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))}
                  disabled={page <= 1} aria-label="上一页" title="上一页"
                  className="flex h-8 w-8 items-center justify-center rounded-md border disabled:opacity-40">
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                </button>
                <span aria-live="polite">{page} / {data.pagination.totalPages}</span>
                <button type="button" onClick={() => setPage((current) => current + 1)}
                  disabled={page >= data.pagination.totalPages} aria-label="下一页" title="下一页"
                  className="flex h-8 w-8 items-center justify-center rounded-md border disabled:opacity-40">
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
