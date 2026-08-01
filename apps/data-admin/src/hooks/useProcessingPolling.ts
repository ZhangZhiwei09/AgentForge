// 文档处理状态轮询 hook —— 每 2.5s 检查文档处理进度，完成后自动停止
import { useState, useEffect, useRef, useCallback } from "react";

// ── Types ──────────────────────────────────────

export interface ProcessingPhase {
  key: string;
  label: string;
  done: boolean;
}

export interface ProcessingDetail {
  phase: string;
  progress: number;
  total: number;
  message: string;
  updatedAt?: string;
}

/** 文档快照 —— hook 最小依赖，仅需 status + 阶段时间戳 */
export interface DocumentSnapshot {
  status: string;
  originalFilename?: string | null;
  processingDetail: ProcessingDetail | null;
  downloadingCompletedAt?: string | null;
  parsingCompletedAt?: string | null;
  normalizingCompletedAt?: string | null;
  chunkingCompletedAt?: string | null;
  embeddingCompletedAt?: string | null;
}

export interface UseProcessingPollingOptions {
  docId: string;
  /** 获取单篇文档的快照，通常调用 GET /api/knowledge/documents/:docId */
  fetchDocument: (docId: string) => Promise<DocumentSnapshot>;
  /** 轮询间隔（毫秒），默认 2500 */
  interval?: number;
  /** 是否启用轮询，默认 true */
  enabled?: boolean;
}

export interface UseProcessingPollingResult {
  /** 当前文档状态：pending | processing | completed | failed */
  status: string | null;
  /** 各阶段完成情况 */
  phases: ProcessingPhase[];
  /** 当前进度百分比 0-100 */
  progress: number;
  /** 是否正在轮询 */
  isPolling: boolean;
  /** 轮询过程中的错误信息 */
  error: string | null;
}

// ── Helpers ─────────────────────────────────────

const TERMINAL_STATUSES = new Set(["completed", "failed"]);

/** 根据文档的阶段时间戳计算各阶段完成情况 */
function computePhases(snapshot: DocumentSnapshot): ProcessingPhase[] {
  const hasFile = !!snapshot.originalFilename;
  if (hasFile) {
    return [
      { key: "download", label: "下载", done: !!snapshot.downloadingCompletedAt },
      { key: "parse", label: "解析", done: !!snapshot.parsingCompletedAt },
      { key: "clean", label: "清洗", done: !!snapshot.normalizingCompletedAt },
      { key: "chunk", label: "分段", done: !!snapshot.chunkingCompletedAt },
      { key: "embed", label: "向量化", done: !!snapshot.embeddingCompletedAt },
    ];
  }
  return [
    { key: "clean", label: "清洗", done: !!snapshot.normalizingCompletedAt },
    { key: "chunk", label: "分段", done: !!snapshot.chunkingCompletedAt },
    { key: "embed", label: "向量化", done: !!snapshot.embeddingCompletedAt },
  ];
}

/** 根据 processingDetail 或 phases 计算进度百分比 */
function computeProgress(
  snapshot: DocumentSnapshot,
  phases: ProcessingPhase[],
): number {
  const detail = snapshot.processingDetail;
  if (detail && detail.total > 0) {
    return Math.round((detail.progress / detail.total) * 100);
  }
  if (phases.length > 0) {
    const completed = phases.filter((p) => p.done).length;
    return Math.round((completed / phases.length) * 100);
  }
  return 0;
}

// ── Hook ───────────────────────────────────────

export function useProcessingPolling({
  docId,
  fetchDocument,
  interval = 2500,
  enabled = true,
}: UseProcessingPollingOptions): UseProcessingPollingResult {
  const [status, setStatus] = useState<string | null>(null);
  const [phases, setPhases] = useState<ProcessingPhase[]>([]);
  const [progress, setProgress] = useState(0);
  const [isPolling, setIsPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 使用 ref 跟踪定时器，避免闭包陷阱
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const poll = useCallback(async (): Promise<boolean> => {
    try {
      const doc = await fetchDocument(docId);
      if (!mountedRef.current) return true;

      const docStatus = doc.status;
      setStatus(docStatus);
      setError(null);

      const phaseList = computePhases(doc);
      setPhases(phaseList);
      setProgress(computeProgress(doc, phaseList));

      if (TERMINAL_STATUSES.has(docStatus)) {
        setIsPolling(false);
        return true; // 停止轮询
      }
      return false;
    } catch (e) {
      if (!mountedRef.current) return true;
      setError(e instanceof Error ? e.message : "轮询请求失败");
      setIsPolling(false);
      return true; // 出错时停止轮询
    }
  }, [docId, fetchDocument]);

  useEffect(() => {
    mountedRef.current = true;

    if (!enabled || !docId) {
      setIsPolling(false);
      return () => {
        mountedRef.current = false;
      };
    }

    setIsPolling(true);

    // 使用 setTimeout 链式调用替代 setInterval，避免请求堆积
    const scheduleNext = (delay: number) => {
      if (!mountedRef.current) return;
      timerRef.current = setTimeout(async () => {
        const stopped = await poll();
        if (!stopped) {
          scheduleNext(interval);
        }
      }, delay);
    };

    // 立即执行首次轮询
    poll().then((stopped) => {
      if (!stopped && mountedRef.current) {
        scheduleNext(interval);
      }
    });

    return () => {
      mountedRef.current = false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [docId, enabled, interval, poll]);

  return { status, phases, progress, isPolling, error };
}
