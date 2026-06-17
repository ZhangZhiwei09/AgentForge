import { NavLink, useNavigate } from "react-router-dom";
import {
  MessageCircle,
  LogOut,
  User,
  BarChart3,
  Wand2,
} from "lucide-react";

export function TopNav() {
  const token = localStorage.getItem("accessToken");
  const navigate = useNavigate();

  function handleLogout() {
    localStorage.removeItem("accessToken");
    localStorage.removeItem("refreshToken");
    navigate("/login");
  }

  return (
    <nav className="flex h-12 items-center justify-between border-b border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 sm:px-4 shrink-0">
      {/* 左侧：Logo + Tab */}
      <div className="flex items-center gap-2 sm:gap-6">
        <span className="text-sm font-bold tracking-tight text-[hsl(var(--foreground))] hidden sm:inline">
          AgentForge
        </span>
        <div className="flex items-center gap-0.5 sm:gap-1">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `flex items-center gap-1 sm:gap-1.5 rounded-md px-2 sm:px-3 py-1.5 text-xs sm:text-sm font-medium transition-colors ${
                isActive
                  ? "bg-[hsl(var(--cs-primary))] text-white"
                  : "text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))]"
              }`
            }
          >
            <MessageCircle className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            <span className="hidden sm:inline">智能客服</span>
            <span className="sm:hidden">客服</span>
          </NavLink>
          <NavLink
            to="/projects/new"
            className={({ isActive }) =>
              `flex items-center gap-1 sm:gap-1.5 rounded-md px-2 sm:px-3 py-1.5 text-xs sm:text-sm font-medium transition-colors ${
                isActive
                  ? "bg-[hsl(var(--cs-primary))] text-white"
                  : "text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))]"
              }`
            }
          >
            <Wand2 className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            <span className="hidden sm:inline">应用创作</span>
            <span className="sm:hidden">创作</span>
          </NavLink>
          <NavLink
            to="/admin/cs"
            className={({ isActive }) =>
              `flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                isActive
                  ? "bg-[hsl(var(--cs-primary))] text-white"
                  : "text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))]"
              }`
            }
          >
            <BarChart3 className="h-4 w-4" />
            数据管理
          </NavLink>
        </div>
      </div>

      {/* 右侧：用户状态 */}
      <div className="flex items-center gap-1 sm:gap-3">
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
