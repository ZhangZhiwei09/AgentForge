import { memo, useCallback, useEffect, useRef, useState, useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ReactFlow, Background, Controls, Handle, Position, applyNodeChanges,
  type NodeProps, type NodeChange, type Connection, type ReactFlowInstance,
} from "@xyflow/react";
import {
  ArrowLeft, Bot, GitBranch, Flag, CirclePlay, Save, Upload, Play,
  Plus, Trash2, Loader2, X, Check, AlertCircle,
} from "lucide-react";
import { client } from "@agentforge/ui";
import type {
  AgentFlowDTO, AgentFlowDefinition, AgentFlowNode, AgentFlowNodeRecord, AgentFlowRunDTO,
} from "@agentforge/shared-types";
import { FlowNodePanel } from "./FlowNodePanel";
import { FlowRunPanel } from "./FlowRunPanel";
import { commitCanvasPositions, syncCanvasNodes, type CanvasNode } from "./canvas-state";
import "@xyflow/react/dist/style.css";
import "./agent-flows.css";

const NODE_ICONS = { start: CirclePlay, agent: Bot, condition: GitBranch, end: Flag };
const NODE_LABELS = { start: "开始", agent: "Agent", condition: "条件", end: "结束" };
const FIT_VIEW_OPTIONS = { padding: 0.18 };

function definitionKey(definition: AgentFlowDefinition): string {
  // JSONB changes object key order; array order still carries flow semantics.
  return JSON.stringify(definition, (_, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value);
}

const CanvasBlock = memo(function CanvasBlock({ data, selected }: NodeProps<CanvasNode>) {
  const node = data.config;
  const Icon = NODE_ICONS[node.type];
  return <div className={`af-canvas-node af-kind-${node.type} ${data.core ? `af-core-${data.core}` : ""} ${selected ? "af-selected" : ""} ${data.state ? `af-state-${data.state}` : ""}`}>
    {node.type !== "start" && <Handle type="target" position={Position.Left} />}
    <div className="af-block-label"><Icon size={15} /><span>{NODE_LABELS[node.type]}</span>{data.state === "completed" && <Check size={13} />}</div>
    <div className="af-block-name">{node.name}</div>
    {node.type === "agent" && <div className="af-block-detail">{node.role?.name || "未配置身份"} · {node.execution.tools.length} 个工具</div>}
    {node.type === "condition" && <div className="af-block-detail">{node.condition?.reference.path.join(".") || "未配置字段"}</div>}
    {node.type === "condition" ? <>
      <span className="af-handle-label af-true-label">是</span><Handle id="true" type="source" position={Position.Right} style={{ top: "36%" }} />
      <span className="af-handle-label af-false-label">否</span><Handle id="false" type="source" position={Position.Right} style={{ top: "76%" }} />
    </> : node.type !== "end" && <Handle type="source" position={Position.Right} />}
  </div>;
});
const nodeTypes = { flow: CanvasBlock };

export function AgentFlowEditor() {
  const { flowId } = useParams<{ flowId: string }>();
  const query = useQuery({
    queryKey: ["agent-flow", flowId], queryFn: () => client.getAgentFlow(flowId!), enabled: !!flowId,
  });
  if (query.isLoading) return <div className="af-empty"><Loader2 size={22} className="animate-spin" /></div>;
  if (query.error) return <div className="af-error" role="alert">{query.error.message}</div>;
  return query.data ? <Editor key={flowId} initial={query.data} /> : null;
}

function Editor({ initial }: { initial: AgentFlowDTO }) {
  const queries = useQueryClient();
  const [flow, setFlow] = useState(initial);
  const [definition, setDefinition] = useState<AgentFlowDefinition>(initial.draft);
  const [name, setName] = useState(initial.name);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [showRun, setShowRun] = useState(false);
  const [message, setMessage] = useState("traceId: test-123，H5 刷脸失败，返回 ACE_TIMEOUT，请排查");
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState("");
  const [notice, setNotice] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [records, setRecords] = useState<Record<string, AgentFlowNodeRecord>>({});
  const [canvasNodes, setCanvasNodes] = useState<CanvasNode[]>(() =>
    syncCanvasNodes([], initial.draft, null, {}));
  const [runStatus, setRunStatus] = useState("");
  const [output, setOutput] = useState<Record<string, unknown> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const canvasElement = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(new Set<string>());
  const [canvas, setCanvas] = useState<ReactFlowInstance<CanvasNode> | null>(null);
  const tools = useQuery({ queryKey: ["agent-flow-tools"], queryFn: () => client.listAgentFlowTools() });
  const history = useQuery({
    queryKey: ["agent-flow-runs", flow.id], queryFn: () => client.listAgentFlowRuns(flow.id),
    enabled: showRun, refetchInterval: running ? 1500 : false,
  });
  const draftKey = useMemo(() => definitionKey(definition), [definition]);
  const savedKey = useMemo(() => definitionKey(flow.draft), [flow.draft]);
  const dirty = name !== flow.name || draftKey !== savedKey;
  const node = definition.nodes.find((n) => n.id === selected);
  const working = busy || running;

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    setCanvasNodes((previous) => syncCanvasNodes(previous, definition, selected, records));
  }, [definition, selected, records]);
  useEffect(() => {
    if (!canvas || !canvasElement.current) return;
    let frame = 0;
    let size: { width: number; height: number } | null = null;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (size?.width === width && size.height === height) return;
      const initialized = size !== null;
      size = { width, height };
      cancelAnimationFrame(frame);
      if (!initialized || width <= 0 || height <= 0 || dragging.current.size > 0) return;
      frame = requestAnimationFrame(() => {
        if (!dragging.current.size) void canvas.fitView(FIT_VIEW_OPTIONS);
      });
    });
    observer.observe(canvasElement.current);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [canvas]);
  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) { if (dirty || running || dragging.current.size > 0) event.preventDefault(); }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty, running]);

  const canvasEdges = useMemo(() => definition.edges.map((edge) => ({
    id: edge.id, source: edge.source, target: edge.target, sourceHandle: edge.branch,
    selected: edge.id === selectedEdge, label: edge.branch === "true" ? "是" : edge.branch === "false" ? "否" : undefined,
    style: { stroke: edge.branch === "false" ? "#b7791f" : "#82938f", strokeWidth: 1.7 },
  })), [definition.edges, selectedEdge]);

  function changeNode(patch: Partial<AgentFlowNode>) {
    setDefinition((draft) => ({ ...draft, nodes: draft.nodes.map((n) => n.id === selected ? { ...n, ...patch } : n) }));
    setNotice("");
  }
  const changes = useCallback((changes: NodeChange<CanvasNode>[]) => {
    setCanvasNodes((previous) => applyNodeChanges(changes, previous));
    for (const change of changes) {
      if (change.type === "position" && change.dragging !== undefined) {
        if (change.dragging) dragging.current.add(change.id);
        else dragging.current.delete(change.id);
      }
    }
    if (!working && changes.some((change) => change.type === "position" && change.dragging !== true && change.position)) {
      setDefinition((draft) => commitCanvasPositions(draft, changes));
    }
  }, [working]);
  function connect(connection: Connection) {
    if (working || !connection.source || !connection.target || connection.source === connection.target) return;
    const branch = connection.sourceHandle as "true" | "false" | null;
    setDefinition((draft) => ({
      ...draft, edges: [
        ...draft.edges.filter((edge) => !(edge.source === connection.source && edge.branch === branch)),
        { id: `edge_${crypto.randomUUID()}`, source: connection.source!, target: connection.target!, branch },
      ],
    }));
  }
  function addNode(type: "agent" | "condition" | "end") {
    const id = `${type}_${crypto.randomUUID().slice(0, 8)}`;
    const after = node && node.type !== "condition" && node.type !== "end" &&
      node.id !== definition.diagnosisBindings.frontend && node.type !== "start" ? node : null;
    const next: AgentFlowNode = {
      id, type, name: type === "agent" ? "新专家" : type === "condition" ? "条件判断" : "结束",
      position: { x: (after?.position.x ?? 450) + 240, y: after?.position.y ?? 460 },
      role: type === "agent" ? { name: "新专家", description: "", systemPrompt: "" } : null,
      task: type === "agent" ? "基于映射的输入进行独立排查，给出结论与证据。" : "",
      inputs: type === "agent" ? { question: { source: "task", path: [] } } : {},
      outputs: type === "agent" ? [{ name: "conclusion", type: "string", required: true }, { name: "evidence", type: "array", required: true }] : [],
      execution: { tools: [], maxIterations: 5, timeoutMs: 60000 },
      condition: type === "condition" ? { reference: { source: "node", nodeId: definition.diagnosisBindings.frontend, path: ["need_escalation"] }, operator: "eq", value: true } : null,
    };
    setDefinition((draft) => {
      const successor = after && type === "agent" ? draft.edges.find((edge) => edge.source === after.id) : null;
      const shifted = new Set<string>();
      const pending = successor ? [successor.target] : [];
      while (pending.length) {
        const id = pending.pop()!;
        if (shifted.has(id)) continue;
        shifted.add(id);
        pending.push(...draft.edges.filter((edge) => edge.source === id).map((edge) => edge.target));
      }
      const nodes = [
        ...draft.nodes.map((item) => shifted.has(item.id)
          ? { ...item, position: { ...item.position, x: item.position.x + 240 } } : item),
        next,
      ];
      if (successor?.target === draft.diagnosisBindings.leader) {
        const leader = nodes.find((n) => n.id === draft.diagnosisBindings.leader)!;
        nodes[nodes.indexOf(leader)] = { ...leader, inputs: { ...leader.inputs, [id]: { source: "node", nodeId: id, path: [] } } };
      }
      return {
        ...draft, nodes,
        edges: successor ? [
          ...draft.edges.filter((edge) => edge.id !== successor.id),
          { ...successor, target: id },
          { id: `edge_${crypto.randomUUID()}`, source: id, target: successor.target, branch: null },
        ] : draft.edges,
      };
    });
    setSelected(id); setShowRun(false); setSelectedEdge(null);
  }
  function removeNode() {
    if (!node) return;
    setDefinition((draft) => {
      const next = draft.edges.find((edge) => edge.source === node.id);
      return {
        ...draft,
        nodes: draft.nodes.filter((n) => n.id !== node.id).map((n) => ({
          ...n, inputs: Object.fromEntries(Object.entries(n.inputs).filter(([, ref]) => ref.nodeId !== node.id)),
        })),
        edges: draft.edges.filter((e) => e.source !== node.id && (e.target !== node.id || !!next)).map((e) => e.target === node.id ? { ...e, target: next!.target } : e),
      };
    });
    setSelected(null);
  }
  async function save(): Promise<AgentFlowDTO> {
    if (!dirty) return flow;
    const saved = await client.saveAgentFlow(flow.id, name, flow.draftRevision, definition);
    setFlow(saved); setDefinition(saved.draft); setName(saved.name);
    queries.invalidateQueries({ queryKey: ["agent-flows"] });
    return saved;
  }
  async function action(kind: "save" | "publish" | "activate") {
    setBusy(true); setFailure(""); setNotice("");
    try {
      if (kind === "activate") {
        const updated = await client.activateAgentFlow(flow.id, !flow.enabled);
        setFlow(updated); setNotice(updated.enabled ? "已启用发布版本" : "已停用");
      } else {
        const saved = await save();
        if (kind === "publish") {
          const published = await client.publishAgentFlow(saved.id, saved.draftRevision);
          setFlow(published); setNotice(`已发布 v${published.publishedVersion}`);
        } else setNotice("已保存");
      }
      await queries.invalidateQueries({ queryKey: ["agent-flows"] });
    } catch (error) { setFailure(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function run() {
    setRunning(true); setFailure(""); setNotice(""); setRecords({}); setOutput(null); setRunId(null); setRunStatus("running");
    const abort = new AbortController(); controller.current = abort;
    try {
      const saved = await save();
      for await (const event of client.testAgentFlow(saved.id, saved.draftRevision, message, abort.signal)) {
        if (event.runId) setRunId(event.runId);
        if (event.nodeId && event.type.startsWith("node_")) {
          const item = saved.draft.nodes.find((n) => n.id === event.nodeId)!;
          setRecords((prev) => ({
            ...prev, [item.id]: {
              ...prev[item.id], nodeId: item.id, name: item.name, type: item.type,
              status: event.type === "node_started" ? "running" : event.type === "node_completed" ? "completed" : "failed",
              ...(event.inputs ? { inputs: event.inputs } : {}), ...(event.output ? { output: event.output } : {}),
              ...(event.error ? { error: event.error } : {}), durationMs: event.durationMs,
            },
          }));
        }
        if (event.type === "flow_completed") {
          setOutput(event.output || null); setRunStatus("completed");
          setRecords((prev) => {
            const next = { ...prev };
            for (const id of event.skippedNodes || []) {
              const item = saved.draft.nodes.find((n) => n.id === id)!;
              next[id] = { nodeId: id, name: item.name, type: item.type, status: "skipped" };
            }
            return next;
          });
        }
        if (event.type === "flow_failed" || event.type === "flow_cancelled") {
          const status = event.type === "flow_failed" ? "failed" : "cancelled";
          setRunStatus(status);
          setRecords((prev) => Object.fromEntries(Object.entries(prev).map(([id, record]) => [
            id, record.status === "running" ? { ...record, status } : record,
          ])));
          if (event.error) setFailure(event.error);
        }
      }
    } catch (error) {
      const status = abort.signal.aborted ? "cancelled" : "failed";
      setRunStatus(status);
      setRecords((prev) => Object.fromEntries(Object.entries(prev).map(([id, record]) => [
        id, record.status === "running" ? { ...record, status } : record,
      ])));
      if (!abort.signal.aborted) setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false); controller.current = null;
      await queries.invalidateQueries({ queryKey: ["agent-flow-runs", flow.id] });
    }
  }
  async function cancel() {
    try { if (runId) await client.cancelAgentFlowRun(flow.id, runId); }
    catch (error) { setFailure(error instanceof Error ? error.message : String(error)); }
  }
  function selectRun(run: AgentFlowRunDTO) {
    setRunId(run.id); setRecords(run.records); setOutput(run.output); setRunStatus(run.status);
    setFailure(run.error || "");
  }

  return <div className="af-editor">
    <header className="af-editor-header">
      <Link className="af-icon" title="返回流程列表" aria-label="返回流程列表" to="/admin/cs/agent-flows" onClick={(event) => {
        if ((dirty || running || dragging.current.size > 0) && !window.confirm("离开此页面？未保存修改将丢失，试运行将取消。")) event.preventDefault();
      }}><ArrowLeft size={18} /></Link>
      <input className="af-name-input" aria-label="流程名称" value={name} onChange={(e) => setName(e.target.value)} disabled={working} maxLength={200} />
      <span className="af-badge">{dirty ? "未保存" : flow.draftRevision !== flow.publishedRevision ? "未发布" : `v${flow.publishedVersion}`}</span>
      <div className="af-toolbar">
        <button className="af-button" disabled={working || !dirty} onClick={() => action("save")}><Save size={14} />保存</button>
        <button className="af-button" disabled={busy} onClick={() => { setShowRun(!showRun); setSelected(null); }}><Play size={14} />试运行</button>
        <button className="af-button af-primary" disabled={working} onClick={() => action("publish")}><Upload size={14} />发布</button>
        <label className="af-activation"><input type="checkbox" role="switch" aria-label="启用发布流程" checked={flow.enabled} disabled={working || !flow.publishedVersion || dirty} onChange={() => action("activate")} /><span>{flow.enabled ? "已启用" : "未启用"}</span></label>
      </div>
    </header>
    {(failure || notice || tools.error || history.error) && <div className={`af-banner ${failure || tools.error || history.error ? "af-error" : ""}`} role={failure ? "alert" : "status"}>
      {failure ? <AlertCircle size={16} /> : <Check size={16} />}<span>{failure || tools.error?.message || history.error?.message || notice}</span>
      <button className="af-icon" title="关闭提示" onClick={() => { setFailure(""); setNotice(""); }}><X size={14} /></button>
    </div>}
    <div className="af-editor-body">
      <div className="af-canvas" ref={canvasElement}>
        <div className="af-add-toolbar">
          <button className="af-button" disabled={working} onClick={() => addNode("agent")}><Plus size={13} /><Bot size={14} />Agent</button>
          <button className="af-button" disabled={working} onClick={() => addNode("condition")}><GitBranch size={14} />条件</button>
          <button className="af-button" disabled={working} onClick={() => addNode("end")}><Flag size={14} />结束</button>
          {selectedEdge && <button className="af-icon af-danger" title="删除选中连线" aria-label="删除选中连线" disabled={working} onClick={() => {
            setDefinition((d) => ({ ...d, edges: d.edges.filter((e) => e.id !== selectedEdge) })); setSelectedEdge(null);
          }}><Trash2 size={15} /></button>}
        </div>
        <ReactFlow<CanvasNode>
          nodes={canvasNodes} edges={canvasEdges} nodeTypes={nodeTypes} fitView
          onInit={setCanvas}
          onNodesChange={changes} onConnect={connect}
          onNodeClick={(_, clicked) => { setSelected(clicked.id); setSelectedEdge(null); setShowRun(false); }}
          onEdgeClick={(_, edge) => { setSelectedEdge(edge.id); setSelected(null); }}
          onPaneClick={() => { setSelected(null); setSelectedEdge(null); }}
          nodesDraggable={!working} nodesConnectable={!working} deleteKeyCode={null}
          minZoom={0.25} maxZoom={1.8} fitViewOptions={FIT_VIEW_OPTIONS}
        ><Background gap={22} size={1} color="#d6dedb" /><Controls showInteractive={false} /></ReactFlow>
        <div className="af-canvas-status">{definition.nodes.filter((n) => n.type === "agent").length} 个 Agent · {definition.limits.timeoutMs / 1000}s</div>
      </div>
      {node && !showRun && <fieldset disabled={working} className="af-panel-fieldset">
        <FlowNodePanel node={node} definition={definition} tools={tools.data?.tools || []} onChange={changeNode} onDelete={removeNode} onClose={() => setSelected(null)} />
      </fieldset>}
      {showRun && <FlowRunPanel definition={definition} message={message} onMessage={setMessage} busy={running} runId={runId} records={records} status={runStatus} runs={history.data?.items || []} output={output} onRun={run} onCancel={cancel} onClose={() => setShowRun(false)} onSelectRun={selectRun} />}
    </div>
  </div>;
}
