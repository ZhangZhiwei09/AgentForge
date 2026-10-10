import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { client } from "@agentforge/ui";
import { Loader2 } from "lucide-react";

export function EntryAdminGate({ children }: { children: ReactNode }) {
  const user = useQuery({ queryKey: ["auth", "me"], queryFn: () => client.getMe(), retry: false });
  if (user.isLoading) return <div className="af-empty"><Loader2 size={20} className="animate-spin" /></div>;
  if (user.error) return <div className="af-error" role="alert">{user.error.message}</div>;
  if (user.data?.role !== "admin") return <div className="af-error" role="alert">仅管理员可以管理一级路由流程</div>;
  return children;
}
