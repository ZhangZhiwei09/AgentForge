import { useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, ShieldCheck, User } from "lucide-react";
import { client } from "@agentforge/ui";

export function AppShell({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const queries = useQueryClient();
  const isLoginPage = location.pathname === "/login";
  const hasToken = !!localStorage.getItem("accessToken");
  const { data: user } = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => client.getMe(),
    enabled: !isLoginPage && hasToken,
    retry: false,
  });

  function leaveSession(destination = "/login") {
    localStorage.removeItem("accessToken");
    localStorage.removeItem("refreshToken");
    void queries.cancelQueries();
    queries.clear();
    navigate(destination, { replace: true });
  }

  function switchToAdmin() {
    const returnTo = location.pathname + location.search + location.hash;
    const params = new URLSearchParams({ mode: "admin", returnTo });
    leaveSession(`/login?${params}`);
  }

  return (
    <div
      className="flex flex-col overflow-hidden"
      style={{ height: "100dvh", width: "100dvw" }}
    >
      {!isLoginPage && (
        <nav aria-label="账号导航" className="flex h-12 items-center justify-between gap-3 border-b border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 sm:px-4 shrink-0">
          <span className="shrink-0 text-sm font-bold text-[hsl(var(--foreground))]">
            AgentForge<span className="hidden sm:inline"> 数据管理</span>
          </span>
          {hasToken && (
            <div className="flex min-w-0 items-center gap-2 sm:gap-3">
              {user && (
                <div className="flex min-w-0 items-center gap-1.5 text-xs text-[hsl(var(--muted-foreground))]">
                  <User className="hidden h-3.5 w-3.5 shrink-0 sm:block" aria-hidden="true" />
                  <span className="hidden max-w-64 truncate sm:block" title={user.email}>{user.email}</span>
                  <span className="shrink-0">{user.role === "admin" ? "管理员" : user.role === "user" ? "普通用户" : user.role}</span>
                </div>
              )}
              {user?.role !== "admin" && (
                <button
                  type="button"
                  onClick={switchToAdmin}
                  className="flex h-9 shrink-0 items-center gap-1.5 rounded px-2 text-xs text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))] focus-visible:outline focus-visible:outline-2"
                  aria-label="切换至管理员登录"
                  title="切换至管理员登录"
                >
                  <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                  <span className="hidden sm:inline">管理员登录</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => leaveSession()}
                className="flex h-9 shrink-0 items-center gap-1.5 rounded px-2 text-xs text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))] focus-visible:outline focus-visible:outline-2"
                aria-label="退出登录"
                title="退出登录"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                <span>退出登录</span>
              </button>
            </div>
          )}
        </nav>
      )}
      {children}
    </div>
  );
}
