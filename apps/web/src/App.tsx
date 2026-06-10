import { Routes, Route, Navigate } from "react-router-dom";
import { ChatLayout } from "./components/layout/ChatLayout";
import { LoginPage } from "./components/auth/LoginPage";

function AuthGuard({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem("accessToken");
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
    return (
        <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/*"
              element={
                <AuthGuard>
                  <ChatLayout />
                </AuthGuard>
              }
            />
        </Routes>
    );
}
