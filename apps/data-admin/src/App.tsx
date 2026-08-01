import { Routes, Route, Navigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AuthGuard, client } from "@agentforge/ui";
import { AppShell } from "./components/layout/AppShell";
import { LoginPage } from "./components/auth/LoginPage";
import { AdminDashboard } from "./components/analytics/AdminDashboard";
import { AnalyticsPage } from "./components/analytics/AnalyticsPage";
import { KnowledgeBaseList } from "./components/knowledge/KnowledgeBaseList";
import { DocumentListPage } from "./components/knowledge/DocumentListPage";
import { DocumentDetailPage } from "./components/knowledge/DocumentDetailPage";
import { ObservabilityPage } from "./components/analytics/ObservabilityPage";
import { HitTestingPage } from "./components/knowledge/HitTestingPage";
import { Loader2 } from "lucide-react";

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
