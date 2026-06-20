const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function fix() {
  // Map existing users to their expected hardcoded IDs
  const existing = await prisma.user.findMany({
    where: {
      email: {
        in: ["default@agentforge.local", "customer@agentforge.local"],
      },
    },
    select: { id: true, email: true },
  });

  const emailToId = {
    "default@agentforge.local": "00000000-0000-0000-0000-000000000001",
    "customer@agentforge.local": "00000000-0000-0000-0000-000000000002",
  };

  for (const user of existing) {
    const targetId = emailToId[user.email];
    if (!targetId || user.id === targetId) {
      console.log("Skip:", user.email, user.id);
      continue;
    }

    // Since FK has ON UPDATE NO ACTION, update directly
    await prisma.user.update({
      where: { id: user.id },
      data: { id: targetId },
    });
    console.log("Updated:", user.email, user.id, "->", targetId);
  }

  console.log("Done.");
}

fix()
  .catch((e) => console.error("Error:", e.message))
  .finally(() => prisma.$disconnect());
