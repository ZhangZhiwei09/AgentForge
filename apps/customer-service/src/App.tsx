import { Routes, Route, useLocation } from "react-router-dom";
import { TopNav } from "./components/layout/TopNav";
import { LoginPage } from "./components/auth/LoginPage";
import { AgentChatPage } from "./components/agent-chat/AgentChatPage";

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
        <Route path="/*" element={<AgentChatPage />} />
      </Routes>
    </AppShell>
  );
}
