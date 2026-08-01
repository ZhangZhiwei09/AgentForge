const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

prisma.user.findMany()
  .then(users => {
    console.log(JSON.stringify(users.map(u => ({id: u.id, email: u.email, role: u.role})), null, 2));
  })
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
