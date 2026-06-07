import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { settings } from "./config.js";
import { prisma } from "./db.js";

const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001";
const CUSTOMER_USER_ID = "00000000-0000-0000-0000-000000000002";

async function seedDefaultUsers() {
  // Seed default user
  const defaultUser = await prisma.user.findUnique({
    where: { id: DEFAULT_USER_ID },
  });
  if (!defaultUser) {
    await prisma.user.create({
      data: {
        id: DEFAULT_USER_ID,
        email: "default@agentforge.local",
      },
    });
    console.log("[seed] Created default user:", DEFAULT_USER_ID);
  }

  // Seed customer user
  const customerUser = await prisma.user.findUnique({
    where: { id: CUSTOMER_USER_ID },
  });
  if (!customerUser) {
    await prisma.user.create({
      data: {
        id: CUSTOMER_USER_ID,
        email: "customer@agentforge.local",
      },
    });
    console.log("[seed] Created customer user:", CUSTOMER_USER_ID);
  }
}

async function main() {
  // Check database connection
  try {
    await prisma.$connect();
    console.log("[db] PostgreSQL connected");
  } catch (err) {
    console.error("[db] Failed to connect to PostgreSQL:", err);
    process.exit(1);
  }

  // Seed default users
  await seedDefaultUsers();

  // Seed knowledge base
  try {
    const { seedKnowledgeBase } = await import("./services/knowledge-ingestion.js");
    await seedKnowledgeBase();
  } catch (err) {
    console.warn("[seed] Knowledge base seeding skipped:", (err as Error).message);
  }

  const app = createApp();

  console.log(`[server] AgentForge TS backend starting on http://localhost:${settings.port}`);
  serve({
    fetch: app.fetch,
    port: settings.port,
  });

  console.log(`[server] Listening on port ${settings.port}`);
}

main().catch((err) => {
  console.error("[server] Fatal error:", err);
  process.exit(1);
});
