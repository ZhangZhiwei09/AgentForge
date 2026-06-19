import { useLocation } from "react-router-dom";

export function AppShell({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const isLoginPage = location.pathname === "/login";

  return (
    <div
      className="flex flex-col overflow-hidden"
      style={{ height: "100dvh", width: "100dvw" }}
    >
      {!isLoginPage && (
        <nav className="flex h-12 items-center border-b border-[hsl(var(--border))] bg-[hsl(var(--background))] px-4 shrink-0">
          <span className="text-sm font-bold tracking-tight text-[hsl(var(--foreground))]">
            AgentForge 应用创作
          </span>
        </nav>
      )}
      {children}
    </div>
  );
}
