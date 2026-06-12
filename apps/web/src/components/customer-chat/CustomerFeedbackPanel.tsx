import { useState, useEffect, useCallback } from "react";
import {
    ThumbsUp,
    ThumbsDown,
    Star,
    AlertTriangle,
    TrendingUp,
    TrendingDown,
    MessageSquare,
    FileText,
    ChevronLeft,
    ChevronRight,
    Loader2,
    Filter,
    ShieldCheck,
    ShieldAlert,
    ShieldX,
} from "lucide-react";

interface FeedbackItem {
    id: string;
    rating: string;
    comment: string | null;
    created_at: string;
    conversation_id: string;
    session_id: string;
    intent: string | null;
    user_message: string;
    assistant_message: string;
    message_id: string;
}

interface IntentPerformance {
    intent_name: string;
    total: number;
    positive: number;
    negative: number;
    health: number;
}

interface TrendItem {
    date: string;
    total: number;
    positive: number;
    negative: number;
}

interface FeedbackData {
    feedback: FeedbackItem[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
    intent_performance: IntentPerformance[];
    trends: TrendItem[];
}

export function CustomerFeedbackPanel() {
    const [data, setData] = useState<FeedbackData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [filterType, setFilterType] = useState<"all" | "negative" | "positive">("all");
    const [page, setPage] = useState(1);

    const fetchFeedback = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(
                `/api/customer-chat/feedback?type=${filterType}&page=${page}&limit=15`,
            );
            if (!res.ok) throw new Error("Failed to fetch");
            const json = await res.json();
            setData(json);
        } catch (err) {
            setError(err instanceof Error ? err.message : "加载失败");
        } finally {
            setLoading(false);
        }
    }, [filterType, page]);

    useEffect(() => {
        fetchFeedback();
    }, [fetchFeedback]);

    // 评分标签渲染
    function ratingBadge(rating: string) {
        if (rating === "positive") {
            return (
                <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-700">
                    <ThumbsUp className="h-3 w-3" /> 好评
                </span>
            );
        }
        if (rating === "negative" || rating.startsWith("star_")) {
            const starNum = rating.startsWith("star_") ? parseInt(rating.split("_")[1]) : 0;
            return (
                <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-700">
                    <ThumbsDown className="h-3 w-3" /> {starNum ? `${starNum}星` : "差评"}
                </span>
            );
        }
        return <span className="text-[11px] text-gray-500">{rating}</span>;
    }

    // FAQ 健康度颜色
    function healthColor(health: number): string {
        if (health >= 80) return "text-green-600 bg-green-50 border-green-200";
        if (health >= 50) return "text-amber-600 bg-amber-50 border-amber-200";
        return "text-red-600 bg-red-50 border-red-200";
    }

    function healthIcon(health: number) {
        if (health >= 80) return <ShieldCheck className="h-4 w-4 text-green-500" />;
        if (health >= 50) return <ShieldAlert className="h-4 w-4 text-amber-500" />;
        return <ShieldX className="h-4 w-4 text-red-500" />;
    }

    // 格式化日期
    function formatDate(dateStr: string) {
        const d = new Date(dateStr);
        return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
    }

    return (
        <div className="space-y-5">
            {/* 筛选栏 */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 rounded-lg border border-[hsl(var(--cs-border))] bg-[hsl(var(--cs-bg))] p-1">
                    {(["all", "negative", "positive"] as const).map((type) => (
                        <button
                            key={type}
                            onClick={() => { setFilterType(type); setPage(1); }}
                            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                                filterType === type
                                    ? "bg-white text-[hsl(var(--foreground))] shadow-sm"
                                    : "text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
                            }`}
                        >
                            {type === "all" && "全部评价"}
                            {type === "negative" && "差评"}
                            {type === "positive" && "好评"}
                        </button>
                    ))}
                </div>
                <span className="text-[11px] text-[hsl(var(--muted-foreground))]">
                    共 {data?.pagination.total ?? 0} 条评价
                </span>
            </div>

            {loading && (
                <div className="flex items-center justify-center py-10">
                    <Loader2 className="h-5 w-5 animate-spin text-[hsl(var(--muted-foreground))]" />
                </div>
            )}

            {error && (
                <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
            )}

            {data && (
                <>
                    {/* 7日趋势 */}
                    {data.trends.length > 0 && (
                        <div>
                            <div className="flex items-center gap-2 mb-2">
                                <TrendingUp className="h-4 w-4 text-[hsl(var(--cs-primary))]" />
                                <h4 className="text-xs font-semibold text-[hsl(var(--foreground))]">
                                    最近 {data.trends.length} 天评价趋势
                                </h4>
                            </div>
                            <div className="flex items-end gap-2 h-20 px-1">
                                {data.trends.reverse().map((t) => {
                                    const maxVal = Math.max(...data.trends.map((d) => d.total), 1);
                                    return (
                                        <div
                                            key={t.date}
                                            className="flex-1 flex flex-col items-center gap-1"
                                            title={`${t.date} · 👍${t.positive} 👎${t.negative}`}
                                        >
                                            <div className="w-full flex flex-col gap-0.5" style={{ height: 64 }}>
                                                <div
                                                    className="w-full rounded-t-sm bg-red-400 mt-auto transition-all"
                                                    style={{
                                                        height: `${(t.negative / maxVal) * 64}px`,
                                                        opacity: t.negative > 0 ? 0.85 : 0,
                                                    }}
                                                />
                                                <div
                                                    className="w-full rounded-t-sm bg-green-400 transition-all"
                                                    style={{
                                                        height: `${(t.positive / maxVal) * 64}px`,
                                                        opacity: t.positive > 0 ? 0.85 : 0,
                                                    }}
                                                />
                                            </div>
                                            <span className="text-[9px] text-[hsl(var(--muted-foreground))]">
                                                {t.date.slice(5)}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                            <div className="flex items-center justify-center gap-4 mt-1.5">
                                <span className="flex items-center gap-1 text-[10px] text-[hsl(var(--muted-foreground))]">
                                    <span className="h-2 w-2 rounded-sm bg-green-400" /> 好评
                                </span>
                                <span className="flex items-center gap-1 text-[10px] text-[hsl(var(--muted-foreground))]">
                                    <span className="h-2 w-2 rounded-sm bg-red-400" /> 差评
                                </span>
                            </div>
                        </div>
                    )}

                    {/* 意图维度健康度：哪类问题差评最多 */}
                    {data.intent_performance.length > 0 && (
                        <div>
                            <div className="flex items-center gap-2 mb-2">
                                <FileText className="h-4 w-4 text-[hsl(var(--cs-primary))]" />
                                <h4 className="text-xs font-semibold text-[hsl(var(--foreground))]">
                                    问题类型健康度
                                </h4>
                            </div>
                            <div className="space-y-1.5 max-h-48 overflow-y-auto">
                                {data.intent_performance.map((item) => (
                                    <div
                                        key={item.intent_name}
                                        className={`flex items-center justify-between rounded-lg border px-3 py-2 text-xs ${healthColor(item.health)}`}
                                    >
                                        <div className="flex items-center gap-2 min-w-0">
                                            {healthIcon(item.health)}
                                            <span className="truncate font-medium">{item.intent_name}</span>
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0 ml-2">
                                            <span className="text-[11px] tabular-nums">
                                                👍{item.positive} 👎{item.negative}
                                            </span>
                                            <span
                                                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold tabular-nums ${
                                                    item.health >= 80
                                                        ? "bg-green-100 text-green-700"
                                                        : item.health >= 50
                                                          ? "bg-amber-100 text-amber-700"
                                                          : "bg-red-100 text-red-700"
                                                }`}
                                            >
                                                {item.health}%
                                            </span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* 评价明细列表 */}
                    <div>
                        <div className="flex items-center gap-2 mb-2">
                            <MessageSquare className="h-4 w-4 text-[hsl(var(--cs-primary))]" />
                            <h4 className="text-xs font-semibold text-[hsl(var(--foreground))]">
                                评价明细
                            </h4>
                        </div>

                        {data.feedback.length === 0 ? (
                            <p className="text-center py-6 text-xs text-[hsl(var(--muted-foreground))]">
                                暂无{filterType !== "all" ? (filterType === "negative" ? "差评" : "好评") : "评价"}记录
                            </p>
                        ) : (
                            <div className="space-y-2 max-h-96 overflow-y-auto">
                                {data.feedback.map((item) => (
                                    <div
                                        key={item.id}
                                        className="rounded-lg border border-[hsl(var(--cs-border))] bg-white p-3 text-xs"
                                    >
                                        {/* 头部：评分 + 时间 + 意图 */}
                                        <div className="flex items-center justify-between mb-2">
                                            <div className="flex items-center gap-2">
                                                {ratingBadge(item.rating)}
                                                {item.intent && (
                                                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
                                                        {item.intent}
                                                    </span>
                                                )}
                                            </div>
                                            <span className="text-[10px] text-[hsl(var(--muted-foreground))]">
                                                {formatDate(item.created_at)}
                                            </span>
                                        </div>

                                        {/* 用户问题 */}
                                        <div className="mb-1.5">
                                            <span className="text-[10px] text-[hsl(var(--muted-foreground))]">
                                                🙋 用户：
                                            </span>
                                            <p className="mt-0.5 text-[hsl(var(--foreground))] leading-relaxed line-clamp-2">
                                                {item.user_message || "(历史消息未找到)"}
                                            </p>
                                        </div>

                                        {/* AI 回答 */}
                                        <div className="mb-1.5">
                                            <span className="text-[10px] text-[hsl(var(--muted-foreground))]">
                                                🤖 AI：
                                            </span>
                                            <p className="mt-0.5 text-[hsl(var(--muted-foreground))] leading-relaxed line-clamp-3">
                                                {item.assistant_message || "(回答未找到)"}
                                            </p>
                                        </div>

                                        {/* 用户评语 */}
                                        {item.comment && (
                                            <div className="rounded-md bg-amber-50 border border-amber-100 px-2.5 py-1.5 mt-1.5">
                                                <span className="text-[10px] text-amber-600 font-medium">
                                                    用户反馈：
                                                </span>
                                                <p className="mt-0.5 text-[11px] text-amber-800 leading-relaxed">
                                                    {item.comment}
                                                </p>
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* 分页 */}
                    {data.pagination.totalPages > 1 && (
                        <div className="flex items-center justify-center gap-2">
                            <button
                                disabled={page <= 1}
                                onClick={() => setPage((p) => p - 1)}
                                className="rounded p-1 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] disabled:opacity-30 transition-colors"
                            >
                                <ChevronLeft className="h-4 w-4" />
                            </button>
                            <span className="text-xs text-[hsl(var(--muted-foreground))]">
                                {page} / {data.pagination.totalPages}
                            </span>
                            <button
                                disabled={page >= data.pagination.totalPages}
                                onClick={() => setPage((p) => p + 1)}
                                className="rounded p-1 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] disabled:opacity-30 transition-colors"
                            >
                                <ChevronRight className="h-4 w-4" />
                            </button>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
