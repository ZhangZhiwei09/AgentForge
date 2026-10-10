import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Archive, ArrowRight, Loader2, Plus, RefreshCw, Route } from "lucide-react";
import { client } from "@agentforge/ui";
import "../agent-flows/agent-flows.css";
import "./entry-route-flows.css";

export function EntryRouteFlowList() {
  const navigate = useNavigate();
  const flows = useQuery({ queryKey: ["entry-route-flows"], queryFn: () => client.listEntryRouteFlows() });
  const [name, setName] = useState("一级路由流程");
  const [template, setTemplate] = useState<"default" | "empty">("default");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function create() {
    setBusy(true); setError("");
    try {
      const flow = await client.createEntryRouteFlow(name.trim(), template);
      navigate(`/admin/cs/entry-route-flows/${flow.id}`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function archive(id: string) {
    if (!window.confirm("归档此流程并停用？历史记录将保留。")) return;
    setBusy(true); setError("");
    try { await client.archiveEntryRouteFlow(id); await flows.refetch(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <div className="af-page er-list">
    <header className="af-list-header">
      <div className="af-title"><Route size={19} /><h1>一级路由流程</h1></div>
      <button className="af-icon" title="刷新" aria-label="刷新" onClick={() => flows.refetch()}><RefreshCw size={16} /></button>
    </header>
    <div className="af-create er-create">
      <input aria-label="新流程名称" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} disabled={busy} />
      <select className="af-input" aria-label="初始模板" value={template} onChange={(e) => setTemplate(e.target.value as typeof template)} disabled={busy}>
        <option value="default">问候与业务分流</option><option value="empty">空流程</option>
      </select>
      <button className="af-button af-primary" disabled={busy || !name.trim()} onClick={create}>
        {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}新建一级流程
      </button>
    </div>
    {(error || flows.error) && <div className="af-error" role="alert">{error || flows.error?.message}</div>}
    {flows.isLoading && <div className="af-empty"><Loader2 size={20} className="animate-spin" /></div>}
    {flows.data?.items.length === 0 && <div className="af-empty"><Route size={26} /><span>暂无一级流程</span></div>}
    {!!flows.data?.items.length && <div className="af-table">
      <div className="af-table-row af-table-head"><span>流程</span><span>发布版本</span><span>状态</span><span>更新时间</span><span /></div>
      {flows.data.items.map((flow) => <div className="af-table-row" key={flow.id}>
        <Link className="af-flow-name" to={`/admin/cs/entry-route-flows/${flow.id}`}><Route size={16} />{flow.name}</Link>
        <span>{flow.publishedVersion ? `v${flow.publishedVersion}` : "未发布"}</span>
        <span><i className={`af-dot ${flow.enabled ? "af-dot-on" : ""}`} />{flow.enabled ? "已启用" : "未启用"}</span>
        <time>{new Date(flow.updatedAt).toLocaleString()}</time>
        <div className="af-actions">
          <button className="af-icon" title="归档" aria-label={`归档 ${flow.name}`} disabled={busy} onClick={() => archive(flow.id)}><Archive size={15} /></button>
          <Link className="af-icon" title="编辑" aria-label={`编辑 ${flow.name}`} to={`/admin/cs/entry-route-flows/${flow.id}`}><ArrowRight size={16} /></Link>
        </div>
      </div>)}
    </div>}
  </div>;
}
