import { Plus, Trash2, X } from "lucide-react";
import type { AgentFlowDefinition, AgentFlowNode, FlowValueRef, FlowFieldType } from "@agentforge/shared-types";

const FIELD_TYPES: FlowFieldType[] = ["string", "number", "boolean", "object", "array"];
const TYPE_NAMES = { start: "开始", agent: "Agent", condition: "条件", end: "结束" };
const inputClass = "af-input";

function ReferenceSelect({ value, nodes, onChange }: {
  value: FlowValueRef; nodes: AgentFlowNode[]; onChange: (value: FlowValueRef) => void;
}) {
  const encode = (ref: FlowValueRef) => JSON.stringify([ref.source, ref.nodeId ?? "", ...ref.path]);
  return <select className={inputClass} aria-label="输入来源" value={encode(value)} onChange={(e) => {
    const [source, nodeId, ...path] = JSON.parse(e.target.value) as ["task" | "node", string, ...string[]];
    onChange({ source, nodeId: nodeId || null, path });
  }}>
    <option value={encode({ source: "task", path: [] })}>用户问题</option>
    {nodes.filter((n) => n.type === "agent").map((node) => <optgroup key={node.id} label={node.name}>
      <option value={encode({ source: "node", nodeId: node.id, path: [] })}>{node.name} / 完整输出</option>
      {node.outputs.filter((field) => field.required).map((field) => <option key={field.name} value={encode({ source: "node", nodeId: node.id, path: [field.name] })}>
        {node.name} / {field.name}
      </option>)}
    </optgroup>)}
  </select>;
}

export function FlowNodePanel({ node, definition, tools, onChange, onDelete, onClose }: {
  node: AgentFlowNode;
  definition: AgentFlowDefinition;
  tools: Array<{ name: string; description: string }>;
  onChange: (patch: Partial<AgentFlowNode>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const isCore = Object.values(definition.diagnosisBindings).includes(node.id);
  const gate = definition.edges.find((edge) => edge.source === definition.diagnosisBindings.frontend)?.target === node.id;
  const protectedNode = isCore || gate || node.type === "start";
  const role = node.role;
  const otherNodes = definition.nodes.filter((n) => n.id !== node.id);
  const bindings = Object.entries(node.inputs);
  return (
    <aside className="af-node-panel">
      <div className="af-panel-heading"><span>{TYPE_NAMES[node.type]}</span><code>{node.id}</code>
        <button className="af-icon" title="关闭节点配置" aria-label="关闭节点配置" onClick={onClose}><X size={16} /></button>
      </div>
      <div className="af-panel-body">
        <label className="af-field">节点名称<input className={inputClass} value={node.name} maxLength={100} onChange={(e) => onChange({ name: e.target.value })} /></label>
        {node.type === "agent" && role && <>
          <section className="af-form-section"><h3>角色身份</h3>
            <label className="af-field">角色名称<input className={inputClass} value={role.name} onChange={(e) => onChange({ role: { ...role, name: e.target.value } })} /></label>
            <label className="af-field">职责<textarea className={inputClass} rows={2} value={role.description} onChange={(e) => onChange({ role: { ...role, description: e.target.value } })} /></label>
            <label className="af-field">系统提示词<textarea className={inputClass} rows={6} value={role.systemPrompt} onChange={(e) => onChange({ role: { ...role, systemPrompt: e.target.value } })} /></label>
          </section>
          <section className="af-form-section"><h3>节点任务</h3>
            <textarea aria-label="节点任务" className={inputClass} rows={3} value={node.task} onChange={(e) => onChange({ task: e.target.value })} />
          </section>
          <section className="af-form-section"><h3>输入映射</h3>
            {bindings.map(([name, ref]) => <div className="af-mapping" key={name}>
              <div className="af-row"><code>{name}</code>
                <button className="af-icon" title={`删除输入 ${name}`} disabled={isCore && ["question", "frontend", "backend", "facts"].includes(name)} onClick={() => {
                  const inputs = { ...node.inputs }; delete inputs[name]; onChange({ inputs });
                }}><Trash2 size={13} /></button>
              </div>
              <ReferenceSelect value={ref} nodes={otherNodes} onChange={(value) => onChange({ inputs: { ...node.inputs, [name]: value } })} />
            </div>)}
            <button className="af-button" onClick={() => {
              let index = 1;
              while (`input_${index}` in node.inputs) index++;
              onChange({ inputs: { ...node.inputs, [`input_${index}`]: { source: "task", path: [] } } });
            }}><Plus size={13} />添加输入</button>
          </section>
          <section className="af-form-section"><h3>输出字段 {isCore && <span className="af-badge">内置契约</span>}</h3>
            {node.outputs.map((field, index) => <div className="af-output" key={index}>
              <input aria-label={`输出字段 ${index + 1}`} className={inputClass} disabled={isCore} value={field.name} onChange={(e) => onChange({ outputs: node.outputs.map((f, i) => i === index ? { ...f, name: e.target.value } : f) })} />
              <select aria-label={`输出类型 ${index + 1}`} className={inputClass} disabled={isCore} value={field.type} onChange={(e) => onChange({ outputs: node.outputs.map((f, i) => i === index ? { ...f, type: e.target.value as FlowFieldType } : f) })}>
                {FIELD_TYPES.map((kind) => <option key={kind}>{kind}</option>)}
              </select>
              <label title="必填"><input type="checkbox" aria-label={`必填 ${field.name}`} disabled={isCore} checked={field.required} onChange={(e) => onChange({ outputs: node.outputs.map((f, i) => i === index ? { ...f, required: e.target.checked } : f) })} /></label>
              {!isCore && <button className="af-icon" title="删除输出" onClick={() => onChange({ outputs: node.outputs.filter((_, i) => i !== index) })}><Trash2 size={13} /></button>}
            </div>)}
            {!isCore && <button className="af-button" onClick={() => onChange({ outputs: [...node.outputs, { name: `field_${node.outputs.length + 1}`, type: "string", required: true }] })}><Plus size={13} />添加输出</button>}
          </section>
          <section className="af-form-section"><h3>工具</h3>
            {tools.map((tool) => <label className="af-tool" key={tool.name} title={tool.description}>
              <input type="checkbox" checked={node.execution.tools.includes(tool.name)} onChange={(e) => onChange({
                execution: { ...node.execution, tools: e.target.checked ? [...node.execution.tools, tool.name] : node.execution.tools.filter((name) => name !== tool.name) },
              })} /><span>{tool.name}</span>
            </label>)}
            {node.execution.tools.length === 0 && <span className="af-muted">无工具</span>}
          </section>
          <section className="af-form-section"><h3>执行限制</h3>
            <div className="af-two-fields">
              <label className="af-field">最大迭代<input className={inputClass} type="number" min={1} max={10} value={node.execution.maxIterations} onChange={(e) => onChange({ execution: { ...node.execution, maxIterations: Number(e.target.value) } })} /></label>
              <label className="af-field">超时 / 秒<input className={inputClass} type="number" min={1} max={180} value={node.execution.timeoutMs / 1000} onChange={(e) => onChange({ execution: { ...node.execution, timeoutMs: Number(e.target.value) * 1000 } })} /></label>
            </div>
          </section>
        </>}
        {node.type === "condition" && node.condition && <section className="af-form-section"><h3>分支判断 {gate && <span className="af-badge">诊断保护</span>}</h3>
          <fieldset disabled={gate}>
            <label className="af-field">字段<ReferenceSelect value={node.condition.reference} nodes={otherNodes} onChange={(reference) => onChange({ condition: { ...node.condition!, reference } })} /></label>
            <label className="af-field">比较<select className={inputClass} value={node.condition.operator} onChange={(e) => onChange({ condition: { ...node.condition!, operator: e.target.value as "eq" | "ne" } })}><option value="eq">等于</option><option value="ne">不等于</option></select></label>
            <label className="af-field">值类型<select className={inputClass} value={typeof node.condition.value} onChange={(e) => onChange({ condition: { ...node.condition!, value: e.target.value === "boolean" ? true : e.target.value === "number" ? 0 : "" } })}><option value="boolean">boolean</option><option value="string">string</option><option value="number">number</option></select></label>
            {typeof node.condition.value === "boolean"
              ? <label className="af-tool"><input type="checkbox" checked={node.condition.value} onChange={(e) => onChange({ condition: { ...node.condition!, value: e.target.checked } })} />true</label>
              : <label className="af-field">比较值<input className={inputClass} type={typeof node.condition.value === "number" ? "number" : "text"} value={String(node.condition.value ?? "")} onChange={(e) => onChange({ condition: { ...node.condition!, value: typeof node.condition!.value === "number" ? Number(e.target.value) : e.target.value } })} /></label>}
          </fieldset>
        </section>}
        <button className="af-button af-danger" disabled={protectedNode} onClick={onDelete}><Trash2 size={14} />删除节点</button>
      </div>
    </aside>
  );
}
