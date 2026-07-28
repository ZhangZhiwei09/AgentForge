import { Routes, Route, useLocation, Navigate } from "react-router-dom";
import { TopNav } from "./components/layout/TopNav";
import { LoginPage } from "./components/auth/LoginPage";
import { AgentChatPage } from "./components/agent-chat/AgentChatPage";

/** 认证守卫：未登录时重定向到 /login。 */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const token = localStorage.getItem("accessToken");
  if (!token) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
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
          path="/*"
          element={
            <RequireAuth>
              <AgentChatPage />
            </RequireAuth>
          }
        />
      </Routes>
    </AppShell>
  );
}
