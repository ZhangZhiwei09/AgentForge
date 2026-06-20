// 数据管理仪表盘 —— Tab 布局
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { BarChart3, BookOpen, Brain, Eye } from "lucide-react";

const TABS = [
  { to: "/admin/cs/knowledge", label: "知识库管理", icon: BookOpen },
  { to: "/admin/cs/memory", label: "记忆管理", icon: Brain },
  { to: "/admin/cs/analytics", label: "数据分析", icon: BarChart3 },
  { to: "/admin/cs/observability", label: "LLM 追踪", icon: Eye },
];

export function AdminDashboard() {
  const location = useLocation();

  return (
    <div className="flex flex-col flex-1" style={{ height: "calc(100dvh - 48px)" }}>
      {/* Sub-navigation */}
      <nav className="flex items-center gap-0 border-b border-[hsl(var(--border))] bg-[hsl(var(--background))] px-4">
        {TABS.map((tab) => {
          const isActive = location.pathname === tab.to;
          return (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                isActive
                  ? "border-[hsl(var(--cs-primary))] text-[hsl(var(--cs-primary))]"
                  : "border-transparent text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
              }`}
            >
              <tab.icon className="h-4 w-4" />
              {tab.label}
            </NavLink>
          );
        })}
      </nav>

      {/* Page content via nested routes */}
      <div className="flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}
