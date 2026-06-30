// 上传向导第 3 步：处理进度展示 —— 显示多个文档的实时处理进度
import { useMemo } from "react";
import { CheckCircle, ArrowRight, Loader2 } from "lucide-react";
import { DocumentProgressItem } from "./DocumentProgressItem";
import { useProcessingPolling } from "../../hooks/useProcessingPolling";
import type { DocumentSnapshot } from "../../hooks/useProcessingPolling";
import type { PhaseItem } from "./StageProgressBar";

// ── Props ────────────────────────────────────────

interface ProcessingDocument {
  id: string;
  title: string;
  status: string;
}

interface StepProcessingProps {
  documents: ProcessingDocument[];
  kbId: string;
  onGoToDocuments: () => void;
  /** 获取单个文档快照的函数 */
  fetchDocument: (docId: string) => Promise<DocumentSnapshot>;
}

// ── 单个文档轮询包装 ──────────────────────────────

function PollingDocumentItem({
  doc,
  fetchDocument,
}: {
  doc: ProcessingDocument;
  fetchDocument: (docId: string) => Promise<DocumentSnapshot>;
}) {
  const { status, phases, progress } = useProcessingPolling({
    docId: doc.id,
    fetchDocument,
    interval: 2500,
    enabled: doc.status !== "completed" && doc.status !== "failed",
  });

  // 使用轮询数据或初始数据
  const displayStatus = status ?? doc.status;
  const displayPhases: PhaseItem[] =
    phases.length > 0
      ? phases.map((p) => ({
          name: p.label,
          status: p.done
            ? ("completed" as const)
            : status === "failed"
              ? ("failed" as const)
              : ("pending" as const),
        }))
      : [];

  return (
    <DocumentProgressItem
      documentId={doc.id}
      title={doc.title}
      status={displayStatus}
      phases={displayPhases}
      totalProgress={progress}
    />
  );
}

// ── 组件 ──────────────────────────────────────────

export function StepProcessing({
  documents,
  kbId: _kbId,
  onGoToDocuments,
  fetchDocument,
}: StepProcessingProps) {
  // 统计各状态数量
  const stats = useMemo(() => {
    const total = documents.length;
    const completed = documents.filter((d) => d.status === "completed").length;
    const failed = documents.filter((d) => d.status === "failed").length;
    const processing = total - completed - failed;
    return { total, completed, failed, processing };
  }, [documents]);

  const allDone = stats.completed + stats.failed === stats.total;

  return (
    <div className="space-y-6">
      <div className="text-center space-y-1">
        <h3 className="text-base font-semibold text-foreground">处理进度</h3>
        <p className="text-xs text-muted-foreground">
          文档正在后台处理中，您可以关闭窗口稍后查看
        </p>
      </div>

      {/* 统计概览 */}
      <div className="flex items-center justify-center gap-6">
        <StatBadge label="总计" value={stats.total} />
        {stats.processing > 0 && (
          <StatBadge
            label="处理中"
            value={stats.processing}
            variant="processing"
          />
        )}
        {stats.completed > 0 && (
          <StatBadge
            label="已完成"
            value={stats.completed}
            variant="completed"
          />
        )}
        {stats.failed > 0 && (
          <StatBadge label="失败" value={stats.failed} variant="failed" />
        )}
      </div>

      {/* 文档列表 */}
      <div className="space-y-3 max-h-[420px] overflow-y-auto">
        {documents.map((doc) => (
          <PollingDocumentItem
            key={doc.id}
            doc={doc}
            fetchDocument={fetchDocument}
          />
        ))}
      </div>

      {/* 完成按钮 */}
      {allDone && (
        <div className="flex flex-col items-center gap-3 pt-2 animate-fade-in">
          <div className="flex items-center gap-2 text-green-600">
            <CheckCircle className="h-5 w-5" />
            <span className="text-sm font-medium">全部文档处理完毕</span>
          </div>
          <button
            onClick={onGoToDocuments}
            className="inline-flex items-center gap-2 rounded-md bg-[hsl(var(--primary))] px-5 py-2.5 text-sm font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90 transition-opacity"
          >
            前往文档列表
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* 处理中提示 */}
      {!allDone && (
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          正在处理 {stats.processing} 篇文档...
        </div>
      )}
    </div>
  );
}

// ── 统计徽章 ──────────────────────────────────────

function StatBadge({
  label,
  value,
  variant = "default",
}: {
  label: string;
  value: number;
  variant?: "default" | "processing" | "completed" | "failed";
}) {
  const colorClass: Record<string, string> = {
    default: "bg-[hsl(var(--muted))] text-foreground",
    processing: "bg-amber-100 text-amber-700",
    completed: "bg-green-100 text-green-700",
    failed: "bg-red-100 text-red-700",
  };

  return (
    <div className="flex flex-col items-center gap-0.5">
      <span
        className={[
          "inline-flex items-center justify-center w-10 h-10 rounded-full text-lg font-bold tabular-nums",
          colorClass[variant],
        ].join(" ")}
      >
        {value}
      </span>
      <span className="text-[10px] text-muted-foreground">{label}</span>
    </div>
  );
}
