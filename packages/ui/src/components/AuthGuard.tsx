// 认证守卫 — 三个应用通用
import { Navigate } from "react-router-dom";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem("accessToken");
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
