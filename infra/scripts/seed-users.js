// Seed system users required for AgentForge to function
// Run: docker exec -i docker-server-1 node < infra/scripts/seed-users.js
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function seed() {
  const users = [
    {
      id: "00000000-0000-0000-0000-000000000001",
      email: "default@agentforge.local",
    },
    {
      id: "00000000-0000-0000-0000-000000000002",
      email: "customer@agentforge.local",
    },
  ];

  for (const u of users) {
    const existing = await prisma.user.findUnique({ where: { id: u.id } });
    if (!existing) {
      await prisma.user.create({
        data: {
          id: u.id,
          email: u.email,
          passwordHash: "$2a$12$seeded-via-script-placeholder",
        },
      });
      console.log("Created user:", u.email, u.id);
    } else {
      console.log("User already exists:", u.email, u.id);
    }
  }
  console.log("Seed complete.");
}

seed()
  .catch((e) => console.error("Seed error:", e))
  .finally(() => prisma.$disconnect());
