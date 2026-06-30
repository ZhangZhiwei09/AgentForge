// 命中测试页面 —— 整合查询输入 / 结果列表 / 查询历史
import { useState, useCallback, useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import type { HitTestingRequestDTO, HitTestingResultDTO, HitTestingResponseDTO } from "@agentforge/shared-types";
import { AgentForgeClient } from "@agentforge/sdk";
import { FlaskConical } from "lucide-react";
import { QueryInput } from "./QueryInput";
import { ResultList } from "./ResultList";
import { ResultDetailModal } from "./ResultDetailModal";
import {
  QueryHistoryList,
  loadHistory,
  addQueryToHistory,
  clearHistory,
} from "./QueryHistoryList";
import type { QueryHistoryItem } from "./QueryHistoryList";

// ── Props ────────────────────────────────────────

interface HitTestingPageProps {
  kbId: string;
  kbName: string;
}

// ── SDK 客户端（单例） ─────────────────────────────

let clientInstance: AgentForgeClient | null = null;

function getClient(): AgentForgeClient {
  if (!clientInstance) {
    clientInstance = new AgentForgeClient({
      baseUrl: "",
      getAccessToken: () => localStorage.getItem("accessToken"),
      onAuthError: () => {
        localStorage.removeItem("accessToken");
        if (window.location.pathname !== "/login") {
          window.location.href = "/login";
        }
      },
    });
  }
  return clientInstance;
}

// ── 组件 ──────────────────────────────────────────

export function HitTestingPage({ kbId, kbName }: HitTestingPageProps) {
  // 结果状态
  const [results, setResults] = useState<HitTestingResultDTO[] | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | undefined>();

  // 查询历史
  const [history, setHistory] = useState<QueryHistoryItem[]>(() => loadHistory());

  // 详情模态框
  const [detailResult, setDetailResult] = useState<HitTestingResultDTO | null>(null);
  const [showDetail, setShowDetail] = useState(false);

  // 当前查询（用于重试）
  const [lastRequest, setLastRequest] = useState<{
    query: string;
    config: HitTestingRequestDTO;
  } | null>(null);

  // 客户端
  const client = useMemo(() => getClient(), []);

  // React Query mutation
  const mutation = useMutation({
    mutationFn: async (params: { query: string; config: HitTestingRequestDTO }) => {
      const response = await client.hitTest(kbId, params.config);
      // 后端返回 snake_case 键名，转换为 camelCase 以匹配 DTO 类型
      const raw = response as unknown as {
        query: { content: string };
        results: Array<{
          chunk_id: string;
          content: string;
          score: number;
          fusion_score?: number;
          rerank_score?: number;
          recall_sources: string[];
          chunk_index: number;
          document: { id: string; title: string };
          parent_chunk?: { id: string; content: string } | null;
        }>;
        elapsed_ms: number;
      };
      return {
        query: raw.query,
        results: raw.results.map((r) => ({
          chunkId: r.chunk_id,
          content: r.content,
          score: r.score,
          fusionScore: r.fusion_score,
          rerankScore: r.rerank_score,
          recallSources: r.recall_sources,
          chunkIndex: r.chunk_index,
          document: r.document,
          parentChunk: r.parent_chunk ?? undefined,
        })),
        elapsedMs: raw.elapsed_ms,
      } satisfies HitTestingResponseDTO;
    },
    onSuccess: (data, variables) => {
      setResults(data.results);
      setElapsedMs(data.elapsedMs);

      // 保存到历史
      const method = variables.config.searchMethod ?? "hybrid";
      addQueryToHistory({
        query: variables.query,
        method,
        resultCount: data.results.length,
      });
      setHistory(loadHistory());
    },
    onError: () => {
      setResults([]);
    },
  });

  // 提交查询
  const handleSubmit = useCallback(
    (query: string, config: HitTestingRequestDTO) => {
      setLastRequest({ query, config });
      mutation.mutate({ query, config });
    },
    [mutation],
  );

  // 重试
  const handleRetry = useCallback(() => {
    if (lastRequest) {
      mutation.mutate(lastRequest);
    }
  }, [lastRequest, mutation]);

  // 查看详情
  const handleViewDetail = useCallback((result: HitTestingResultDTO) => {
    setDetailResult(result);
    setShowDetail(true);
  }, []);

  // 关闭详情
  const handleCloseDetail = useCallback(() => {
    setShowDetail(false);
    // 延迟清空，保留关闭动画
    setTimeout(() => setDetailResult(null), 200);
  }, []);

  // 从历史选择查询
  const handleSelectHistory = useCallback((query: string) => {
    // 填充查询文本并自动提交需要 QueryInput 配合
    // 此处仅设置输入值，需要借助 ref 或状态提升
    // 简化实现：直接构造默认配置提交
    const config: HitTestingRequestDTO = {
      query,
      topK: 10,
      searchMethod: "hybrid",
      rerankingEnable: true,
      scoreThreshold: 0,
    };
    setLastRequest({ query, config });
    mutation.mutate({ query, config });
  }, [mutation]);

  // 清空历史
  const handleClearHistory = useCallback(() => {
    clearHistory();
    setHistory([]);
  }, []);

  return (
    <div className="flex flex-1 h-full overflow-hidden">
      {/* 主内容区 */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-6">
          {/* 页面标题 */}
          <div className="mb-6">
            <div className="flex items-center gap-2.5 mb-1">
              <FlaskConical className="h-5 w-5 text-muted-foreground" />
              <h1 className="text-base font-semibold text-foreground">
                命中测试
              </h1>
            </div>
            <p className="text-[13px] text-muted-foreground ml-7.5">
              测试知识库 <span className="text-foreground font-medium">{kbName}</span> 的检索效果，
              调试分块策略与召回质量
            </p>
          </div>

          {/* 查询输入 */}
          <QueryInput
            onSubmit={handleSubmit}
            loading={mutation.isPending}
          />

          {/* 结果区域 */}
          <div className="mt-6">
            <ResultList
              results={results}
              loading={mutation.isPending}
              error={mutation.error ? (mutation.error as Error).message : null}
              elapsedMs={elapsedMs}
              onViewDetail={handleViewDetail}
              onRetry={handleRetry}
            />
          </div>
        </div>
      </div>

      {/* 右侧：查询历史（桌面端固定宽度） */}
      <aside className="hidden lg:block w-72 shrink-0 border-l border-[hsl(var(--border))] overflow-y-auto p-4">
        <QueryHistoryList
          queries={history}
          onSelect={handleSelectHistory}
          onClear={handleClearHistory}
        />
      </aside>

      {/* 详情模态框 */}
      <ResultDetailModal
        result={detailResult}
        open={showDetail}
        onClose={handleCloseDetail}
      />
    </div>
  );
}
