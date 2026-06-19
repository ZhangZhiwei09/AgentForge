// LLM 追踪页面 —— 跳转到 Langfuse UI
// 不做 iframe 嵌入：Langfuse 默认配置 X-Frame-Options / CSP 会阻止
import { ExternalLink } from "lucide-react";

// 默认指向本地自托管 Langfuse；可通过 Vite 环境变量 VITE_LANGFUSE_URL 覆盖
const LANGFUSE_URL = "http://localhost:3000";

export function ObservabilityPage() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 text-center p-8">
      <EyeIcon />
      <div>
        <h2 className="text-lg font-semibold mb-2">Langfuse LLM 可观测性</h2>
        <p className="text-sm text-[hsl(var(--muted-foreground))] max-w-md">
          Langfuse 提供每次对话的 Trace、Token 用量、延迟等详细信息。
          点击下方按钮在新窗口打开。
        </p>
      </div>
      <a
        href={LANGFUSE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-[hsl(var(--cs-primary))] text-white hover:opacity-90 transition-opacity text-sm font-medium"
      >
        <ExternalLink className="h-4 w-4" />
        打开 Langfuse
      </a>
      <p className="text-xs text-[hsl(var(--muted-foreground))]">
        {LANGFUSE_URL}
      </p>
    </div>
  );
}

function EyeIcon() {
  return (
    <svg
      width="48"
      height="48"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-[hsl(var(--muted-foreground))]"
    >
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
