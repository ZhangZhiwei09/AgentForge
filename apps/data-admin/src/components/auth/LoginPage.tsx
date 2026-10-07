import { useState, FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, User } from "lucide-react";
import { client } from "@agentforge/ui";

function loginDestination(adminLogin: boolean, returnTo: string | null) {
  const fallback = adminLogin ? "/admin/cs/agent-flows" : "/";
  if (!returnTo) return fallback;
  try {
    const target = new URL(returnTo, window.location.origin);
    if (target.origin === window.location.origin &&
        (target.pathname === "/admin" || target.pathname.startsWith("/admin/"))) {
      return target.pathname + target.search + target.hash;
    }
  } catch {
    return fallback;
  }
  return fallback;
}

export function LoginPage() {
  const [params, setParams] = useSearchParams();
  const adminLogin = params.get("mode") === "admin";

  function changeMode(admin: boolean) {
    const next = new URLSearchParams(params);
    if (admin) next.set("mode", "admin");
    else next.delete("mode");
    setParams(next, { replace: true });
  }

  return (
    <LoginForm
      key={adminLogin ? "admin" : "user"}
      adminLogin={adminLogin}
      returnTo={params.get("returnTo")}
      onModeChange={changeMode}
    />
  );
}

function LoginForm({ adminLogin, returnTo, onModeChange }: {
  adminLogin: boolean;
  returnTo: string | null;
  onModeChange: (admin: boolean) => void;
}) {
  const navigate = useNavigate();
  const queries = useQueryClient();
  const [email, setEmail] = useState(adminLogin ? "admin@agentforge.local" : "default@agentforge.local");
  const [password, setPassword] = useState(adminLogin
    ? (import.meta.env.DEV ? import.meta.env.VITE_DEV_ADMIN_PASSWORD || "" : "")
    : "agentforge");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const result = await client.signIn(email, password);
      if (adminLogin && result.user.role !== "admin") {
        setError("该账号不是管理员，请使用独立管理员账号登录。");
        return;
      }
      await queries.cancelQueries();
      queries.clear();
      localStorage.setItem("accessToken", result.accessToken);
      localStorage.setItem("refreshToken", result.refreshToken);
      navigate(loginDestination(adminLogin, returnTo), { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center overflow-auto px-4 py-6 bg-gray-900">
      <div className="w-full max-w-sm p-6 bg-gray-800 rounded-lg shadow-lg">
        <h1 className="text-xl font-bold text-white mb-6 text-center">
          AgentForge
        </h1>

        <div role="tablist" aria-label="登录身份" className="mb-6 grid grid-cols-2 gap-1 rounded bg-gray-900 p-1">
          {([false, true] as const).map((admin) => {
            const Icon = admin ? ShieldCheck : User;
            return (
              <button
                key={String(admin)}
                type="button"
                role="tab"
                aria-selected={adminLogin === admin}
                aria-controls="login-form"
                id={admin ? "admin-login-tab" : "user-login-tab"}
                disabled={loading}
                onClick={() => onModeChange(admin)}
                className={`flex h-9 items-center justify-center gap-2 rounded text-sm transition-colors disabled:opacity-50 ${adminLogin === admin ? "bg-gray-700 text-white" : "text-gray-400 hover:text-white"}`}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {admin ? "管理员" : "普通用户"}
              </button>
            );
          })}
        </div>

        {error && (
          <div role="alert" className="mb-4 p-2 bg-red-900/50 border border-red-700 rounded text-red-300 text-sm">
            {error}
          </div>
        )}

        <form id="login-form" role="tabpanel" aria-labelledby={adminLogin ? "admin-login-tab" : "user-login-tab"} onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="login-email" className="block text-sm text-gray-400 mb-1">Email</label>
            <input
              id="login-email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
              required
            />
          </div>

          <div>
            <label htmlFor="login-password" className="block text-sm text-gray-400 mb-1">Password</label>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
              required
              minLength={6}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded font-medium text-sm transition-colors"
          >
            {loading ? "Signing in..." : adminLogin ? "管理员登录" : "Sign In"}
          </button>
        </form>

        {!adminLogin && (
          <>
            <p className="mt-4 text-xs text-gray-500 text-center">
              Default: default@agentforge.local / agentforge
            </p>
            <p className="mt-2 text-xs text-gray-500 text-center">
              默认账号为普通用户，Agent 流程需使用管理员账号登录。
            </p>
          </>
        )}
      </div>
    </div>
  );
}
