import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";

dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

const email = process.env.ADMIN_EMAIL || "admin@agentforge.local";
const password = process.env.ADMIN_PASSWORD || randomBytes(18).toString("base64url");
const db = new PrismaClient();

try {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) {
    throw new Error("ADMIN_EMAIL must be a valid email address");
  }
  if (password.length < 12 || Buffer.byteLength(password, "utf8") > 72) {
    throw new Error("ADMIN_PASSWORD must be at least 12 characters and at most 72 UTF-8 bytes");
  }
  const existing = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    throw new Error("Account already exists; no role or password was changed");
  }
  const user = await db.user.create({
    data: {
      id: randomUUID(), email, role: "admin", passwordHash: await bcrypt.hash(password, 12),
    },
    select: { email: true, role: true },
  });
  console.log(JSON.stringify({ ...user, password }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
