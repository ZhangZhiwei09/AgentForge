import { useState, useEffect } from "react";
import {
    TrendingUp,
    MessageSquare,
    Smile,
    FileText,
    Loader2,
    MessageCircleWarning,
    BarChart3,
    ArrowLeft,
} from "lucide-react";
import { Link } from "react-router-dom";
import { CustomerFeedbackPanel } from "@/components/customer-chat/CustomerFeedbackPanel";

interface AnalyticsData {
    total_conversations: number;
    today_conversations: number;
    total_messages: number;
    satisfaction_rate: number;
    total_ratings: number;
}

type AdminTab = "overview" | "feedback";

export function CSAdminPage() {
    const [data, setData] = useState<AnalyticsData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<AdminTab>("overview");

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
        <div className="flex-1 overflow-y-auto bg-[hsl(var(--cs-bg))]">
            {/* 顶部导航 */}
            <div className="bg-white border-b border-[hsl(var(--cs-border))] px-8 py-4">
                <div className="flex items-center justify-between max-w-6xl mx-auto">
                    <div className="flex items-center gap-4">
                        <Link
                            to="/"
                            className="flex items-center gap-1.5 text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-colors"
                        >
                            <ArrowLeft className="h-3.5 w-3.5" />
                            返回客服
                        </Link>
                        <div className="w-px h-4 bg-[hsl(var(--cs-border))]" />
                        <div className="flex items-center gap-2">
                            <BarChart3 className="h-5 w-5 text-[hsl(var(--cs-primary))]" />
                            <h1 className="text-lg font-semibold text-[hsl(var(--foreground))]">
                                客服管理后台
                            </h1>
                        </div>
                    </div>
                    <span className="text-[11px] text-[hsl(var(--muted-foreground))]">
                        实时数据 · 更新于 {new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                </div>
            </div>

            <div className="max-w-6xl mx-auto px-8 py-6 space-y-6">
                {/* Tab 切换 */}
                <div className="flex items-center gap-1 border-b border-[hsl(var(--cs-border))]">
                    <button
                        onClick={() => setActiveTab("overview")}
                        className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                            activeTab === "overview"
                                ? "border-[hsl(var(--cs-primary))] text-[hsl(var(--cs-primary))]"
                                : "border-transparent text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
                        }`}
                    >
                        <BarChart3 className="h-4 w-4" />
                        数据概览
                    </button>
                    <button
                        onClick={() => setActiveTab("feedback")}
                        className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                            activeTab === "feedback"
                                ? "border-[hsl(var(--cs-primary))] text-[hsl(var(--cs-primary))]"
                                : "border-transparent text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
                        }`}
                    >
                        <MessageCircleWarning className="h-4 w-4" />
                        反馈管理
                    </button>
                </div>

                {/* 概览 Tab */}
                {activeTab === "overview" && (
                    <>
                        {loading && (
                            <div className="flex items-center justify-center py-20">
                                <Loader2 className="h-6 w-6 animate-spin text-[hsl(var(--muted-foreground))]" />
                            </div>
                        )}

                        {error && (
                            <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
                        )}

                        {data && (
                            <div className="space-y-6">
                                {/* 核心指标卡片 */}
                                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                                    <div className="rounded-xl border border-[hsl(var(--cs-border))] bg-white p-5 shadow-sm">
                                        <div className="flex items-center gap-3 mb-3">
                                            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50">
                                                <MessageSquare className="h-5 w-5 text-[hsl(var(--cs-primary))]" />
                                            </div>
                                            <div>
                                                <p className="text-[11px] font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">
                                                    总会话数
                                                </p>
                                                <p className="text-2xl font-bold text-[hsl(var(--foreground))]">
                                                    {data.total_conversations.toLocaleString()}
                                                </p>
                                            </div>
                                        </div>
                                        <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
                                            所有匿名客服会话总数
                                        </p>
                                    </div>

                                    <div className="rounded-xl border border-[hsl(var(--cs-border))] bg-white p-5 shadow-sm">
                                        <div className="flex items-center gap-3 mb-3">
                                            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-50">
                                                <TrendingUp className="h-5 w-5 text-green-500" />
                                            </div>
                                            <div>
                                                <p className="text-[11px] font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">
                                                    今日会话
                                                </p>
                                                <p className="text-2xl font-bold text-[hsl(var(--foreground))]">
                                                    {data.today_conversations.toLocaleString()}
                                                </p>
                                            </div>
                                        </div>
                                        <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
                                            今日 00:00 至今的新会话
                                        </p>
                                    </div>

                                    <div className="rounded-xl border border-[hsl(var(--cs-border))] bg-white p-5 shadow-sm">
                                        <div className="flex items-center gap-3 mb-3">
                                            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-50">
                                                <FileText className="h-5 w-5 text-amber-500" />
                                            </div>
                                            <div>
                                                <p className="text-[11px] font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">
                                                    总消息数
                                                </p>
                                                <p className="text-2xl font-bold text-[hsl(var(--foreground))]">
                                                    {data.total_messages.toLocaleString()}
                                                </p>
                                            </div>
                                        </div>
                                        <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
                                            用户+AI 消息总量
                                        </p>
                                    </div>

                                    <div className="rounded-xl border border-[hsl(var(--cs-border))] bg-white p-5 shadow-sm">
                                        <div className="flex items-center gap-3 mb-3">
                                            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-50">
                                                <Smile className="h-5 w-5 text-[hsl(var(--cs-success))]" />
                                            </div>
                                            <div>
                                                <p className="text-[11px] font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">
                                                    满意率
                                                </p>
                                                <p className="text-2xl font-bold text-[hsl(var(--foreground))]">
                                                    {data.total_ratings > 0
                                                        ? `${data.satisfaction_rate}%`
                                                        : "--"}
                                                </p>
                                            </div>
                                        </div>
                                        <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
                                            {data.total_ratings > 0
                                                ? `共 ${data.total_ratings} 条评价`
                                                : "暂无评价数据"}
                                        </p>
                                    </div>
                                </div>

                                {/* 说明卡片 */}
                                <div className="rounded-xl border border-[hsl(var(--cs-border))] bg-[hsl(var(--cs-primary-light))] p-5">
                                    <h3 className="text-sm font-semibold text-[hsl(var(--cs-primary))] mb-2">
                                        💡 反馈闭环流程
                                    </h3>
                                    <div className="flex items-center gap-3 text-xs text-[hsl(var(--cs-primary))]/80">
                                        <span className="rounded-full bg-white px-3 py-1 shadow-sm">
                                            1. 用户评价 → 数据入库
                                        </span>
                                        <span className="text-[hsl(var(--cs-primary))]/40">→</span>
                                        <span className="rounded-full bg-white px-3 py-1 shadow-sm">
                                            2. 低分 FAQ 自动标红
                                        </span>
                                        <span className="text-[hsl(var(--cs-primary))]/40">→</span>
                                        <span className="rounded-full bg-white px-3 py-1 shadow-sm">
                                            3. 运营修改知识库
                                        </span>
                                        <span className="text-[hsl(var(--cs-primary))]/40">→</span>
                                        <span className="rounded-full bg-white px-3 py-1 shadow-sm">
                                            4. 回答质量提升 ↑
                                        </span>
                                    </div>
                                </div>
                            </div>
                        )}
                    </>
                )}

                {/* 反馈管理 Tab */}
                {activeTab === "feedback" && (
                    <div className="rounded-xl border border-[hsl(var(--cs-border))] bg-white p-5 shadow-sm">
                        <CustomerFeedbackPanel />
                    </div>
                )}
            </div>
        </div>
    );
}
