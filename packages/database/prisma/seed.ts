import { PrismaClient } from "@prisma/client";
import { randomUUID, createHash } from "crypto";

const prisma = new PrismaClient();

const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001";
const CUSTOMER_USER_ID = "00000000-0000-0000-0000-000000000002";
const DEFAULT_PASSWORD = "agentforge";

function hashPassword(password: string): string {
  const salt = randomUUID();
  const hash = createHash("sha256").update(salt + password).digest("hex");
  return `${salt}:${hash}`;
}

async function main() {
  const passwordHash = hashPassword(DEFAULT_PASSWORD);

  // Seed default user
  const defaultUser = await prisma.user.findUnique({
    where: { id: DEFAULT_USER_ID },
  });
  if (!defaultUser) {
    await prisma.user.create({
      data: {
        id: DEFAULT_USER_ID,
        email: "default@agentforge.local",
        passwordHash,
      },
    });
    console.log("Created default user:", DEFAULT_USER_ID);
  } else {
    await prisma.user.update({
      where: { id: DEFAULT_USER_ID },
      data: { passwordHash },
    });
    console.log("Default user already exists, password hash updated");
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
        passwordHash,
      },
    });
    console.log("Created customer user:", CUSTOMER_USER_ID);
  } else {
    await prisma.user.update({
      where: { id: CUSTOMER_USER_ID },
      data: { passwordHash },
    });
    console.log("Customer user already exists, password hash updated");
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
