import { useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { AuthGuard } from "@agentforge/ui";
import { AppShell } from "./components/layout/AppShell";
import { LoginPage } from "./components/auth/LoginPage";
import { AdminDashboard } from "./components/analytics/AdminDashboard";
import { AnalyticsPage } from "./components/analytics/AnalyticsPage";
import { KnowledgePanel } from "./components/knowledge/KnowledgePanel";
import { MemoryPanel } from "./components/memory/MemoryPanel";
import { ObservabilityPage } from "./components/analytics/ObservabilityPage";
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

function MemoryManagement() {
  return (
    <div className="p-6">
      <MemoryPanel />
    </div>
  );
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
          <Route path="cs/knowledge" element={<KnowledgeManagement />} />
          <Route path="cs/memory" element={<MemoryManagement />} />
          <Route path="cs/analytics" element={<AnalyticsPage />} />
          <Route path="cs/observability" element={<ObservabilityPage />} />
          <Route index element={<Navigate to="cs/analytics" replace />} />
        </Route>
        <Route path="/*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </AppShell>
  );
}
