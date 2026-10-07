import { useState } from "react";
import { X, Play, Square, Loader2, CheckCircle2, AlertCircle, Circle, MinusCircle } from "lucide-react";
import type { AgentFlowDefinition, AgentFlowNodeRecord, AgentFlowRunDTO } from "@agentforge/shared-types";

const STATUS = { running: "运行中", completed: "完成", failed: "失败", skipped: "已跳过", waiting_input: "等待补充", cancelled: "已取消" };

export function FlowRunPanel({ definition, message, onMessage, busy, runId, records, status, runs, output, onRun, onCancel, onClose, onSelectRun }: {
  definition: AgentFlowDefinition; message: string; onMessage: (value: string) => void;
  busy: boolean; runId: string | null; records: Record<string, AgentFlowNodeRecord>;
  status: string; runs: AgentFlowRunDTO[]; output: Record<string, unknown> | null;
  onRun: () => void; onCancel: () => void; onClose: () => void; onSelectRun: (run: AgentFlowRunDTO) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const record = selected ? records[selected] : null;
  const nodes = !busy && runId && Object.keys(records).length
    ? Object.values(records) : definition.nodes;
  return <aside className="af-run-panel">
    <div className="af-panel-heading"><span>试运行与记录</span><button className="af-icon" title="关闭运行记录" aria-label="关闭运行记录" onClick={onClose}><X size={16} /></button></div>
    <div className="af-panel-body">
      <textarea className="af-input" aria-label="试运行问题" rows={3} value={message} onChange={(e) => onMessage(e.target.value)} disabled={busy} maxLength={12000} />
      <div className="af-row af-run-controls">
        <button className="af-button af-primary" disabled={busy || !message.trim()} onClick={onRun}><Play size={14} />运行</button>
        <button className="af-button" disabled={!busy || !runId} onClick={onCancel}><Square size={13} />取消</button>
        <span className="af-muted">{STATUS[status as keyof typeof STATUS] || status}</span>
      </div>
      <label className="af-field">最近运行<select className="af-input" disabled={busy} value={runId || ""} onChange={(e) => {
        const run = runs.find((r) => r.id === e.target.value); if (run) { onSelectRun(run); setSelected(null); }
      }}><option value="">当前试运行</option>{runs.map((run) => <option key={run.id} value={run.id}>
        {new Date(run.createdAt).toLocaleString()} · {run.test ? "草稿" : `v${run.version}`} · {STATUS[run.status]}
      </option>)}</select></label>
      <div className="af-run-nodes">
        {nodes.map((node) => {
          const id = "nodeId" in node ? node.nodeId : node.id;
          const item = records[id];
          const Icon = item?.status === "running" ? Loader2 : item?.status === "completed" ? CheckCircle2 : item?.status === "failed" ? AlertCircle : item?.status === "skipped" || item?.status === "cancelled" ? MinusCircle : Circle;
          return <button key={id} className={`af-run-node ${selected === id ? "af-run-node-selected" : ""}`} onClick={() => setSelected(id)}>
            <Icon size={15} className={item?.status === "running" ? "animate-spin" : ""} />
            <span>{node.name}</span><small>{item?.durationMs !== undefined ? `${item.durationMs} ms` : item ? STATUS[item.status] : "待执行"}</small>
          </button>;
        })}
      </div>
      {record && <div className="af-record-detail">
        {record.error && <div className="af-error">{record.error}</div>}
        <h3>输入</h3><pre>{JSON.stringify(record.inputs ?? {}, null, 2)}</pre>
        <h3>输出</h3><pre>{JSON.stringify(record.output ?? {}, null, 2)}</pre>
      </div>}
      {output && <div className="af-record-detail"><h3>最终结果</h3><pre>{JSON.stringify(output, null, 2)}</pre></div>}
    </div>
  </aside>;
}
