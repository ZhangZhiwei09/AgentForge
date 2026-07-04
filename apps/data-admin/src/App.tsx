import { useState } from "react";
import { Routes, Route, Navigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AuthGuard, client } from "@agentforge/ui";
import { AppShell } from "./components/layout/AppShell";
import { LoginPage } from "./components/auth/LoginPage";
import { AdminDashboard } from "./components/analytics/AdminDashboard";
import { AnalyticsPage } from "./components/analytics/AnalyticsPage";
import { KnowledgePanel } from "./components/knowledge/KnowledgePanel";
import { KnowledgeBaseList } from "./components/knowledge/KnowledgeBaseList";
import { DocumentListPage } from "./components/knowledge/DocumentListPage";
import { DocumentDetailPage } from "./components/knowledge/DocumentDetailPage";
import { ObservabilityPage } from "./components/analytics/ObservabilityPage";
import { HitTestingPage } from "./components/knowledge/HitTestingPage";
import { Loader2 } from "lucide-react";
import { X } from "lucide-react";

interface KnowledgeDocument {
  id: string;
  knowledgeBaseId: string;
  title: string;
  content: string;
  chunkCount: number;
  status: string;
  createdAt: string;
}

function KnowledgeManagement() {
  const [viewingDoc, setViewingDoc] = useState<KnowledgeDocument | null>(null);

  return (
    <div className="flex flex-1 h-full">
      <KnowledgePanel viewingDoc={viewingDoc} onViewDoc={setViewingDoc} />
      {viewingDoc && (
        <div className="flex flex-col flex-1 border-l border-[hsl(var(--border))] bg-[hsl(var(--background))]">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-[hsl(var(--border))]">
            <div>
              <h3 className="text-sm font-semibold">{viewingDoc.title}</h3>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {viewingDoc.chunkCount} chunks · {viewingDoc.content?.length ?? 0} chars ·{" "}
                <span className="rounded px-1 py-0.5 text-[10px] font-medium bg-gray-100 text-gray-500">
                  {viewingDoc.status}
                </span>
              </p>
            </div>
            <button
              onClick={() => setViewingDoc(null)}
              className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--accent))] transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-3">
            {viewingDoc.content ? (
              <pre className="text-xs leading-relaxed text-foreground whitespace-pre-wrap font-sans">
                {viewingDoc.content}
              </pre>
            ) : (
              <p className="text-xs text-muted-foreground text-center py-8">
                No text content — status: {viewingDoc.status}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── 路由级组件：文档列表（从 URL 读取 kbId，获取 kbName） ──

function DocumentListView() {
  const { kbId } = useParams<{ kbId: string }>();

  // 查询知识库名称
  const { data: kb, isLoading } = useQuery({
    queryKey: ["knowledge", "base", kbId],
    queryFn: () => (kbId ? client.getKnowledgeBase(kbId) : Promise.reject()),
    enabled: !!kbId,
  });

  if (!kbId) return <Navigate to="/admin/cs/knowledge" replace />;

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <DocumentListPage kbId={kbId} kbName={kb?.name ?? kbId} />;
}

// ── 路由级组件：命中测试（从 URL 读取 kbId，获取 kbName） ──

function HitTestingView() {
  const { kbId } = useParams<{ kbId: string }>();

  const { data: kb } = useQuery({
    queryKey: ["knowledge", "base", kbId],
    queryFn: () => (kbId ? client.getKnowledgeBase(kbId) : Promise.reject()),
    enabled: !!kbId,
  });

  if (!kbId) return <Navigate to="/admin/cs/knowledge" replace />;
  return <HitTestingPage kbId={kbId} kbName={kb?.name ?? kbId} />;
}

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/admin"
          element={
            <AuthGuard>
              <AdminDashboard />
            </AuthGuard>
          }
        >
          {/* 知识库路由（V2 重构） */}
          <Route path="cs/knowledge" element={<KnowledgeBaseList />} />
          <Route path="cs/knowledge/bases" element={<Navigate to="/admin/cs/knowledge" replace />} />
          {/* 旧版知识库面板路由（过渡期保留） */}
          <Route path="cs/knowledge-legacy" element={<KnowledgeManagement />} />
          <Route
            path="cs/knowledge/bases/:kbId/hit-testing"
            element={<HitTestingView />}
          />
          <Route
            path="cs/knowledge/bases/:kbId/documents/:docId"
            element={<DocumentDetailPage />}
          />
          <Route path="cs/knowledge/bases/:kbId" element={<DocumentListView />} />

          {/* 其他模块 */}
          <Route path="cs/analytics" element={<AnalyticsPage />} />
          <Route path="cs/observability" element={<ObservabilityPage />} />
          <Route index element={<Navigate to="cs/knowledge" replace />} />
        </Route>
        <Route path="/*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </AppShell>
  );
}
