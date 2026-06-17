import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { TopNav } from "./components/layout/TopNav";
import { LoginPage } from "./components/auth/LoginPage";
import { AgentChatPage } from "./components/agent-chat/AgentChatPage";
import { AppGenLayout } from "./components/app-gen/AppGenLayout";
import { NewProjectPage } from "./components/app-gen/NewProjectPage";

function AuthGuard({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem("accessToken");
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppShell({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const isLoginPage = location.pathname === "/login";

  return (
    <div
      className="flex flex-col overflow-hidden"
      style={{ height: "100dvh", width: "100dvw" }}
    >
      {!isLoginPage && <TopNav />}
      {children}
    </div>
  );
}

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/projects/new"
          element={
            <AuthGuard>
              <NewProjectPage />
            </AuthGuard>
          }
        />
        <Route
          path="/projects/:id"
          element={
            <AuthGuard>
              <AppGenLayout />
            </AuthGuard>
          }
        />
        <Route
          path="/projects"
          element={
            <AuthGuard>
              <AppGenLayout />
            </AuthGuard>
          }
        />
        <Route path="/*" element={<AgentChatPage />} />
      </Routes>
    </AppShell>
  );
}
