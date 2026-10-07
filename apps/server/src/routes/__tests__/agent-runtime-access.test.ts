import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRuntimeRoutes } from "../agent-runtime.js";

const { validateToken, conversation, messages, streamChat } = vi.hoisted(() => ({
  validateToken: vi.fn(),
  conversation: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  messages: vi.fn(),
  streamChat: vi.fn(),
}));
vi.mock("../../services/auth.js", () => ({ authService: { validateToken } }));
vi.mock("../../db.js", () => ({ prisma: { conversation, message: { findMany: messages } } }));
vi.mock("../../services/agent-runtime.js", () => ({
  getAgentRuntimeService: () => ({ streamChat }),
}));

describe("chat access for configured diagnosis conversations", () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it("rejects invalid supplied tokens before running chat", async () => {
    validateToken.mockResolvedValue(null);
    const response = await agentRuntimeRoutes.request("/api/agent/chat", {
      method: "POST", headers: { Authorization: "Bearer forged", "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(response.status).toBe(401);
    expect(streamChat).not.toHaveBeenCalled();
  });

  it("does not decode invalid tokens when listing conversations", async () => {
    validateToken.mockResolvedValue(null);
    const response = await agentRuntimeRoutes.request("/api/agent/chat/conversations", {
      headers: { Authorization: "Bearer forged" },
    });
    expect(response.status).toBe(401);
    expect(conversation.findMany).not.toHaveBeenCalled();
  });

  it("blocks history from a different verified owner", async () => {
    validateToken.mockResolvedValue({ id: "user-1" });
    conversation.findUnique.mockResolvedValue({ id: "conversation-2", userId: "user-2" });
    const response = await agentRuntimeRoutes.request("/api/agent/chat/history?conversation_id=conversation-2", {
      headers: { Authorization: "Bearer valid" },
    });
    expect(response.status).toBe(403);
    expect(messages).not.toHaveBeenCalled();
  });

  it("blocks anonymous access to a signed-in owner's history", async () => {
    conversation.findUnique.mockResolvedValue({ id: "conversation-2", userId: "user-2" });
    const response = await agentRuntimeRoutes.request("/api/agent/chat/history?conversation_id=conversation-2");
    expect(response.status).toBe(403);
  });

  it("scopes legacy anonymous session lookup to the system identity", async () => {
    conversation.findFirst.mockResolvedValue(null);
    const response = await agentRuntimeRoutes.request("/api/agent/chat/conversations?session_id=session-1");
    expect(response.status).toBe(200);
    expect(conversation.findFirst.mock.calls[0][0].where).toMatchObject({
      sessionId: "session-1", userId: "00000000-0000-0000-0000-000000000002",
    });
  });
});
