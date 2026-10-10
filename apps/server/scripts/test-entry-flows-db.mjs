import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(resolve(root, "apps/server/package.json"));
const databaseRequire = createRequire(resolve(root, "packages/database/package.json"));
const { PrismaClient } = require("@prisma/client");
const { parse } = require("dotenv");
let configured = {};
try { configured = parse(readFileSync(resolve(root, "apps/server/.env"))); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const adminUrl = process.env.DATABASE_URL || configured.DATABASE_URL;
if (!adminUrl) throw new Error("DATABASE_URL is required");
const name = `agentforge_entry_test_${randomUUID().replaceAll("-", "")}`;
if (!/^agentforge_entry_test_[a-f0-9]{32}$/.test(name)) throw new Error("Invalid isolated database name");
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${name}`;
const db = new PrismaClient({ datasourceUrl: adminUrl });
let created = false;
async function run(command, args, env = process.env) {
  const child = spawn(command, args, { cwd: resolve(root, "apps/server"), env, stdio: "inherit" });
  const code = await new Promise((done, fail) => { child.once("error", fail); child.once("exit", done); });
  if (code !== 0) throw new Error(`Test command exited with ${code}`);
}
try {
  await db.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  created = true;
  const env = { ...process.env, DATABASE_URL: testUrl.toString(), ENTRY_FLOW_TEST_DATABASE_URL: testUrl.toString() };
  await run(process.execPath, [
    databaseRequire.resolve("prisma/build/index.js"), "db", "execute",
    "--file", resolve(root, "packages/database/prisma/migrations/20261010120000_add_entry_route_flows/migration.sql"),
    "--schema", resolve(root, "packages/database/prisma/schema.prisma"),
  ], env);
  await run(process.execPath, [
    resolve(dirname(require.resolve("vitest/package.json")), "vitest.mjs"), "run",
    "src/services/entry-route-flows/__tests__/database.integration.test.ts",
  ], env);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Isolated database tests failed");
  process.exitCode = 1;
} finally {
  // Only remove the scratch database created by this invocation.
  if (created) await db.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  await db.$disconnect();
}
