import { Clock, MessageSquare, Hash, Trash2, BarChart3 } from "lucide-react";
import type { CSMessage } from "@/hooks/useCustomerChatStream";

interface ChatSessionInfoProps {
  sessionId: string;
  messages: CSMessage[];
  onClear: () => void;
  onDashboard?: () => void;
}

export function ChatSessionInfo({
  sessionId,
  messages,
  onClear,
  onDashboard,
}: ChatSessionInfoProps) {
  const userMsgCount = messages.filter((m) => m.role === "user").length;
  const aiMsgCount = messages.filter(
    (m) => m.role === "assistant" && m.id !== "welcome",
  ).length;
  const sessionStart =
    messages.length > 1
      ? new Date(messages[1]?.timestamp || Date.now()).toLocaleTimeString(
          "zh-CN",
          {
            hour: "2-digit",
            minute: "2-digit",
          },
        )
      : "--";

  return (
    <div className="flex h-full flex-col">
      {/* 标题 */}
      <div className="border-b border-[hsl(var(--cs-border))] px-4 py-3">
        <h3 className="text-sm font-semibold text-[hsl(var(--foreground))]">
          会话信息
        </h3>
      </div>

      {/* 信息列表 */}
      <div className="flex-1 space-y-3 px-4 py-4">
        <div className="space-y-1.5">
          <label className="text-[10px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
            会话 ID
          </label>
          <div className="flex items-center gap-1.5 rounded-lg bg-[hsl(var(--cs-bg))] px-2.5 py-1.5">
            <Hash className="h-3 w-3 text-[hsl(var(--muted-foreground))] shrink-0" />
            <code className="text-[11px] text-[hsl(var(--muted-foreground))] truncate">
              {sessionId.slice(0, 12)}...
            </code>
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-[10px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
            会话时间
          </label>
          <div className="flex items-center gap-1.5 rounded-lg bg-[hsl(var(--cs-bg))] px-2.5 py-1.5">
            <Clock className="h-3 w-3 text-[hsl(var(--muted-foreground))]" />
            <span className="text-xs text-[hsl(var(--foreground))]">
              {sessionStart}
            </span>
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-[10px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
            消息统计
          </label>
          <div className="flex items-center gap-1.5 rounded-lg bg-[hsl(var(--cs-bg))] px-2.5 py-1.5">
            <MessageSquare className="h-3 w-3 text-[hsl(var(--muted-foreground))]" />
            <span className="text-xs text-[hsl(var(--foreground))]">
              用户 {userMsgCount} 条 · AI {aiMsgCount} 条
            </span>
          </div>
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="border-t border-[hsl(var(--cs-border))] px-4 py-3 space-y-2">
        {onDashboard && (
          <button
            onClick={onDashboard}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-[hsl(var(--cs-border))] px-3 py-2 text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--cs-bg))] transition-colors"
          >
            <BarChart3 className="h-3.5 w-3.5" />
            服务数据
          </button>
        )}
        <button
          onClick={onClear}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-red-200 px-3 py-2 text-xs text-red-500 hover:bg-red-50 transition-colors"
        >
          <Trash2 className="h-3.5 w-3.5" />
          清空对话
        </button>
      </div>
    </div>
  );
}
