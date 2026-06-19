// 共享 API 客户端 — 基于 @agentforge/sdk 的 AgentForgeClient
import { AgentForgeClient } from "@agentforge/sdk";

const getAccessToken = (): string | null => {
  return localStorage.getItem("accessToken");
};

export const client = new AgentForgeClient({
  baseUrl: "",
  getAccessToken,
  onAuthError: () => {
    // 401 时清除 token 并跳转登录页
    localStorage.removeItem("accessToken");
    if (window.location.pathname !== "/login") {
      window.location.href = "/login";
    }
  },
});
