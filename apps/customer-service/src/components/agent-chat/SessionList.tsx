import { useState, useEffect, useCallback } from "react";
import {
  Plus,
  Trash2,
  PanelLeftClose,
  PanelLeftOpen,
  MessageSquare,
  MessageCircle,
} from "lucide-react";

interface ConversationSummary {
  id: string;
  title: string;
  session_id: string;
  created_at: string;
  updated_at: string;
  first_message: string | null;
}

interface SessionListProps {
  activeConversationId: string;
  onSelectConversation: (conversationId: string) => void;
  onNewChat: () => void;
  /** 外部触发刷新（如对话完成后递增） */
  refreshTrigger?: number;
}

export function SessionList({
  activeConversationId,
  onSelectConversation,
  onNewChat,
  refreshTrigger,
}: SessionListProps) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchConversations = useCallback(async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem("accessToken");
      const headers: Record<string, string> = {};
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }

      const res = await fetch("/api/agent/chat/conversations", { headers });
      if (!res.ok) return;

      const data = await res.json();
      if (data.conversations && Array.isArray(data.conversations)) {
        setConversations(data.conversations);
      }
    } catch {
      // 加载失败则保持当前列表
    } finally {
      setLoading(false);
    }
  }, []);

  // 初始加载
  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  // 外部触发刷新（如对话完成后）
  useEffect(() => {
    if (refreshTrigger !== undefined && refreshTrigger > 0) {
      fetchConversations();
    }
  }, [refreshTrigger, fetchConversations]);

  // 新建对话后刷新列表
  function handleNewChat() {
    onNewChat();
    setTimeout(() => fetchConversations(), 500);
  }

  async function handleDelete(convId: string) {
    const token = localStorage.getItem("accessToken");
    if (!token) return;

    try {
      const res = await fetch(`/api/agent/chat/conversations/${convId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;

      // 从列表中移除
      setConversations((prev) => prev.filter((c) => c.id !== convId));

      // 如果删除的是当前活跃会话，开启新对话
      if (convId === activeConversationId) {
        onNewChat();
      }
    } catch {
      // 删除失败静默处理
    }
  }

  function formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return "今天";
    if (diffDays === 1) return "昨天";
    if (diffDays < 7) return `${diffDays} 天前`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} 周前`;
    return date.toLocaleDateString("zh-CN", {
      month: "short",
      day: "numeric",
    });
  }

  function getDisplayTitle(conv: ConversationSummary): string {
    if (conv.title && conv.title !== "智能助手会话" && conv.title !== "新对话") return conv.title;
    if (conv.first_message) {
      return conv.first_message.length > 30
        ? conv.first_message.slice(0, 30) + "..."
        : conv.first_message;
    }
    return "新对话";
  }

  return (
    <>
      {/* 折叠状态：显示一个窄条 + 展开按钮 */}
      {collapsed ? (
        <div className="flex flex-col items-center border-r border-[hsl(var(--cs-border))] bg-white py-3 w-12">
          <button
            onClick={() => setCollapsed(false)}
            className="rounded-lg p-1.5 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--cs-bg))] transition-colors"
            title="展开会话列表"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <aside className="flex w-72 flex-col border-r border-[hsl(var(--cs-border))] bg-white">
          {/* 顶部：新对话 + 折叠 */}
          <div className="border-b border-[hsl(var(--cs-border))] px-4 py-4">
            <div className="mb-3 flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[hsl(var(--cs-primary))] text-white">
                <MessageCircle className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-semibold text-[hsl(var(--foreground))]">
                  对话工作台
                </p>
                <p className="text-[10px] text-[hsl(var(--muted-foreground))]">
                  管理排障会话与上下文
                </p>
              </div>
            </div>
            <button
              onClick={handleNewChat}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-[hsl(var(--cs-primary))] px-3 py-2 text-xs font-medium text-white shadow-sm transition-colors hover:bg-[hsl(var(--cs-primary-dark))]"
            >
              <Plus className="h-3.5 w-3.5" />
              新对话
            </button>
            <button
              onClick={() => setCollapsed(true)}
              className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[10px] text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--cs-bg))] hover:text-[hsl(var(--foreground))]"
              title="折叠会话列表"
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
              收起会话列表
            </button>
          </div>

          {/* 会话列表 */}
          <div className="flex-1 overflow-y-auto px-2 py-3">
            <div className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[hsl(var(--muted-foreground))]">
              最近会话
            </div>
            {loading && conversations.length === 0 ? (
              <div className="px-3 py-8 text-center text-xs text-[hsl(var(--muted-foreground))]">
                加载中...
              </div>
            ) : conversations.length === 0 ? (
              <div className="px-3 py-8 text-center text-xs text-[hsl(var(--muted-foreground))]">
                暂无历史对话
              </div>
            ) : (
              conversations.map((conv) => {
                const isActive = conv.id === activeConversationId;
                return (
                  <div
                    key={conv.id}
                    className="relative"
                    onMouseEnter={() => setHoveredId(conv.id)}
                    onMouseLeave={() => setHoveredId(null)}
                  >
                    <button
                      onClick={() => onSelectConversation(conv.id)}
                      className={`w-full text-left px-3 py-2.5 transition-colors ${
                        isActive
                          ? "bg-[hsl(var(--cs-primary))]/10 shadow-[inset_3px_0_hsl(var(--cs-primary))]"
                          : "hover:bg-[hsl(var(--cs-bg))]"
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <MessageSquare
                          className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${
                            isActive
                              ? "text-[hsl(var(--cs-primary))]"
                              : "text-[hsl(var(--muted-foreground))]"
                          }`}
                        />
                        <div className="flex-1 min-w-0">
                          <p
                            className={`text-xs truncate ${
                              isActive
                                ? "font-medium text-[hsl(var(--cs-primary))]"
                                : "text-[hsl(var(--foreground))]"
                            }`}
                          >
                            {getDisplayTitle(conv)}
                          </p>
                          <p className="text-[10px] text-[hsl(var(--muted-foreground))] mt-0.5">
                            {formatDate(conv.created_at)}
                          </p>
                        </div>
                      </div>
                    </button>

                    {/* 删除按钮（hover 时显示） */}
                    {hoveredId === conv.id && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(conv.id);
                        }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-[hsl(var(--muted-foreground))] hover:text-red-500 hover:bg-red-50 transition-colors"
                        title="删除会话"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </aside>
      )}
    </>
  );
}
