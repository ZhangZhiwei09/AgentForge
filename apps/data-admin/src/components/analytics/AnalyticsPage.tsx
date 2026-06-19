// 数据分析页面 —— 客服统计卡片 + 反馈列表
import { useState, useEffect } from "react";
import {
  MessageCircle,
  ThumbsUp,
  MessageSquare,
  TrendingUp,
  Loader2,
} from "lucide-react";

interface AnalyticsData {
  total_conversations: number;
  today_conversations: number;
  total_messages: number;
  satisfaction_rate: number;
  total_ratings: number;
}

interface FeedbackItem {
  id: string;
  rating: string;
  comment: string | null;
  created_at: string;
  session_id: string;
  intent: string | null;
  user_message: string;
  assistant_message: string;
}

interface FeedbackResponse {
  feedback: FeedbackItem[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export function AnalyticsPage() {
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [feedback, setFeedback] = useState<FeedbackResponse | null>(null);
  const [filter, setFilter] = useState<"all" | "positive" | "negative">("all");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = localStorage.getItem("accessToken");
    const headers: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};

    async function fetchData() {
      setLoading(true);
      setError(null);
      try {
        const [analyticsRes, feedbackRes] = await Promise.all([
          fetch("/api/agent/chat/analytics", { headers }),
          fetch(
            `/api/agent/chat/feedback?type=${filter}&page=${page}&limit=15`,
            { headers },
          ),
        ]);

        if (analyticsRes.ok) setAnalytics(await analyticsRes.json());
        if (feedbackRes.ok) setFeedback(await feedbackRes.json());
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [filter, page]);

  const stats = [
    { label: "总会话数", value: analytics?.total_conversations ?? "-", icon: MessageCircle, color: "text-blue-600 bg-blue-50" },
    { label: "今日会话", value: analytics?.today_conversations ?? "-", icon: TrendingUp, color: "text-green-600 bg-green-50" },
    { label: "总消息数", value: analytics?.total_messages ?? "-", icon: MessageSquare, color: "text-purple-600 bg-purple-50" },
    { label: "满意率", value: analytics ? `${analytics.satisfaction_rate}%` : "-", icon: ThumbsUp, color: "text-amber-600 bg-amber-50" },
  ];

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <h2 className="text-lg font-semibold">数据分析</h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-4">
            <div className="flex items-center gap-3">
              <div className={`rounded-lg p-2 ${stat.color}`}>
                <stat.icon className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs text-[hsl(var(--muted-foreground))]">{stat.label}</p>
                <p className="text-xl font-bold">
                  {loading ? <Loader2 className="h-4 w-4 animate-spin inline" /> : stat.value}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Feedback Table */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium">用户反馈</h3>
          <div className="flex gap-1">
            {(["all", "positive", "negative"] as const).map((f) => (
              <button
                key={f}
                onClick={() => { setFilter(f); setPage(1); }}
                className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                  filter === f
                    ? "bg-[hsl(var(--cs-primary))] text-white"
                    : "text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]"
                }`}
              >
                {f === "all" ? "全部" : f === "positive" ? "正面" : "负面"}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 mb-3">
            <p className="text-xs text-red-600">{error}</p>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-[hsl(var(--muted-foreground))]" />
          </div>
        ) : feedback && feedback.feedback.length > 0 ? (
          <>
            <div className="rounded-lg border border-[hsl(var(--border))] overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[hsl(var(--border))] bg-[hsl(var(--muted))]/50">
                    <th className="text-left px-3 py-2 text-xs font-medium text-[hsl(var(--muted-foreground))]">评价</th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-[hsl(var(--muted-foreground))]">用户消息</th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-[hsl(var(--muted-foreground))]">客服回复</th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-[hsl(var(--muted-foreground))]">时间</th>
                  </tr>
                </thead>
                <tbody>
                  {feedback.feedback.map((item) => (
                    <tr key={item.id} className="border-b border-[hsl(var(--border))] last:border-0 hover:bg-[hsl(var(--muted))]/30">
                      <td className="px-3 py-2">
                        <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${
                          item.rating === "positive" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                        }`}>
                          {item.rating === "positive" ? "👍" : "👎"}
                        </span>
                      </td>
                      <td className="px-3 py-2 max-w-[200px] truncate text-xs">{item.user_message}</td>
                      <td className="px-3 py-2 max-w-[250px] truncate text-xs text-[hsl(var(--muted-foreground))]">{item.assistant_message}</td>
                      <td className="px-3 py-2 text-xs text-[hsl(var(--muted-foreground))] whitespace-nowrap">
                        {item.created_at ? new Date(item.created_at).toLocaleDateString("zh-CN") : "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {feedback.pagination.totalPages > 1 && (
              <div className="flex items-center justify-between mt-3">
                <span className="text-xs text-[hsl(var(--muted-foreground))]">共 {feedback.pagination.total} 条</span>
                <div className="flex gap-1">
                  <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}
                    className="rounded px-2 py-1 text-xs border disabled:opacity-40 hover:bg-[hsl(var(--muted))]">上一页</button>
                  <span className="px-2 py-1 text-xs text-[hsl(var(--muted-foreground))]">{page} / {feedback.pagination.totalPages}</span>
                  <button onClick={() => setPage((p) => Math.min(feedback.pagination.totalPages, p + 1))}
                    disabled={page >= feedback.pagination.totalPages}
                    className="rounded px-2 py-1 text-xs border disabled:opacity-40 hover:bg-[hsl(var(--muted))]">下一页</button>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="rounded-lg border border-[hsl(var(--border))] p-12 text-center">
            <p className="text-sm text-[hsl(var(--muted-foreground))]">暂无反馈数据</p>
          </div>
        )}
      </div>
    </div>
  );
}
