import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001";
const CUSTOMER_USER_ID = "00000000-0000-0000-0000-000000000002";

async function main() {
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
    console.log("Created default user:", DEFAULT_USER_ID);
  } else {
    console.log("Default user already exists");
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
    console.log("Created customer user:", CUSTOMER_USER_ID);
  } else {
    console.log("Customer user already exists");
  }
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
