import { useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, Play, X } from "lucide-react";
import type { EntryRouteRunDTO, EntryRouteRunPage } from "@agentforge/shared-types";
import { ENTRY_NODE_LABELS } from "./EntryNodePanel";

export function EntryRunPanel({ message, onMessage, busy, onRun, onClose, run, runs, onSelect, page, onPage, historyError }: {
  message: string; onMessage: (message: string) => void; busy: boolean; onRun: () => void; onClose: () => void;
  run: EntryRouteRunDTO | null; runs?: EntryRouteRunPage; onSelect: (id: string) => void;
  page: number; onPage: (page: number) => void; historyError?: string;
}) {
  const [recordId, setRecordId] = useState<string | null>(null);
  const record = run?.records.find((item) => item.nodeId === recordId);
  return <aside className="af-run-panel er-run-panel">
    <header className="af-panel-heading"><span>试运行与记录</span><button className="af-icon" title="关闭试运行" aria-label="关闭试运行" onClick={onClose}><X size={16} /></button></header>
    <div className="af-panel-body">
      <label className="af-field">当前消息<textarea className="af-input" aria-label="试运行问题" rows={4} maxLength={16000} value={message} disabled={busy} onChange={(e) => onMessage(e.target.value)} /></label>
      <button className="af-button af-primary" onClick={onRun} disabled={busy || !message.trim()}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}运行</button>
      {run && <div className="af-record-detail">
        <h3>{run.test ? `草稿 r${run.draftRevision}` : `正式 v${run.version}`} · {run.status} · {run.durationMs}ms</h3>
        <pre aria-label="最终决策">{JSON.stringify(run.output, null, 2)}</pre>
        {run.error && <div role="alert" className="af-error">{run.error}</div>}
        <div className="af-run-nodes">
          {run.records.map((item, index) => <button key={item.nodeId} className={`af-run-node ${recordId === item.nodeId ? "af-run-node-selected" : ""}`} onClick={() => setRecordId(item.nodeId)}>
            <small>{index + 1}</small><span>{item.name}</span><small>{item.matched === undefined ? ENTRY_NODE_LABELS[item.type] : item.matched ? "命中" : "未命中"}</small>
          </button>)}
        </div>
        {record && <><h3>节点记录</h3><pre>{JSON.stringify(record, null, 2)}</pre></>}
      </div>}
      <div className="af-form-section">
        <h3>最近运行</h3>
        {historyError && <div className="af-error" role="alert">{historyError}</div>}
        {runs?.items.length === 0 && <span className="af-muted">暂无记录</span>}
        {runs?.items.map((item) => <button className={`af-run-node ${run?.id === item.id ? "af-run-node-selected" : ""}`} key={item.id} disabled={busy} onClick={() => onSelect(item.id)}>
          <span>{item.test ? `试运行 r${item.draftRevision}` : `正式 v${item.version}`}<br /><small>{new Date(item.createdAt).toLocaleString()}</small></span><small>{item.output?.action ?? item.status}</small>
        </button>)}
        <div className="er-pagination">
          <button className="af-icon" title="上一页" aria-label="上一页" disabled={busy || page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft size={16} /></button>
          <span>{page} / {Math.max(1, Math.ceil((runs?.total ?? 0) / (runs?.pageSize ?? 20)))}</span>
          <button className="af-icon" title="下一页" aria-label="下一页" disabled={busy || !runs || page * runs.pageSize >= runs.total} onClick={() => onPage(page + 1)}><ChevronRight size={16} /></button>
        </div>
      </div>
    </div>
  </aside>;
}
