const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function check() {
  const users = await prisma.user.findMany({ select: { id: true, email: true } });
  for (const u of users) {
    const convCount = await prisma.conversation.count({ where: { userId: u.id } });
    const memCount = await prisma.memory.count({ where: { userId: u.id } });
    console.log(u.email, u.id, "conversations:", convCount, "memories:", memCount);
  }
}

check()
  .catch(e => console.error("Error:", e.message))
  .finally(() => prisma.$disconnect());
