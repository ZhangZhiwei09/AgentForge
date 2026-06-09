// Test setup — runs before each test file
import { beforeAll } from "vitest";

// Set env vars for testing
process.env.JWT_SECRET = "test-secret";
process.env.LOG_LEVEL = "silent";  // Suppress logs during tests
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5434/agentforge_test";
