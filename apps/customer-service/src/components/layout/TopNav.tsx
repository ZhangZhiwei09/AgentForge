import { useNavigate } from "react-router-dom";
import { LogOut, User } from "lucide-react";

export function TopNav() {
  const token = localStorage.getItem("accessToken");
  const navigate = useNavigate();

  function handleLogout() {
    localStorage.removeItem("accessToken");
    localStorage.removeItem("refreshToken");
    navigate("/login");
  }

  return (
    <nav className="flex h-12 items-center justify-between border-b border-[hsl(var(--border))] bg-[hsl(var(--background))] px-4 shrink-0">
      {/* 左侧：Logo */}
      <span className="text-sm font-bold tracking-tight text-[hsl(var(--foreground))]">
        AgentForge 智能客服
      </span>

      {/* 右侧：用户状态 */}
      <div className="flex items-center gap-3">
        {token ? (
          <>
            <span className="hidden sm:flex items-center gap-1.5 text-xs text-[hsl(var(--muted-foreground))]">
              <User className="h-3.5 w-3.5" />
              <span>已登录</span>
            </span>
            <button
              onClick={handleLogout}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[hsl(var(--muted-foreground))] transition-colors hover:text-red-500 hover:bg-red-50"
              title="退出登录"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">退出</span>
            </button>
          </>
        ) : (
          <button
            onClick={() => navigate("/login")}
            className="flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium text-[hsl(var(--muted-foreground))] transition-colors hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))]"
          >
            <User className="h-3.5 w-3.5" />
            登录
          </button>
        )}
      </div>
    </nav>
  );
}
