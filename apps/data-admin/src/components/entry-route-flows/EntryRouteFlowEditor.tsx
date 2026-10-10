import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ReactFlow, Background, Controls, Handle, Position, applyNodeChanges,
  type Connection, type NodeChange, type NodeProps, type ReactFlowInstance,
} from "@xyflow/react";
import { ArrowLeft, Check, CirclePlay, GitBranch, Loader2, MessageSquare, Play, Route, Save, ShieldCheck, SkipForward, Trash2, Upload, X } from "lucide-react";
import { client } from "@agentforge/ui";
import type { EntryRouteDefinition, EntryRouteFlowDTO, EntryRouteNode, EntryRouteRunDTO, EntryRouteValidation } from "@agentforge/shared-types";
import { EntryNodePanel, ENTRY_NODE_LABELS } from "./EntryNodePanel";
import { EntryRunPanel } from "./EntryRunPanel";
import { commitEntryPositions, entryDefinitionKey, syncEntryCanvas, type EntryCanvasNode } from "./canvas-state";
import "@xyflow/react/dist/style.css";
import "../agent-flows/agent-flows.css";
import "./entry-route-flows.css";

const ICONS = { start: CirclePlay, condition: GitBranch, reply: MessageSquare, route: Route, continue: SkipForward };
const FIT_OPTIONS = { padding: 0.16 };
const EntryBlock = memo(function EntryBlock({ data, selected }: NodeProps<EntryCanvasNode>) {
  const node = data.config;
  const Icon = ICONS[node.type];
  return <div className={`af-canvas-node er-block er-kind-${node.type} ${selected ? "af-selected" : ""} ${data.visited ? "af-state-completed" : ""} ${data.invalid ? "af-state-failed" : ""}`}>
    {node.type !== "start" && <Handle type="target" position={Position.Left} />}
    <div className="af-block-label"><Icon size={15} /><span>{ENTRY_NODE_LABELS[node.type]}</span>{data.visited && <Check size={13} />}</div>
    <div className="af-block-name">{node.name}</div>
    <div className="af-block-detail">{node.type === "condition" ? node.condition.words.slice(0, 3).join(" / ") : node.type === "route" ? node.target : node.type === "reply" ? node.answer.slice(0, 40) : ""}</div>
    {node.type === "condition" ? <>
      <span className="af-handle-label af-true-label">是</span><Handle id="true" type="source" position={Position.Right} style={{ top: "36%" }} />
      <span className="af-handle-label af-false-label">否</span><Handle id="false" type="source" position={Position.Right} style={{ top: "76%" }} />
    </> : node.type === "start" && <Handle type="source" position={Position.Right} />}
  </div>;
});
const nodeTypes = { entry: EntryBlock };

export function EntryRouteFlowEditor() {
  const { flowId } = useParams<{ flowId: string }>();
  const query = useQuery({ queryKey: ["entry-route-flow", flowId], queryFn: () => client.getEntryRouteFlow(flowId!), enabled: !!flowId });
  if (query.isLoading) return <div className="af-empty"><Loader2 size={22} className="animate-spin" /></div>;
  if (query.error) return <div className="af-error" role="alert">{query.error.message}</div>;
  return query.data ? <Editor key={flowId} initial={query.data} /> : null;
}

function Editor({ initial }: { initial: EntryRouteFlowDTO }) {
  const queries = useQueryClient();
  const [flow, setFlow] = useState(initial);
  const [definition, setDefinition] = useState(initial.draft);
  const [name, setName] = useState(initial.name);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [showRun, setShowRun] = useState(false);
  const [run, setRun] = useState<EntryRouteRunDTO | null>(null);
  const [page, setPage] = useState(1);
  const [message, setMessage] = useState("你好");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [validation, setValidation] = useState<EntryRouteValidation | null>(null);
  const controller = useRef<AbortController | null>(null);
  const dragging = useRef(new Set<string>());
  const canvasElement = useRef<HTMLDivElement | null>(null);
  const [canvas, setCanvas] = useState<ReactFlowInstance<EntryCanvasNode> | null>(null);
  const [canvasNodes, setCanvasNodes] = useState<EntryCanvasNode[]>(() => syncEntryCanvas([], initial.draft, null, new Set(), new Set()));
  const runs = useQuery({ queryKey: ["entry-route-runs", flow.id, page], queryFn: () => client.listEntryRouteRuns(flow.id, page), enabled: showRun });
  const dirty = name !== flow.name || entryDefinitionKey(definition) !== entryDefinitionKey(flow.draft);
  const node = definition.nodes.find((item) => item.id === selected);
  const visited = useMemo(() => new Set(run?.records.map((item) => item.nodeId) ?? []), [run]);
  const invalid = useMemo(() => new Set(validation?.errors.flatMap((item) => item.nodeId ? [item.nodeId] : []) ?? []), [validation]);
  useEffect(() => { setCanvasNodes((previous) => syncEntryCanvas(previous, definition, selected, visited, invalid)); }, [definition, selected, visited, invalid]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => { if (dirty || busy) event.preventDefault(); };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [dirty, busy]);
  const edges = useMemo(() => definition.edges.map((edge) => ({
    ...edge, sourceHandle: edge.branch, selected: edge.id === selectedEdge,
    label: edge.branch === "true" ? "是" : edge.branch === "false" ? "否" : undefined,
    style: { stroke: edge.branch === "false" ? "#b7791f" : "#82938f", strokeWidth: 1.7 },
  })), [definition.edges, selectedEdge]);
  function edit(next: EntryRouteDefinition) { setDefinition(next); setValidation(null); setRun(null); setNotice(""); }
  const onChanges = useCallback((changes: NodeChange<EntryCanvasNode>[]) => {
    setCanvasNodes((previous) => applyNodeChanges(changes, previous));
    for (const change of changes) if (change.type === "position" && change.dragging !== undefined) {
      if (change.dragging) dragging.current.add(change.id); else dragging.current.delete(change.id);
    }
    if (!busy && changes.some((change) => change.type === "position" && change.dragging !== true && change.position)) setDefinition((draft) => commitEntryPositions(draft, changes));
  }, [busy]);
  function connect(connection: Connection) {
    if (busy || !connection.source || !connection.target || connection.source === connection.target) return;
    const source = definition.nodes.find((item) => item.id === connection.source);
    if (!source || !["start", "condition"].includes(source.type)) return;
    const branch = (connection.sourceHandle ?? null) as "true" | "false" | null;
    edit({ ...definition, edges: [
      ...definition.edges.filter((edge) => !(edge.source === connection.source && edge.branch === branch)),
      { id: `edge_${crypto.randomUUID()}`, source: connection.source, target: connection.target, branch },
    ] });
  }
  function add(type: "condition" | "reply" | "route" | "continue") {
    const bounds = canvasElement.current?.getBoundingClientRect();
    const center = bounds && canvas
      ? canvas.screenToFlowPosition({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 })
      : { x: 400, y: 400 };
    let position = center;
    for (let candidate = 0; candidate < 36; candidate++) {
      const proposed = { x: center.x + (candidate % 4) * 270, y: center.y + Math.floor(candidate / 4) * 170 };
      if (definition.nodes.every((item) =>
        proposed.x + 242 <= item.position.x || proposed.x >= item.position.x + 242 ||
        proposed.y + 144 <= item.position.y || proposed.y >= item.position.y + 144)) {
        position = proposed; break;
      }
    }
    const base = {
      id: `${type}_${crypto.randomUUID().slice(0, 8)}`, name: ENTRY_NODE_LABELS[type],
      position,
    };
    const next: EntryRouteNode = type === "condition"
      ? { ...base, type, condition: { operator: "contains_any", words: ["关键词"], excludeAny: [], ignoreCase: true, stripTrailingPunctuation: false } }
      : type === "reply" ? { ...base, type, answer: "请输入回复内容", suggestions: [] }
        : type === "route" ? { ...base, type, target: "CHAT" } : { ...base, type };
    edit({ ...definition, nodes: [...definition.nodes, next] });
    setSelected(next.id); setSelectedEdge(null); setShowRun(false);
  }
  function removeNode() {
    if (!node || node.type === "start") return;
    edit({ ...definition, nodes: definition.nodes.filter((item) => item.id !== node.id), edges: definition.edges.filter((edge) => edge.source !== node.id && edge.target !== node.id) });
    setSelected(null);
  }
  function updateFlow(next: EntryRouteFlowDTO) {
    setFlow(next);
    queries.setQueryData(["entry-route-flow", next.id], next);
  }
  async function save() {
    if (!dirty) return flow;
    const saved = await client.saveEntryRouteFlow(flow.id, name, flow.draftRevision, definition);
    updateFlow(saved); setName(saved.name); setDefinition(saved.draft);
    await queries.invalidateQueries({ queryKey: ["entry-route-flows"] });
    return saved;
  }
  async function check(saved: EntryRouteFlowDTO) {
    const result = await client.validateEntryRouteFlow(saved.id, saved.draftRevision);
    setValidation(result);
    if (!result.valid) {
      setShowRun(false);
      const first = result.errors.find((item) => item.nodeId);
      if (first?.nodeId) { setSelected(first.nodeId); void canvas?.fitView({ nodes: [{ id: first.nodeId }], padding: 0.5, duration: 200 }); }
    }
    return result.valid;
  }
  async function action(kind: "save" | "validate" | "publish" | "activate" | "run") {
    setBusy(true); setError(""); setNotice("");
    const abort = new AbortController(); controller.current = abort;
    try {
      if (kind === "activate") {
        const updated = await client.activateEntryRouteFlow(flow.id, !flow.enabled);
        updateFlow(updated); setNotice(updated.enabled ? "已启用发布版本" : "已停用");
      } else {
        const saved = await save();
        if (kind === "save") setNotice("已保存");
        else if (await check(saved)) {
          if (kind === "validate") setNotice("校验通过");
          if (kind === "publish") {
            const published = await client.publishEntryRouteFlow(saved.id, saved.draftRevision);
            updateFlow(published); setNotice(`已发布 v${published.publishedVersion}`);
          }
          if (kind === "run") {
            setRun(await client.testEntryRouteFlow(saved.id, saved.draftRevision, message, abort.signal));
            setPage(1);
            await queries.invalidateQueries({ queryKey: ["entry-route-runs", flow.id] });
          }
        }
      }
      await queries.invalidateQueries({ queryKey: ["entry-route-flows"] });
    } catch (e) {
      if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); controller.current = null; }
  }
  async function selectRun(id: string) {
    setBusy(true); setError("");
    try { setRun(await client.getEntryRouteRun(flow.id, id)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <div className="af-editor er-editor">
    <header className="af-editor-header">
      <Link className="af-icon" title="返回流程列表" aria-label="返回流程列表" to="/admin/cs/entry-route-flows" onClick={(event) => {
        if ((dirty || busy) && !window.confirm("离开此页面？未保存修改将丢失。")) event.preventDefault();
      }}><ArrowLeft size={18} /></Link>
      <input className="af-name-input" aria-label="流程名称" value={name} maxLength={200} disabled={busy} onChange={(e) => setName(e.target.value)} />
      <span className="af-badge">{dirty ? "未保存" : flow.draftRevision !== flow.publishedRevision ? "未发布" : `v${flow.publishedVersion}`}</span>
      <div className="af-toolbar">
        <button className="af-button" disabled={busy || !dirty} onClick={() => action("save")}><Save size={14} />保存</button>
        <button className="af-button" disabled={busy} onClick={() => action("validate")}><ShieldCheck size={14} />校验</button>
        <button className="af-button" disabled={busy} onClick={() => { setShowRun(!showRun); setSelected(null); }}><Play size={14} />试运行</button>
        <button className="af-button af-primary" disabled={busy} onClick={() => action("publish")}><Upload size={14} />发布</button>
        <label className="af-activation"><input type="checkbox" role="switch" aria-label="启用发布流程" checked={flow.enabled} disabled={busy || (!flow.enabled && (!flow.publishedVersion || dirty))} onChange={() => action("activate")} /><span>{flow.enabled ? "已启用" : "未启用"}</span></label>
      </div>
    </header>
    {(error || notice) && <div className={`af-banner ${error ? "af-error" : ""}`} role={error ? "alert" : "status"}>
      <span>{error || notice}</span><button className="af-icon" title="关闭提示" aria-label="关闭提示" onClick={() => { setError(""); setNotice(""); }}><X size={14} /></button>
    </div>}
    {validation && !validation.valid && <div className="af-banner af-error er-validation" role="alert">
      {validation.errors.map((item, i) => <button key={i} onClick={() => {
        if (item.nodeId) { setSelected(item.nodeId); setShowRun(false); void canvas?.fitView({ nodes: [{ id: item.nodeId }], padding: 0.5, duration: 200 }); }
      }}>{item.path}: {item.message}</button>)}
    </div>}
    <div className="af-editor-body">
      <div className="af-canvas er-canvas" ref={canvasElement}>
        <div className="af-add-toolbar er-add-toolbar">
          {(["condition", "reply", "route", "continue"] as const).map((type) => {
            const Icon = ICONS[type];
            return <button className="af-icon" key={type} title={`添加${ENTRY_NODE_LABELS[type]}`} aria-label={`添加${ENTRY_NODE_LABELS[type]}`} disabled={busy || definition.nodes.length >= 30} onClick={() => add(type)}><Icon size={17} /></button>;
          })}
          {selectedEdge && <button className="af-icon af-danger" title="删除选中连线" aria-label="删除选中连线" disabled={busy} onClick={() => { edit({ ...definition, edges: definition.edges.filter((edge) => edge.id !== selectedEdge) }); setSelectedEdge(null); }}><Trash2 size={16} /></button>}
        </div>
        <ReactFlow<EntryCanvasNode>
          nodes={canvasNodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={FIT_OPTIONS} onInit={setCanvas}
          onNodesChange={onChanges} onConnect={connect}
          onNodeClick={(_, clicked) => { setSelected(clicked.id); setSelectedEdge(null); setShowRun(false); }}
          onEdgeClick={(_, edge) => { setSelectedEdge(edge.id); setSelected(null); }}
          onPaneClick={() => { setSelected(null); setSelectedEdge(null); }}
          nodesDraggable={!busy} nodesConnectable={!busy} deleteKeyCode={null} minZoom={0.2} maxZoom={1.8}
        ><Background gap={22} size={1} color="#d6dedb" /><Controls showInteractive={false} /></ReactFlow>
        <div className="af-canvas-status">{definition.nodes.length} 个节点 · {flow.enabled ? `正式 v${flow.publishedVersion}` : "未启用"}</div>
      </div>
      {node && !showRun && <fieldset className="af-panel-fieldset" disabled={busy}>
        <EntryNodePanel node={node} onChange={(next) => edit({ ...definition, nodes: definition.nodes.map((item) => item.id === next.id ? next : item) })} onDelete={removeNode} onClose={() => setSelected(null)} />
      </fieldset>}
      {showRun && <EntryRunPanel
        message={message} onMessage={setMessage} busy={busy} onRun={() => action("run")} onClose={() => setShowRun(false)}
        run={run} runs={runs.data} onSelect={selectRun} page={page} onPage={setPage} historyError={runs.error?.message}
      />}
    </div>
  </div>;
}
