import { useState, useEffect } from "react";
import { X, TrendingUp, MessageSquare, Smile, FileText, Loader2, MessageCircleWarning } from "lucide-react";
import { CustomerFeedbackPanel } from "./CustomerFeedbackPanel";

interface AnalyticsData {
    total_conversations: number;
    today_conversations: number;
    total_messages: number;
    satisfaction_rate: number;
    total_ratings: number;
}

interface CustomerServiceDashboardProps {
    onClose: () => void;
}

type DashboardTab = "overview" | "feedback";

export function CustomerServiceDashboard({ onClose }: CustomerServiceDashboardProps) {
    const [data, setData] = useState<AnalyticsData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<DashboardTab>("overview");

    useEffect(() => {
        async function fetchAnalytics() {
            try {
                const res = await fetch("/api/customer-chat/analytics");
                if (!res.ok) throw new Error("Failed to fetch");
                const json = await res.json();
                setData(json);
            } catch (err) {
                setError(err instanceof Error ? err.message : "加载失败");
            } finally {
                setLoading(false);
            }
        }
        fetchAnalytics();
    }, []);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
            <div className="w-full max-w-2xl max-h-[85vh] rounded-2xl bg-white shadow-2xl animate-fade-in overflow-hidden flex flex-col">
                {/* 头部 */}
                <div className="flex items-center justify-between border-b border-[hsl(var(--cs-border))] bg-gradient-to-r from-[hsl(var(--cs-primary))] to-blue-600 px-6 py-4 shrink-0">
                    <div className="flex items-center gap-2.5">
                        <TrendingUp className="h-5 w-5 text-white" />
                        <h2 className="text-base font-semibold text-white">客服数据概览</h2>
                    </div>
                    <button
                        onClick={onClose}
                        className="rounded-full p-1 text-white/70 hover:text-white hover:bg-white/20 transition-colors"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>

                {/* Tab 切换 */}
                <div className="flex items-center border-b border-[hsl(var(--cs-border))] px-6 shrink-0">
                    <button
                        onClick={() => setActiveTab("overview")}
                        className={`flex items-center gap-1.5 py-2.5 text-xs font-medium border-b-2 transition-colors ${
                            activeTab === "overview"
                                ? "border-[hsl(var(--cs-primary))] text-[hsl(var(--cs-primary))]"
                                : "border-transparent text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
                        }`}
                    >
                        <TrendingUp className="h-3.5 w-3.5" />
                        数据概览
                    </button>
                    <button
                        onClick={() => setActiveTab("feedback")}
                        className={`flex items-center gap-1.5 py-2.5 ml-4 text-xs font-medium border-b-2 transition-colors ${
                            activeTab === "feedback"
                                ? "border-[hsl(var(--cs-primary))] text-[hsl(var(--cs-primary))]"
                                : "border-transparent text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
                        }`}
                    >
                        <MessageCircleWarning className="h-3.5 w-3.5" />
                        反馈管理
                    </button>
                </div>

                {/* 内容区 */}
                <div className="overflow-y-auto px-6 py-6 flex-1">
                    {activeTab === "overview" && (
                        <>
                            {loading && (
                                <div className="flex items-center justify-center py-12">
                                    <Loader2 className="h-6 w-6 animate-spin text-[hsl(var(--muted-foreground))]" />
                                </div>
                            )}

                            {error && (
                                <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">
                                    {error}
                                </div>
                            )}

                            {data && (
                                <div className="space-y-5">
                                    {/* 指标卡片 */}
                                    <div className="grid grid-cols-2 gap-3">
                                        <div className="rounded-xl border border-[hsl(var(--cs-border))] bg-[hsl(var(--cs-bg))] p-4">
                                            <div className="flex items-center gap-2 mb-2">
                                                <MessageSquare className="h-4 w-4 text-[hsl(var(--cs-primary))]" />
                                                <span className="text-[11px] font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">
                                                    总会话数
                                                </span>
                                            </div>
                                            <p className="text-2xl font-bold text-[hsl(var(--foreground))]">
                                                {data.total_conversations.toLocaleString()}
                                            </p>
                                        </div>

                                        <div className="rounded-xl border border-[hsl(var(--cs-border))] bg-[hsl(var(--cs-bg))] p-4">
                                            <div className="flex items-center gap-2 mb-2">
                                                <TrendingUp className="h-4 w-4 text-green-500" />
                                                <span className="text-[11px] font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">
                                                    今日会话
                                                </span>
                                            </div>
                                            <p className="text-2xl font-bold text-[hsl(var(--foreground))]">
                                                {data.today_conversations.toLocaleString()}
                                            </p>
                                        </div>

                                        <div className="rounded-xl border border-[hsl(var(--cs-border))] bg-[hsl(var(--cs-bg))] p-4">
                                            <div className="flex items-center gap-2 mb-2">
                                                <FileText className="h-4 w-4 text-amber-500" />
                                                <span className="text-[11px] font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">
                                                    总消息数
                                                </span>
                                            </div>
                                            <p className="text-2xl font-bold text-[hsl(var(--foreground))]">
                                                {data.total_messages.toLocaleString()}
                                            </p>
                                        </div>

                                        <div className="rounded-xl border border-[hsl(var(--cs-border))] bg-[hsl(var(--cs-bg))] p-4">
                                            <div className="flex items-center gap-2 mb-2">
                                                <Smile className="h-4 w-4 text-[hsl(var(--cs-success))]" />
                                                <span className="text-[11px] font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">
                                                    满意率
                                                </span>
                                            </div>
                                            <p className="text-2xl font-bold text-[hsl(var(--foreground))]">
                                                {data.total_ratings > 0
                                                    ? `${data.satisfaction_rate}%`
                                                    : "--"}
                                            </p>
                                            {data.total_ratings > 0 && (
                                                <p className="text-[10px] text-[hsl(var(--muted-foreground))] mt-0.5">
                                                    共 {data.total_ratings} 条评价
                                                </p>
                                            )}
                                        </div>
                                    </div>

                                    {/* 说明 */}
                                    <div className="rounded-lg bg-[hsl(var(--cs-primary-light))] px-4 py-3">
                                        <p className="text-xs text-[hsl(var(--cs-primary))] leading-relaxed">
                                            💡 提示：以上数据涵盖所有匿名客服会话。满意率基于客户提交的满意度评价计算。
                                            点击"反馈管理"标签查看评价详情和 FAQ 健康度。
                                        </p>
                                    </div>
                                </div>
                            )}
                        </>
                    )}

                    {activeTab === "feedback" && <CustomerFeedbackPanel />}
                </div>
            </div>
        </div>
    );
}
