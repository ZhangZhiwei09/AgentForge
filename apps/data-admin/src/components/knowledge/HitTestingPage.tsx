import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import type {
  CreateKnowledgeRegressionCaseRequest,
  HitTestingRequestDTO,
  HitTestingResponseDTO,
  HitTestingResultDTO,
  KnowledgeRegressionCaseDTO,
  KnowledgeRegressionRunDTO,
} from "@agentforge/shared-types";
import { AgentForgeClient } from "@agentforge/sdk";
import {
  CheckCircle2,
  FlaskConical,
  History,
  ListChecks,
  Loader2,
  Plus,
  PlayCircle,
  Trash2,
  XCircle,
} from "lucide-react";
import { QueryInput } from "./QueryInput";
import { ResultList } from "./ResultList";
import { ResultDetailModal } from "./ResultDetailModal";
import {
  QueryHistoryList,
  addQueryToHistory,
  clearHistory,
  loadHistory,
} from "./QueryHistoryList";
import type { QueryHistoryItem } from "./QueryHistoryList";

interface HitTestingPageProps {
  kbId: string;
  kbName: string;
}

type HitTestingTab = "single" | "cases" | "runs";

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

function splitList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinList(value: string[]): string {
  return value.join("\n");
}

function defaultCaseForm(): CreateKnowledgeRegressionCaseRequest {
  return {
    name: "",
    query: "",
    expectedDocTitles: [],
    expectedDocIds: [],
    requiredText: [],
    forbiddenText: [],
    expectedTopK: 5,
    minScore: null,
    retrievalConfig: {
      searchMethod: "hybrid",
      topK: 10,
      rerankingEnable: true,
      scoreThreshold: 0,
    },
    promptRequiredContextText: [],
  };
}

export function HitTestingPage({ kbId, kbName }: HitTestingPageProps) {
  const client = useMemo(() => getClient(), []);
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<HitTestingTab>(() => {
    const tab = searchParams.get("tab");
    return tab === "cases" || tab === "runs" ? tab : "single";
  });
  const [results, setResults] = useState<HitTestingResultDTO[] | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | undefined>();
  const [history, setHistory] = useState<QueryHistoryItem[]>(() => loadHistory());
  const [detailResult, setDetailResult] = useState<HitTestingResultDTO | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [lastRequest, setLastRequest] = useState<{
    query: string;
    config: HitTestingRequestDTO;
  } | null>(null);
  const [caseForm, setCaseForm] = useState<CreateKnowledgeRegressionCaseRequest>(() => defaultCaseForm());
  const [showCaseForm, setShowCaseForm] = useState(false);

  const testSetsQuery = useQuery({
    queryKey: ["knowledge-regression-test-sets", kbId],
    queryFn: () => client.listKnowledgeRegressionTestSets(kbId),
  });

  const selectedTestSet = testSetsQuery.data?.[0] ?? null;

  const runsQuery = useQuery({
    queryKey: ["knowledge-regression-runs", kbId, selectedTestSet?.id],
    queryFn: () => client.listKnowledgeRegressionRuns(kbId, selectedTestSet?.id),
    enabled: !!selectedTestSet?.id,
  });

  const hitTestMutation = useMutation({
    mutationFn: async (params: { query: string; config: HitTestingRequestDTO }) => {
      const response = await client.hitTest(kbId, params.config);
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
      addQueryToHistory({
        query: variables.query,
        method: variables.config.searchMethod ?? "hybrid",
        resultCount: data.results.length,
      });
      setHistory(loadHistory());
    },
    onError: () => setResults([]),
  });

  const createCaseMutation = useMutation({
    mutationFn: (input: CreateKnowledgeRegressionCaseRequest) =>
      client.createKnowledgeRegressionCase(kbId, {
        ...input,
        testSetId: selectedTestSet?.id,
      }),
    onSuccess: () => {
      setCaseForm(defaultCaseForm());
      setShowCaseForm(false);
      queryClient.invalidateQueries({ queryKey: ["knowledge-regression-test-sets", kbId] });
    },
  });

  const deleteCaseMutation = useMutation({
    mutationFn: (caseId: string) => client.deleteKnowledgeRegressionCase(caseId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["knowledge-regression-test-sets", kbId] });
    },
  });

  const runRegressionMutation = useMutation({
    mutationFn: () => client.runKnowledgeRegression(kbId, selectedTestSet?.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["knowledge-regression-runs", kbId, selectedTestSet?.id] });
      setActiveTab("runs");
    },
  });

  const handleSubmit = useCallback(
    (query: string, config: HitTestingRequestDTO) => {
      setLastRequest({ query, config });
      hitTestMutation.mutate({ query, config });
    },
    [hitTestMutation],
  );

  const handleRetry = useCallback(() => {
    if (lastRequest) hitTestMutation.mutate(lastRequest);
  }, [hitTestMutation, lastRequest]);

  const handleSaveCurrentAsCase = useCallback(() => {
    if (!lastRequest) return;
    const firstResult = results?.[0];
    createCaseMutation.mutate({
      testSetId: selectedTestSet?.id,
      name: lastRequest.query.slice(0, 80),
      query: lastRequest.query,
      expectedDocTitles: firstResult?.document.title ? [firstResult.document.title] : [],
      expectedDocIds: firstResult?.document.id ? [firstResult.document.id] : [],
      requiredText: [],
      forbiddenText: [],
      expectedTopK: 5,
      minScore: null,
      retrievalConfig: {
        searchMethod: lastRequest.config.searchMethod ?? "hybrid",
        topK: lastRequest.config.topK ?? 10,
        rerankingEnable: lastRequest.config.rerankingEnable ?? true,
        scoreThreshold: lastRequest.config.scoreThreshold ?? 0,
      },
      promptRequiredContextText: [],
    });
  }, [createCaseMutation, lastRequest, results, selectedTestSet?.id]);

  const handleCreateCase = useCallback(() => {
    if (!caseForm.name?.trim() || !caseForm.query?.trim()) return;
    createCaseMutation.mutate({
      ...caseForm,
      testSetId: selectedTestSet?.id,
      name: caseForm.name.trim(),
      query: caseForm.query.trim(),
      expectedTopK: caseForm.expectedTopK ?? 5,
      retrievalConfig: {
        searchMethod: caseForm.retrievalConfig?.searchMethod ?? "hybrid",
        topK: caseForm.retrievalConfig?.topK ?? 10,
        rerankingEnable: caseForm.retrievalConfig?.rerankingEnable ?? true,
        scoreThreshold: caseForm.retrievalConfig?.scoreThreshold ?? 0,
      },
    });
  }, [caseForm, createCaseMutation, selectedTestSet?.id]);

  const handleViewDetail = useCallback((result: HitTestingResultDTO) => {
    setDetailResult(result);
    setShowDetail(true);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setShowDetail(false);
    setTimeout(() => setDetailResult(null), 200);
  }, []);

  const handleSelectHistory = useCallback((query: string) => {
    const config: HitTestingRequestDTO = {
      query,
      topK: 10,
      searchMethod: "hybrid",
      rerankingEnable: true,
      scoreThreshold: 0,
    };
    setLastRequest({ query, config });
    hitTestMutation.mutate({ query, config });
  }, [hitTestMutation]);

  const handleClearHistory = useCallback(() => {
    clearHistory();
    setHistory([]);
  }, []);

  return (
    <div className="flex flex-1 h-full overflow-hidden">
      <div className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-6">
          <div className="mb-6">
            <div className="flex items-center gap-2.5 mb-1">
              <FlaskConical className="h-5 w-5 text-muted-foreground" />
              <h1 className="text-base font-semibold text-foreground">知识回归测试</h1>
            </div>
            <p className="text-[13px] text-muted-foreground ml-7.5">
              管理知识库 <span className="text-foreground font-medium">{kbName}</span> 的回归用例、召回结果和 prompt 上下文快照
            </p>
          </div>

          <div className="mb-5 flex items-center gap-1 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/40 p-1">
            {[
              { id: "single" as const, label: "单次测试", icon: FlaskConical },
              { id: "cases" as const, label: "回归用例", icon: ListChecks },
              { id: "runs" as const, label: "运行记录", icon: History },
            ].map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors ${
                    activeTab === tab.id
                      ? "bg-[hsl(var(--background))] text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {tab.label}
                </button>
              );
            })}
          </div>

          {activeTab === "single" && (
            <>
              <QueryInput onSubmit={handleSubmit} loading={hitTestMutation.isPending} />
              {lastRequest && results && results.length > 0 && (
                <div className="mt-3 flex justify-end">
                  <button
                    onClick={handleSaveCurrentAsCase}
                    disabled={createCaseMutation.isPending}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[hsl(var(--border))] px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-[hsl(var(--accent))] hover:text-foreground disabled:opacity-50"
                  >
                    {createCaseMutation.isPending ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Plus className="h-3 w-3" />
                    )}
                    保存为回归用例
                  </button>
                </div>
              )}
              <div className="mt-6">
                <ResultList
                  results={results}
                  loading={hitTestMutation.isPending}
                  error={hitTestMutation.error ? (hitTestMutation.error as Error).message : null}
                  elapsedMs={elapsedMs}
                  onViewDetail={handleViewDetail}
                  onRetry={handleRetry}
                />
              </div>
            </>
          )}

          {activeTab === "cases" && (
            <RegressionCasesPanel
              cases={selectedTestSet?.cases ?? []}
              loading={testSetsQuery.isLoading}
              creating={createCaseMutation.isPending}
              deletingCaseId={deleteCaseMutation.variables}
              running={runRegressionMutation.isPending}
              showForm={showCaseForm}
              form={caseForm}
              error={
                createCaseMutation.error
                  ? (createCaseMutation.error as Error).message
                  : runRegressionMutation.error
                    ? (runRegressionMutation.error as Error).message
                    : null
              }
              onToggleForm={() => setShowCaseForm((open) => !open)}
              onFormChange={setCaseForm}
              onCreate={handleCreateCase}
              onDelete={(caseId) => deleteCaseMutation.mutate(caseId)}
              onRun={() => runRegressionMutation.mutate()}
            />
          )}

          {activeTab === "runs" && (
            <RegressionRunsPanel
              runs={runsQuery.data ?? []}
              loading={runsQuery.isLoading || runRegressionMutation.isPending}
              error={runsQuery.error ? (runsQuery.error as Error).message : null}
            />
          )}
        </div>
      </div>

      <aside className="hidden lg:block w-72 shrink-0 border-l border-[hsl(var(--border))] overflow-y-auto p-4">
        <QueryHistoryList
          queries={history}
          onSelect={handleSelectHistory}
          onClear={handleClearHistory}
        />
      </aside>

      <ResultDetailModal
        result={detailResult}
        open={showDetail}
        onClose={handleCloseDetail}
      />
    </div>
  );
}

function RegressionCasesPanel({
  cases,
  loading,
  creating,
  deletingCaseId,
  running,
  showForm,
  form,
  error,
  onToggleForm,
  onFormChange,
  onCreate,
  onDelete,
  onRun,
}: {
  cases: KnowledgeRegressionCaseDTO[];
  loading: boolean;
  creating: boolean;
  deletingCaseId?: string;
  running: boolean;
  showForm: boolean;
  form: CreateKnowledgeRegressionCaseRequest;
  error: string | null;
  onToggleForm: () => void;
  onFormChange: (form: CreateKnowledgeRegressionCaseRequest) => void;
  onCreate: () => void;
  onDelete: (caseId: string) => void;
  onRun: () => void;
}) {
  const updateList = (
    key: "expectedDocTitles" | "expectedDocIds" | "requiredText" | "forbiddenText" | "promptRequiredContextText",
    value: string,
  ) => onFormChange({ ...form, [key]: splitList(value) });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">回归用例</h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            固定问题、期望文档和关键上下文，用来检查召回与 prompt 是否退化
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onRun}
            disabled={running || cases.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[hsl(var(--primary))] px-3 py-1.5 text-[11px] font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:opacity-40"
          >
            {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5" />}
            运行全部
          </button>
          <button
            onClick={onToggleForm}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[hsl(var(--border))] px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-[hsl(var(--accent))] hover:text-foreground"
          >
            <Plus className="h-3 w-3" />
            新建用例
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      {showForm && (
        <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">名称</span>
              <input
                value={form.name ?? ""}
                onChange={(e) => onFormChange({ ...form, name: e.target.value })}
                className="w-full rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-2 text-xs"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">期望 TopK</span>
              <input
                type="number"
                min={1}
                max={20}
                value={form.expectedTopK ?? 5}
                onChange={(e) => onFormChange({ ...form, expectedTopK: Number(e.target.value) })}
                className="w-full rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-2 text-xs"
              />
            </label>
          </div>
          <label className="space-y-1 block">
            <span className="text-[11px] font-medium text-muted-foreground">Query</span>
            <textarea
              value={form.query ?? ""}
              onChange={(e) => onFormChange({ ...form, query: e.target.value })}
              rows={2}
              className="w-full resize-none rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-2 text-xs"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <ListTextarea
              label="期望文档标题"
              value={joinList(form.expectedDocTitles ?? [])}
              onChange={(value) => updateList("expectedDocTitles", value)}
            />
            <ListTextarea
              label="必须召回文本"
              value={joinList(form.requiredText ?? [])}
              onChange={(value) => updateList("requiredText", value)}
            />
            <ListTextarea
              label="禁止出现文本"
              value={joinList(form.forbiddenText ?? [])}
              onChange={(value) => updateList("forbiddenText", value)}
            />
            <ListTextarea
              label="Prompt 必须包含"
              value={joinList(form.promptRequiredContextText ?? [])}
              onChange={(value) => updateList("promptRequiredContextText", value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={onToggleForm}
              className="rounded-lg border border-[hsl(var(--border))] px-3 py-1.5 text-[11px] text-muted-foreground hover:text-foreground"
            >
              取消
            </button>
            <button
              onClick={onCreate}
              disabled={creating || !form.name?.trim() || !form.query?.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[hsl(var(--primary))] px-3 py-1.5 text-[11px] font-medium text-[hsl(var(--primary-foreground))] disabled:opacity-40"
            >
              {creating && <Loader2 className="h-3 w-3 animate-spin" />}
              保存
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : cases.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[hsl(var(--border))] py-12 text-center">
          <ListChecks className="mx-auto h-8 w-8 text-muted-foreground opacity-30" />
          <p className="mt-3 text-xs text-muted-foreground">还没有回归用例</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {cases.map((testCase) => (
            <div
              key={testCase.id}
              className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-sm font-medium text-foreground">{testCase.name}</h3>
                    <span className="rounded-full bg-[hsl(var(--muted))] px-2 py-0.5 text-[10px] text-muted-foreground">
                      {testCase.retrievalConfig.searchMethod} · top {testCase.retrievalConfig.topK}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{testCase.query}</p>
                </div>
                <button
                  onClick={() => onDelete(testCase.id)}
                  disabled={deletingCaseId === testCase.id}
                  className="rounded p-1 text-muted-foreground hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                  title="删除"
                >
                  {deletingCaseId === testCase.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-[11px] text-muted-foreground">
                <span>期望文档 {testCase.expectedDocTitles.length + testCase.expectedDocIds.length}</span>
                <span>必须文本 {testCase.requiredText.length}</span>
                <span>Prompt 检查 {testCase.promptRequiredContextText.length}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ListTextarea({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="space-y-1 block">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        placeholder="每行一个，或用逗号分隔"
        className="w-full resize-none rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-2 text-xs"
      />
    </label>
  );
}

function RegressionRunsPanel({
  runs,
  loading,
  error,
}: {
  runs: KnowledgeRegressionRunDTO[];
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
        {error}
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[hsl(var(--border))] py-12 text-center">
        <History className="mx-auto h-8 w-8 text-muted-foreground opacity-30" />
        <p className="mt-3 text-xs text-muted-foreground">还没有运行记录</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {runs.map((run) => (
        <div
          key={run.id}
          className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-4"
        >
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                {run.failedCases === 0 ? (
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                ) : (
                  <XCircle className="h-4 w-4 text-red-600" />
                )}
                <h3 className="text-sm font-medium text-foreground">
                  通过率 {(run.hitRate * 100).toFixed(0)}%
                </h3>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {new Date(run.createdAt).toLocaleString()} · {run.passedCases}/{run.totalCases} 通过
                {run.averageElapsedMs != null ? ` · 平均 ${Math.round(run.averageElapsedMs)} ms` : ""}
                {run.averageRank != null ? ` · 平均排名 ${run.averageRank.toFixed(1)}` : ""}
              </p>
            </div>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                run.failedCases === 0
                  ? "bg-green-100 text-green-700"
                  : "bg-red-100 text-red-700"
              }`}
            >
              {run.failedCases === 0 ? "PASS" : "FAIL"}
            </span>
          </div>

          <div className="mt-4 space-y-2">
            {run.items.map((item) => (
              <details
                key={item.id}
                className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/20 px-3 py-2"
              >
                <summary className="cursor-pointer list-none">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      {item.passed ? (
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-600" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5 shrink-0 text-red-600" />
                      )}
                      <span className="truncate text-xs font-medium text-foreground">{item.caseName}</span>
                    </div>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {item.rank ? `#${item.rank}` : "未命中"} · {item.elapsedMs} ms
                    </span>
                  </div>
                  {item.failureReason && (
                    <p className="mt-1 pl-5 text-[11px] text-red-600">{item.failureReason}</p>
                  )}
                </summary>

                <div className="mt-3 space-y-3 pl-5">
                  <div>
                    <p className="text-[11px] font-medium text-muted-foreground mb-1">召回结果</p>
                    <div className="space-y-1.5">
                      {item.resultsSnapshot.map((result) => (
                        <div
                          key={`${item.id}-${result.chunkId}`}
                          className="rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-2"
                        >
                          <div className="flex items-center justify-between gap-2 text-[11px]">
                            <span className="truncate font-medium text-foreground">
                              #{result.rank} {result.docTitle}
                            </span>
                            <span className="font-mono text-muted-foreground">
                              {result.score.toFixed(4)}
                            </span>
                          </div>
                          <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">
                            {result.content}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                  {item.promptSnapshot && (
                    <div>
                      <p className="text-[11px] font-medium text-muted-foreground mb-1">Prompt 预览</p>
                      <pre className="max-h-64 overflow-auto rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-3 text-[11px] leading-relaxed text-foreground whitespace-pre-wrap">
                        {item.promptSnapshot}
                      </pre>
                    </div>
                  )}
                </div>
              </details>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
