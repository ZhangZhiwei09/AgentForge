// 查询输入组件 —— 文本输入 / 检索方法选择 / 配置弹窗
import { useState, useCallback } from "react";
import type { HitTestingRequestDTO } from "@agentforge/shared-types";
import { Search, Play, Settings, ChevronDown } from "lucide-react";
import { RetrievalConfigPopover } from "./RetrievalConfigPopover";

// ── 检索方法选项 ──────────────────────────────────

const RETRIEVAL_METHODS = [
  { value: "hybrid" as const, label: "混合检索" },
  { value: "semantic" as const, label: "语义检索" },
  { value: "keyword" as const, label: "关键词检索" },
];

// ── Props ────────────────────────────────────────

interface QueryInputProps {
  onSubmit: (query: string, config: HitTestingRequestDTO) => void;
  loading: boolean;
  defaultMethod?: string;
}

// ── 组件 ──────────────────────────────────────────

export function QueryInput({
  onSubmit,
  loading,
  defaultMethod = "hybrid",
}: QueryInputProps) {
  const [query, setQuery] = useState("");
  const [config, setConfig] = useState<HitTestingRequestDTO>({
    query: "",
    topK: 10,
    searchMethod: "hybrid",
    rerankingEnable: true,
    scoreThreshold: 0,
  });
  const [showConfig, setShowConfig] = useState(false);
  const [showMethodDropdown, setShowMethodDropdown] = useState(false);

  const currentMethodLabel =
    RETRIEVAL_METHODS.find((m) => m.value === config.searchMethod)?.label ??
    "混合检索";

  const handleSubmit = useCallback(() => {
    const trimmed = query.trim();
    if (!trimmed || loading) return;
    onSubmit(trimmed, { ...config, query: trimmed });
  }, [query, loading, config, onSubmit]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleConfigChange = (newConfig: HitTestingRequestDTO) => {
    setConfig(newConfig);
  };

  const selectMethod = (method: HitTestingRequestDTO["searchMethod"]) => {
    setConfig((prev) => ({ ...prev, searchMethod: method }));
    setShowMethodDropdown(false);
  };

  return (
    <div className="relative rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-0.5 shadow-sm">
      <div className="rounded-[11px] bg-[hsl(var(--muted))]/50 p-3">
        {/* 顶部操作栏 */}
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
            检索测试
          </span>
          <div className="flex items-center gap-1.5">
            {/* 检索方法选择器 */}
            <div className="relative">
              <button
                onClick={() => setShowMethodDropdown(!showMethodDropdown)}
                className="flex items-center gap-1 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--accent))] transition-colors"
              >
                <Search className="h-3 w-3" />
                <span>{currentMethodLabel}</span>
                <ChevronDown
                  className={`h-3 w-3 transition-transform ${
                    showMethodDropdown ? "rotate-180" : ""
                  }`}
                />
              </button>

              {/* 下拉菜单 */}
              {showMethodDropdown && (
                <div className="absolute right-0 top-full z-40 mt-1 w-36 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] py-1 shadow-lg animate-fade-in">
                  {RETRIEVAL_METHODS.map((method) => (
                    <button
                      key={method.value}
                      onClick={() => selectMethod(method.value)}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-[11px] transition-colors hover:bg-[hsl(var(--accent))] ${
                        config.searchMethod === method.value
                          ? "text-foreground font-medium"
                          : "text-muted-foreground"
                      }`}
                    >
                      <span
                        className={`inline-block h-1.5 w-1.5 rounded-full ${
                          config.searchMethod === method.value
                            ? "bg-[hsl(var(--primary))]"
                            : "bg-transparent"
                        }`}
                      />
                      {method.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 配置齿轮按钮 */}
            <div className="relative">
              <button
                onClick={() => setShowConfig(!showConfig)}
                className={`rounded-md p-1 transition-colors ${
                  showConfig
                    ? "bg-[hsl(var(--accent))] text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--accent))]"
                }`}
                title="检索配置"
              >
                <Settings className="h-3.5 w-3.5" />
              </button>

              {showConfig && (
                <RetrievalConfigPopover
                  config={config}
                  onChange={handleConfigChange}
                  onClose={() => setShowConfig(false)}
                />
              )}
            </div>
          </div>
        </div>

        {/* 输入区域 */}
        <div className="flex items-end gap-2">
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入测试查询..."
            rows={3}
            className="flex-1 resize-none rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ring))]"
          />
          <button
            onClick={handleSubmit}
            disabled={!query.trim() || loading}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:opacity-40 transition-opacity"
            title="发送查询"
          >
            {loading ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              <Play className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
