import { AgentForgeClient } from "@agentforge/sdk";

const getAccessToken = (): string | null => {
  return localStorage.getItem("accessToken");
};

export const client = new AgentForgeClient({
  baseUrl: "",
  getAccessToken,
  onAuthError: () => {
    // Clear token on 401 and reload — prompts user to log in
    localStorage.removeItem("accessToken");
    if (window.location.pathname !== "/login") {
      window.location.href = "/login";
    }
  },
});
