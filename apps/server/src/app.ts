import { Hono } from "hono";
import { corsMiddleware } from "./middleware/cors.js";
import { errorHandler } from "./middleware/error.js";
import { chatRoutes } from "./routes/chat.js";
import { conversationRoutes } from "./routes/conversations.js";
import { providerRoutes } from "./routes/providers.js";
import { memoryRoutes } from "./routes/memories.js";
import { customerChatRoutes } from "./routes/customer-chat.js";
import { knowledgeRoutes } from "./routes/knowledge.js";

export function createApp() {
  const app = new Hono();

  // Global middleware
  app.use("*", corsMiddleware);
  app.onError(errorHandler);

  // Health check
  app.get("/api/health", (c) => c.json({ status: "ok" }));

  // API routes
  app.route("/", chatRoutes);
  app.route("/", conversationRoutes);
  app.route("/", providerRoutes);
  app.route("/", memoryRoutes);
  app.route("/", customerChatRoutes);
  app.route("/", knowledgeRoutes);

  return app;
}
