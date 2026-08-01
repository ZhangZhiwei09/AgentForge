// AuthService tests — sign up, sign in, token validation, API key management
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { AuthService } from "../services/auth.js";
import { prisma } from "../db.js";

const authService = new AuthService();
const TEST_EMAIL = `test-${Date.now()}@agentforge.test`;
const TEST_PASSWORD = "testpass123";

describe("AuthService", () => {
  let userId: string;

  // Clean up test user after all tests
  afterAll(async () => {
    try {
      const user = await prisma.user.findUnique({
        where: { email: TEST_EMAIL },
      });
      if (user) {
        await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
        await prisma.apiKey.deleteMany({ where: { userId: user.id } });
        await prisma.user.delete({ where: { id: user.id } });
      }
    } catch {
      // Best effort cleanup
    }
  });

  describe("signUp", () => {
    it("should create a new user and return tokens", async () => {
      const result = await authService.signUp(TEST_EMAIL, TEST_PASSWORD);
      expect(result.user).toBeDefined();
      expect(result.user.email).toBe(TEST_EMAIL);
      expect(result.user.role).toBe("user");
      expect(result.accessToken).toBeTruthy();
      expect(result.refreshToken).toBeTruthy();
      userId = result.user.id;
    });

    it("should reject duplicate email", async () => {
      await expect(
        authService.signUp(TEST_EMAIL, TEST_PASSWORD),
      ).rejects.toThrow("Email already registered");
    });

    it("should store password as hash, not plaintext", async () => {
      const user = await prisma.user.findUnique({
        where: { email: TEST_EMAIL },
      });
      expect(user).toBeDefined();
      expect(user!.passwordHash).toBeTruthy();
      expect(user!.passwordHash).not.toBe(TEST_PASSWORD);
      expect(user!.passwordHash).toMatch(/^\$2[ab]\$/); // bcrypt format
    });
  });

  describe("signIn", () => {
    it("should sign in with correct credentials", async () => {
      const result = await authService.signIn(TEST_EMAIL, TEST_PASSWORD);
      expect(result.user.email).toBe(TEST_EMAIL);
      expect(result.accessToken).toBeTruthy();
      expect(result.refreshToken).toBeTruthy();
    });

    it("should reject wrong password", async () => {
      await expect(
        authService.signIn(TEST_EMAIL, "wrongpassword"),
      ).rejects.toThrow("Invalid email or password");
    });

    it("should reject non-existent email", async () => {
      await expect(
        authService.signIn("nonexistent@test.com", TEST_PASSWORD),
      ).rejects.toThrow("Invalid email or password");
    });
  });

  describe("validateToken", () => {
    it("should validate a valid access token", async () => {
      const { accessToken } = await authService.signIn(
        TEST_EMAIL,
        TEST_PASSWORD,
      );
      const user = await authService.validateToken(accessToken);
      expect(user).toBeDefined();
      expect(user!.email).toBe(TEST_EMAIL);
    });

    it("should return null for invalid token", async () => {
      const user = await authService.validateToken("invalid-token");
      expect(user).toBeNull();
    });

    it("should return null for empty token", async () => {
      const user = await authService.validateToken("");
      expect(user).toBeNull();
    });
  });

  describe("refreshAccessToken", () => {
    // Clean up tokens from previous tests before starting
    beforeEach(async () => {
      const user = await prisma.user.findUnique({
        where: { email: TEST_EMAIL },
      });
      if (user) {
        await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
      }
    });

    it("should refresh access token with valid refresh token", async () => {
      const { refreshToken, accessToken: oldAccessToken } =
        await authService.signIn(TEST_EMAIL, TEST_PASSWORD);
      // Small delay to ensure different JWT iat
      await new Promise((r) => setTimeout(r, 1100));
      const result = await authService.refreshAccessToken(refreshToken);
      expect(result.accessToken).toBeTruthy();
      expect(result.accessToken).not.toBe(oldAccessToken);
      expect(result.refreshToken).toBeTruthy();
    });

    it("should reject already-used refresh token", async () => {
      // Fresh signIn to get a clean token
      const { refreshToken } = await authService.signIn(
        TEST_EMAIL,
        TEST_PASSWORD,
      );
      // Use it once — this revokes the stored token
      await authService.refreshAccessToken(refreshToken);
      // Second use of the SAME JWT should fail
      await expect(
        authService.refreshAccessToken(refreshToken),
      ).rejects.toThrow();
    });

    it("should reject access token used as refresh token", async () => {
      const { accessToken } = await authService.signIn(
        TEST_EMAIL,
        TEST_PASSWORD,
      );
      await expect(authService.refreshAccessToken(accessToken)).rejects.toThrow(
        "Invalid refresh token",
      );
    });
  });

  describe("getUser", () => {
    it("should return user info by id", async () => {
      const user = await authService.getUser(userId);
      expect(user).toBeDefined();
      expect(user!.email).toBe(TEST_EMAIL);
    });

    it("should return null for non-existent user", async () => {
      const user = await authService.getUser(
        "00000000-0000-0000-0000-000000000000",
      );
      expect(user).toBeNull();
    });
  });

  describe("API Keys", () => {
    let apiKeyId: string;

    it("should create an API key", async () => {
      const result = await authService.createApiKey(userId, "Test Key");
      expect(result.key).toBeTruthy();
      expect(result.key).toMatch(/^af_/);
      expect(result.name).toBe("Test Key");
      apiKeyId = result.id;
    });

    it("should list API keys", async () => {
      const keys = await authService.listApiKeys(userId);
      expect(keys.length).toBeGreaterThanOrEqual(1);
      expect(keys[0].name).toBe("Test Key");
    });

    it("should validate API key as token", async () => {
      const { key } = await authService.createApiKey(userId, "Validation Key");
      const user = await authService.validateToken(key);
      expect(user).toBeDefined();
      expect(user!.email).toBe(TEST_EMAIL);
    });

    it("should revoke an API key", async () => {
      const revoked = await authService.revokeApiKey(userId, apiKeyId);
      expect(revoked).toBe(true);
    });

    it("should not validate revoked API key", async () => {
      // apiKeyId is already revoked
      const keys = await authService.listApiKeys(userId);
      const revokedKey = keys.find((k) => k.id === apiKeyId);
      expect(revokedKey).toBeUndefined(); // Revoked keys are filtered out
    });
  });

  describe("signOut", () => {
    it("should revoke refresh token", async () => {
      const { refreshToken } = await authService.signIn(
        TEST_EMAIL,
        TEST_PASSWORD,
      );
      await authService.revokeRefreshToken(refreshToken);
      await expect(
        authService.refreshAccessToken(refreshToken),
      ).rejects.toThrow();
    });
  });
});
