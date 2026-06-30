// 查询历史列表 —— 侧边栏展示，使用 localStorage 存储本地查询历史
import { History, Search, Clock, Trash2 } from "lucide-react";

// ── 类型 ──────────────────────────────────────────

export interface QueryHistoryItem {
  id: string;
  query: string;
  method: string;
  timestamp: string;
  resultCount: number;
}

// ── localStorage 工具 ─────────────────────────────

const STORAGE_KEY = "agentforge_hit_testing_history";
const MAX_HISTORY = 20;

export function loadHistory(): QueryHistoryItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is QueryHistoryItem =>
        typeof item === "object" &&
        item !== null &&
        typeof item.id === "string" &&
        typeof item.query === "string" &&
        typeof item.method === "string" &&
        typeof item.timestamp === "string" &&
        typeof item.resultCount === "number",
    );
  } catch {
    return [];
  }
}

function saveHistory(history: QueryHistoryItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
  } catch {
    // localStorage 写入失败时静默处理
  }
}

export function addQueryToHistory(item: Omit<QueryHistoryItem, "id" | "timestamp">): void {
  const history = loadHistory();
  const entry: QueryHistoryItem = {
    ...item,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  };
  const updated = [entry, ...history];
  saveHistory(updated);
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage 清理失败时静默处理
  }
}

// ── 时间格式化 ──────────────────────────────────────

function formatTime(isoString: string): string {
  try {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHour = Math.floor(diffMs / 3600000);

    if (diffMin < 1) return "刚刚";
    if (diffMin < 60) return `${diffMin} 分钟前`;
    if (diffHour < 24) return `${diffHour} 小时前`;

    const month = date.getMonth() + 1;
    const day = date.getDate();
    return `${month}月${day}日`;
  } catch {
    return "";
  }
}

// ── 检索方法标签映射 ──────────────────────────────

const METHOD_LABELS: Record<string, string> = {
  hybrid: "混合",
  semantic: "语义",
  keyword: "关键词",
};

// ── Props ────────────────────────────────────────

interface QueryHistoryListProps {
  queries: QueryHistoryItem[];
  onSelect: (query: string) => void;
  onClear: () => void;
}

// ── 组件 ──────────────────────────────────────────

export function QueryHistoryList({
  queries,
  onSelect,
  onClear,
}: QueryHistoryListProps) {
  if (queries.length === 0) {
    return (
      <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-4">
        <div className="flex items-center gap-2 mb-3">
          <History className="h-3.5 w-3.5 text-muted-foreground" />
          <h4 className="text-xs font-semibold text-foreground">查询历史</h4>
        </div>
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <Search className="h-6 w-6 text-muted-foreground opacity-20 mb-2" />
          <p className="text-[11px] text-muted-foreground">
            暂无查询历史
          </p>
          <p className="text-[10px] text-muted-foreground/60 mt-0.5">
            执行检索测试后此处将显示历史记录
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] overflow-hidden">
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[hsl(var(--border))]">
        <div className="flex items-center gap-2">
          <History className="h-3.5 w-3.5 text-muted-foreground" />
          <h4 className="text-xs font-semibold text-foreground">查询历史</h4>
          <span className="text-[10px] text-muted-foreground">
            {queries.length}
          </span>
        </div>
        <button
          onClick={onClear}
          className="rounded p-1 text-muted-foreground hover:text-red-500 transition-colors"
          title="清空历史"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>

      {/* 历史列表 */}
      <div className="overflow-y-auto max-h-96">
        {queries.map((item) => (
          <button
            key={item.id}
            onClick={() => onSelect(item.query)}
            className="w-full text-left px-4 py-2.5 border-b border-[hsl(var(--border))]/50 last:border-b-0
              hover:bg-[hsl(var(--accent))] transition-colors group"
          >
            <p className="text-[11px] text-foreground leading-relaxed line-clamp-2 mb-1">
              {item.query}
            </p>
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-0.5">
                <Clock className="h-2.5 w-2.5" />
                {formatTime(item.timestamp)}
              </span>
              <span>|</span>
              <span>{METHOD_LABELS[item.method] ?? item.method}</span>
              <span>|</span>
              <span>{item.resultCount} 条结果</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
