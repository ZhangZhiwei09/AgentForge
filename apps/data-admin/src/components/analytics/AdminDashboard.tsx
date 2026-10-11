// 诊断工作台管理入口
import { Link, Outlet, useLocation } from "react-router-dom";
import { BookOpen, ExternalLink, GitBranch } from "lucide-react";

const TABS = [
  { to: "/admin/cs/knowledge", label: "知识库管理", icon: BookOpen },
  { to: "/admin/cs/agent-flows", label: "Agent 流程", icon: GitBranch },
];

export function AdminDashboard() {
  const location = useLocation();

  return (
    <div className="flex flex-col flex-1" style={{ height: "calc(100dvh - 48px)" }}>
      {/* Sub-navigation */}
      <nav aria-label="管理模块" className="flex shrink-0 items-center gap-0 overflow-x-auto border-b border-[hsl(var(--border))] bg-[hsl(var(--background))] px-4">
        {TABS.map((tab) => {
          const isActive =
            location.pathname === tab.to ||
            location.pathname.startsWith(`${tab.to}/`) ||
            (tab.to === "/admin/cs/agent-flows" && location.pathname.startsWith("/admin/cs/entry-route-flows/"));
          return (
            <Link
              key={tab.to}
              to={tab.to}
              aria-current={isActive ? "page" : undefined}
              className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                isActive
                  ? "border-[hsl(var(--cs-primary))] text-[hsl(var(--cs-primary))]"
                  : "border-transparent text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
              }`}
            >
              <tab.icon className="h-4 w-4" />
              {tab.label}
            </Link>
          );
        })}
        <a
          href={import.meta.env.VITE_LANGFUSE_URL || "http://localhost:3000"}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="打开 Langfuse 追踪"
          title="打开 Langfuse 追踪"
          className="ml-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2"
        >
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
        </a>
      </nav>

      {/* Page content via nested routes */}
      <div className="flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}
