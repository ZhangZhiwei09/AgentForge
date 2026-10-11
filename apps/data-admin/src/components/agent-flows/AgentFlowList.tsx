import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Plus, RefreshCw, ArrowRight, Loader2, Archive, Route } from "lucide-react";
import type { AgentFlowDTO, EntryRouteFlowDTO } from "@agentforge/shared-types";
import { client } from "@agentforge/ui";
import "./agent-flows.css";

type FlowKind = "agent" | "entry";
type FlowItem = { kind: FlowKind; flow: AgentFlowDTO | EntryRouteFlowDTO };

export function AgentFlowList() {
  const navigate = useNavigate();
  const queries = useQueryClient();
  const user = useQuery({ queryKey: ["auth", "me"], queryFn: () => client.getMe(), retry: false });
  const isAdmin = user.data?.role === "admin";
  const agents = useQuery({
    queryKey: ["agent-flows"], queryFn: () => client.listAgentFlows(),
    enabled: isAdmin,
  });
  const entries = useQuery({
    queryKey: ["entry-route-flows"], queryFn: () => client.listEntryRouteFlows(),
    enabled: isAdmin,
  });
  const [kind, setKind] = useState<FlowKind>("agent");
  const [name, setName] = useState("核身诊断流程");
  const [template, setTemplate] = useState<"default" | "empty">("default");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const items: FlowItem[] = [
    ...(agents.data?.items ?? []).map((flow) => ({ kind: "agent" as const, flow })),
    ...(entries.data?.items ?? []).map((flow) => ({ kind: "entry" as const, flow })),
  ].sort((a, b) => Date.parse(b.flow.updatedAt) - Date.parse(a.flow.updatedAt));

  function changeKind(value: FlowKind) {
    setKind(value);
    if (name === "核身诊断流程" || name === "一级路由流程") {
      setName(value === "entry" ? "一级路由流程" : "核身诊断流程");
    }
    setFailure("");
  }

  async function create() {
    setBusy(true);
    setFailure("");
    try {
      const flow = kind === "agent"
        ? await client.createAgentFlow(name.trim())
        : await client.createEntryRouteFlow(name.trim(), template);
      const resource = kind === "agent" ? "agent-flows" : "entry-route-flows";
      await queries.invalidateQueries({ queryKey: [resource] });
      navigate(`/admin/cs/${resource}/${flow.id}`);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  async function archive(item: FlowItem) {
    if (!window.confirm(item.kind === "entry"
      ? "归档此流程并停用？历史记录将保留。"
      : "归档此流程？已开始的运行不会受影响。")) return;
    setBusy(true);
    setFailure("");
    try {
      if (item.kind === "entry") {
        await client.archiveEntryRouteFlow(item.flow.id);
        await entries.refetch();
      } else {
        await client.archiveAgentFlow(item.flow.id);
        await agents.refetch();
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="af-page af-management">
      <header className="af-list-header">
        <div className="af-title"><GitBranch size={19} /><h1>Agent 流程</h1></div>
        <button className="af-icon" title="刷新" aria-label="刷新" disabled={!isAdmin || busy || agents.isFetching || entries.isFetching} onClick={() => {
          void agents.refetch();
          void entries.refetch();
        }}><RefreshCw size={16} /></button>
      </header>
      <div className="af-create">
        <select className="af-input" aria-label="流程类型" value={kind} onChange={(e) => changeKind(e.target.value as FlowKind)} disabled={busy || !isAdmin}>
          <option value="agent">Agent 流程</option>
          <option value="entry">一级路由流程</option>
        </select>
        <input aria-label="新流程名称" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} disabled={busy || !isAdmin} />
        {kind === "entry" && <select className="af-input" aria-label="初始模板" value={template} onChange={(e) => setTemplate(e.target.value as typeof template)} disabled={busy || !isAdmin}>
          <option value="default">问候与业务分流</option>
          <option value="empty">空流程</option>
        </select>}
        <button className="af-button af-primary" disabled={busy || !isAdmin || !name.trim()} onClick={create}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}{kind === "entry" ? "新建一级流程" : "新建诊断流程"}
        </button>
      </div>
      {user.error && <div className="af-error" role="alert">{user.error.message}</div>}
      {!user.isLoading && !user.error && !isAdmin && <div className="af-error" role="alert">仅管理员可以管理 Agent 流程</div>}
      {failure && <div className="af-error" role="alert">{failure}</div>}
      {isAdmin && agents.error && <div className="af-error" role="alert">Agent 流程：{agents.error.message}</div>}
      {isAdmin && entries.error && <div className="af-error" role="alert">一级路由流程：{entries.error.message}</div>}
      {(user.isLoading || (isAdmin && (agents.isLoading || entries.isLoading))) && <div className="af-empty"><Loader2 className="animate-spin" size={20} /></div>}
      {isAdmin && agents.isSuccess && entries.isSuccess && items.length === 0 && <div className="af-empty"><GitBranch size={28} /><span>暂无流程</span></div>}
      {isAdmin && !!items.length && (
        <div className="af-table">
          <div className="af-table-row af-table-head"><span>流程</span><span>发布版本</span><span>状态</span><span>更新时间</span><span /></div>
          {items.map((item) => {
            const { flow, kind: flowKind } = item;
            const href = `/admin/cs/${flowKind === "entry" ? "entry-route-flows" : "agent-flows"}/${flow.id}`;
            const Icon = flowKind === "entry" ? Route : GitBranch;
            return <div className="af-table-row" key={`${flowKind}:${flow.id}`}>
              <div className="af-flow-entry">
                <Link className="af-flow-name" to={href}><Icon size={16} />{flow.name}</Link>
                <span className="af-flow-kind">{flowKind === "entry" ? "一级路由流程" : "Agent 流程"}</span>
              </div>
              <div className="af-flow-state">
                <span>{flow.publishedVersion ? `v${flow.publishedVersion}` : "未发布"}</span>
                <span><i className={`af-dot ${flow.enabled ? "af-dot-on" : ""}`} />{flow.enabled ? "已启用" : "未启用"}</span>
              </div>
              <time>{new Date(flow.updatedAt).toLocaleString()}</time>
              <div className="af-actions">
                <button className="af-icon" title="归档" aria-label={`归档 ${flow.name}`} disabled={busy} onClick={() => archive(item)}><Archive size={15} /></button>
                <Link className="af-icon" title="编辑" aria-label={`编辑 ${flow.name}`} to={href}><ArrowRight size={16} /></Link>
              </div>
            </div>;
          })}
        </div>
      )}
    </div>
  );
}
