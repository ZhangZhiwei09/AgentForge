import { Routes, Route, Navigate } from "react-router-dom";
import { AuthGuard } from "@agentforge/ui";
import { AppShell } from "./components/layout/AppShell";
import { LoginPage } from "./components/auth/LoginPage";
import { AdminDashboard } from "./components/analytics/AdminDashboard";
import { AnalyticsPage } from "./components/analytics/AnalyticsPage";
import { KnowledgePanel } from "./components/knowledge/KnowledgePanel";
import { MemoryPanel } from "./components/memory/MemoryPanel";

function KnowledgeManagement() {
  return (
    <div className="p-6">
      <KnowledgePanel />
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
          <Route index element={<Navigate to="cs/analytics" replace />} />
        </Route>
        <Route path="/*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </AppShell>
  );
}
