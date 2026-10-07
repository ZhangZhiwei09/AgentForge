import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Plus, RefreshCw, ArrowRight, Loader2, Archive } from "lucide-react";
import { client } from "@agentforge/ui";
import "./agent-flows.css";

export function AgentFlowList() {
  const navigate = useNavigate();
  const queries = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["agent-flows"], queryFn: () => client.listAgentFlows(),
  });
  const [name, setName] = useState("核身诊断流程");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  async function create() {
    setBusy(true);
    setFailure("");
    try {
      const flow = await client.createAgentFlow(name.trim());
      await queries.invalidateQueries({ queryKey: ["agent-flows"] });
      navigate(`/admin/cs/agent-flows/${flow.id}`);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  async function archive(id: string) {
    if (!window.confirm("归档此流程？已开始的运行不会受影响。")) return;
    try {
      await client.archiveAgentFlow(id);
      await refetch();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
  }
  return (
    <div className="af-page">
      <header className="af-list-header">
        <div className="af-title"><GitBranch size={19} /><h1>Agent 流程</h1></div>
        <button className="af-icon" title="刷新" aria-label="刷新" onClick={() => refetch()}><RefreshCw size={16} /></button>
      </header>
      <div className="af-create">
        <input aria-label="新流程名称" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        <button className="af-button af-primary" disabled={busy || !name.trim()} onClick={create}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}新建诊断流程
        </button>
      </div>
      {(error || failure) && <div className="af-error" role="alert">{failure || error?.message}</div>}
      {isLoading && <div className="af-empty"><Loader2 className="animate-spin" size={20} /></div>}
      {data?.items.length === 0 && <div className="af-empty"><GitBranch size={28} /><span>暂无流程</span></div>}
      {!!data?.items.length && (
        <div className="af-table">
          <div className="af-table-row af-table-head"><span>流程</span><span>发布版本</span><span>状态</span><span>更新时间</span><span /></div>
          {data.items.map((flow) => (
            <div className="af-table-row" key={flow.id}>
              <Link className="af-flow-name" to={`/admin/cs/agent-flows/${flow.id}`}><GitBranch size={16} />{flow.name}</Link>
              <span>{flow.publishedVersion ? `v${flow.publishedVersion}` : "未发布"}</span>
              <span><i className={`af-dot ${flow.enabled ? "af-dot-on" : ""}`} />{flow.enabled ? "已启用" : "未启用"}</span>
              <time>{new Date(flow.updatedAt).toLocaleString()}</time>
              <div className="af-actions">
                <button className="af-icon" title="归档" aria-label={`归档 ${flow.name}`} onClick={() => archive(flow.id)}><Archive size={15} /></button>
                <Link className="af-icon" title="编辑" aria-label={`编辑 ${flow.name}`} to={`/admin/cs/agent-flows/${flow.id}`}><ArrowRight size={16} /></Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
