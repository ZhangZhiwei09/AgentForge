import type { EntryRouteNode, EntryRouteTarget } from "@agentforge/shared-types";
import { useEffect, useState } from "react";
import { Trash2, X } from "lucide-react";

export const ENTRY_NODE_LABELS = { start: "开始", condition: "条件", reply: "固定回复", route: "分流", continue: "继续智能路由" };
const wordLines = (value: string) => value.split("\n").filter((line) => !!line.trim());

function LineInput({ label, values, rows, onChange }: { label: string; values: string[]; rows: number; onChange: (values: string[]) => void }) {
  const [raw, setRaw] = useState(values.join("\n"));
  const signature = JSON.stringify(values);
  useEffect(() => {
    if (JSON.stringify(wordLines(raw)) !== signature) setRaw(values.join("\n"));
  }, [signature, raw, values]);
  return <label className="af-field">{label}<textarea className="af-input" aria-label={label} rows={rows} value={raw} onChange={(e) => {
    setRaw(e.target.value); onChange(wordLines(e.target.value));
  }} /></label>;
}

export function EntryNodePanel({ node, onChange, onDelete, onClose }: {
  node: EntryRouteNode; onChange: (node: EntryRouteNode) => void; onDelete: () => void; onClose: () => void;
}) {
  return <aside className="af-node-panel er-node-panel">
    <header className="af-panel-heading">
      <span>{ENTRY_NODE_LABELS[node.type]}</span>
      <button className="af-icon" title="关闭节点配置" aria-label="关闭节点配置" onClick={onClose}><X size={16} /></button>
    </header>
    <div className="af-panel-body">
      <label className="af-field">节点名称<input className="af-input" aria-label="节点名称" value={node.name} maxLength={200} onChange={(e) => onChange({ ...node, name: e.target.value })} /></label>
      {node.type === "condition" && <>
        <label className="af-field">匹配方式<select className="af-input" aria-label="匹配方式" value={node.condition.operator} onChange={(e) => onChange({
          ...node, condition: { ...node.condition, operator: e.target.value as typeof node.condition.operator, stripTrailingPunctuation: false },
        })}><option value="contains_any">包含任意关键词</option><option value="contains_all">包含全部关键词</option><option value="equals_any">精确匹配任意关键词</option></select></label>
        <LineInput key={`${node.id}_words`} label="关键词" rows={7} values={node.condition.words} onChange={(words) => onChange({ ...node, condition: { ...node.condition, words } })} />
        <LineInput key={`${node.id}_exclude`} label="排除词" rows={3} values={node.condition.excludeAny} onChange={(excludeAny) => onChange({ ...node, condition: { ...node.condition, excludeAny } })} />
        <label className="af-tool"><input type="checkbox" checked={node.condition.ignoreCase} onChange={(e) => onChange({ ...node, condition: { ...node.condition, ignoreCase: e.target.checked } })} />忽略大小写</label>
        {node.condition.operator === "equals_any" && <label className="af-tool"><input type="checkbox" checked={node.condition.stripTrailingPunctuation} onChange={(e) => onChange({ ...node, condition: { ...node.condition, stripTrailingPunctuation: e.target.checked } })} />忽略末尾问候标点</label>}
      </>}
      {node.type === "reply" && <>
        <label className="af-field">回复正文<textarea className="af-input" aria-label="回复正文" rows={10} maxLength={8000} value={node.answer} onChange={(e) => onChange({ ...node, answer: e.target.value })} /></label>
        <LineInput key={`${node.id}_suggestions`} label="建议问题" rows={4} values={node.suggestions} onChange={(suggestions) => onChange({ ...node, suggestions })} />
      </>}
      {node.type === "route" && <>
        <label className="af-field">处理入口<select className="af-input" aria-label="处理入口" value={node.target} onChange={(e) => {
          const target = e.target.value as EntryRouteTarget;
          onChange({ id: node.id, name: node.name, position: node.position, type: "route", target, ...(target === "HUMAN" && node.handoff ? { handoff: node.handoff } : {}) });
        }}><option value="CHAT">普通问答</option><option value="TASK">业务任务</option><option value="HUMAN">人工客服</option><option value="DIAGNOSIS">故障诊断</option></select></label>
        {node.target === "HUMAN" && <>
          <label className="af-tool"><input type="checkbox" aria-label="自定义转接话术" checked={!!node.handoff} onChange={(e) => {
            const { handoff: _handoff, ...rest } = node;
            onChange(e.target.checked ? { ...rest, handoff: { withinHours: "正在为您转接人工客服，请稍候。", outsideHours: "当前为非工作时间，我们会在下一个工作日回复您。", suggestions: [] } } : rest);
          }} />自定义转接话术</label>
          {node.handoff && <>
            <label className="af-field">工作时间话术<textarea className="af-input" aria-label="工作时间话术" rows={5} maxLength={8000} value={node.handoff.withinHours} onChange={(e) => onChange({ ...node, handoff: { ...node.handoff!, withinHours: e.target.value } })} /></label>
            <label className="af-field">非工作时间话术<textarea className="af-input" aria-label="非工作时间话术" rows={5} maxLength={8000} value={node.handoff.outsideHours} onChange={(e) => onChange({ ...node, handoff: { ...node.handoff!, outsideHours: e.target.value } })} /></label>
            <LineInput key={`${node.id}_handoff`} label="建议问题" rows={3} values={node.handoff.suggestions} onChange={(suggestions) => onChange({ ...node, handoff: { ...node.handoff!, suggestions } })} />
          </>}
        </>}
      </>}
      {node.type !== "start" && <div className="af-form-section">
        <button className="af-button af-danger" onClick={onDelete}><Trash2 size={14} />删除节点</button>
      </div>}
    </div>
  </aside>;
}
