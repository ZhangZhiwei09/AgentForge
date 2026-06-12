import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { ChatLayout } from "./components/layout/ChatLayout";
import { TopNav } from "./components/layout/TopNav";
import { LoginPage } from "./components/auth/LoginPage";
import { CustomerChatPage } from "./components/customer-chat/CustomerChatPage";
import { CSAdminPage } from "./components/admin/CSAdminPage";

function AuthGuard({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem("accessToken");
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppShell({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const isLoginPage = location.pathname === "/login";

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden">
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
          path="/assistant/*"
          element={
            <AuthGuard>
              <ChatLayout />
            </AuthGuard>
          }
        />
        <Route path="/admin/cs" element={<CSAdminPage />} />
        <Route path="/*" element={<CustomerChatPage />} />
      </Routes>
    </AppShell>
  );
}
