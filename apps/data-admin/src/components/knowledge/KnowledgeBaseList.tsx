// 知识库列表页 —— 网格布局 / 卡片 / 空状态 / 创建按钮
import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Database, Loader2, RefreshCw } from "lucide-react";
import { client } from "@agentforge/ui";
import { KnowledgeBaseCard } from "./KnowledgeBaseCard";
import { CreateKnowledgeBaseDialog } from "./CreateKnowledgeBaseDialog";

// ── 骨架屏卡片 ──────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-5 animate-pulse">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className="h-9 w-9 rounded-lg bg-[hsl(var(--muted))]" />
          <div className="h-4 w-32 rounded bg-[hsl(var(--muted))]" />
        </div>
      </div>
      <div className="space-y-1.5 mb-3">
        <div className="h-3 w-full rounded bg-[hsl(var(--muted))]" />
        <div className="h-3 w-2/3 rounded bg-[hsl(var(--muted))]" />
      </div>
      <div className="flex items-center justify-between">
        <div className="h-3 w-20 rounded bg-[hsl(var(--muted))]" />
        <div className="h-4 w-12 rounded bg-[hsl(var(--muted))]" />
      </div>
    </div>
  );
}

// ── 组件 ──────────────────────────────────────────

export function KnowledgeBaseList() {
  const queryClient = useQueryClient();

  // 查询知识库列表
  const {
    data: knowledgeBases,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["knowledge", "bases"],
    queryFn: () => client.listKnowledgeBases(),
  });

  // 创建对话框状态
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  // 创建成功回调
  const handleCreateSuccess = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["knowledge", "bases"] });
  }, [queryClient]);

  // 删除知识库
  const handleDelete = useCallback(
    async (kbId: string) => {
      try {
        await client.deleteKnowledgeBase(kbId);
        queryClient.invalidateQueries({ queryKey: ["knowledge", "bases"] });
      } catch {
        // 删除失败，错误将由 Query 层或 toast 处理
      }
    },
    [queryClient],
  );

  return (
    <div className="flex-1 overflow-y-auto bg-[hsl(var(--background))]">
      <div className="max-w-6xl mx-auto px-6 py-6">
        {/* 页面标题 */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2.5">
            <Database className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-base font-semibold text-foreground">
              知识库
            </h1>
            {knowledgeBases && knowledgeBases.length > 0 && (
              <span className="rounded-full bg-[hsl(var(--muted))] px-2 py-0.5 text-[11px] text-muted-foreground">
                {knowledgeBases.length}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => refetch()}
              className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--accent))] transition-colors"
              title="刷新"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
            <button
              onClick={() => setShowCreateDialog(true)}
              className="inline-flex items-center gap-1.5 rounded-md bg-[hsl(var(--primary))] px-3 py-1.5 text-xs font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90 transition-opacity"
            >
              <Plus className="h-3.5 w-3.5" />
              创建知识库
            </button>
          </div>
        </div>

        {/* ── 加载状态 ──────────────────────────── */}

        {isLoading && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        )}

        {/* ── 错误状态 ──────────────────────────── */}

        {isError && (
          <div className="flex flex-col items-center justify-center py-16">
            <div className="rounded-full bg-red-50 p-3 mb-3">
              <RefreshCw className="h-6 w-6 text-red-400" />
            </div>
            <p className="text-sm font-medium text-foreground mb-1">
              加载失败
            </p>
            <p className="text-xs text-muted-foreground mb-4">
              {error instanceof Error
                ? error.message
                : "无法获取知识库列表"}
            </p>
            <button
              onClick={() => refetch()}
              className="inline-flex items-center gap-1.5 rounded-md bg-[hsl(var(--primary))] px-3 py-1.5 text-xs font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              重试
            </button>
          </div>
        )}

        {/* ── 空状态 ──────────────────────────── */}

        {!isLoading && !isError && knowledgeBases?.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="rounded-full bg-[hsl(var(--muted))]/50 p-4 mb-4">
              <Database className="h-8 w-8 text-muted-foreground opacity-40" />
            </div>
            <h2 className="text-sm font-semibold text-foreground mb-1">
              暂无知识库
            </h2>
            <p className="text-xs text-muted-foreground mb-5 text-center max-w-sm">
              创建你的第一个知识库，上传文档后即可在 Agent 对话中引用知识库内容
            </p>
            <button
              onClick={() => setShowCreateDialog(true)}
              className="inline-flex items-center gap-1.5 rounded-md bg-[hsl(var(--primary))] px-4 py-2 text-xs font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90 transition-opacity"
            >
              <Plus className="h-4 w-4" />
              创建知识库
            </button>
          </div>
        )}

        {/* ── 网格列表 ──────────────────────────── */}

        {!isLoading && !isError && knowledgeBases && knowledgeBases.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {knowledgeBases.map((kb) => (
              <KnowledgeBaseCard
                key={kb.id}
                kb={kb}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>

      {/* 创建对话框 */}
      <CreateKnowledgeBaseDialog
        open={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
        onSuccess={handleCreateSuccess}
      />
    </div>
  );
}
