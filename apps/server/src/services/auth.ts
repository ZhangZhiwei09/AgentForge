// AuthService — JWT-based authentication with refresh tokens and API key support
import { randomUUID, createHash, createHmac, timingSafeEqual } from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../db.js";
import { logger } from "@agentforge/logger";
import type {
  AuthUser,
  AuthResponse,
  ApiKeyDTO,
  CreateApiKeyResponse,
} from "@agentforge/shared-types";

// ---- JWT Implementation (using Web Crypto, no external JWT library) ----

const JWT_SECRET =
  process.env.JWT_SECRET || "agentforge-dev-secret-change-in-production";
const ACCESS_TOKEN_EXPIRY = 15 * 60; // 15 minutes
const REFRESH_TOKEN_EXPIRY = 7 * 24 * 3600; // 7 days

// Base64url encode/decode
function base64urlEncode(data: string): string {
  return Buffer.from(data).toString("base64url");
}
function base64urlDecode(data: string): string {
  return Buffer.from(data, "base64url").toString();
}

// HMAC-SHA256 signing
function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

interface JwtPayload {
  sub: string; // user id
  email: string;
  role: string;
  jti: string; // unique token ID to prevent identical tokens
  iat: number;
  exp: number;
  type: "access" | "refresh";
}

function createToken(
  payload: Omit<JwtPayload, "iat" | "exp" | "jti">,
  expiresIn: number,
): string {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payload,
    jti: randomUUID(),
    iat: now,
    exp: now + expiresIn,
  };
  const header = base64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64urlEncode(JSON.stringify(fullPayload));
  const signature = sign(`${header}.${body}`, JWT_SECRET);
  return `${header}.${body}.${signature}`;
}

function verifyToken(token: string): JwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const expectedSig = sign(`${header}.${body}`, JWT_SECRET);
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig)))
      return null;

    const payload = JSON.parse(base64urlDecode(body)) as JwtPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---- Password Hashing (bcrypt, with transparent migration from legacy SHA-256) ----

const BCRYPT_ROUNDS = 12;

function hashPassword(password: string): string {
  return bcrypt.hashSync(password, BCRYPT_ROUNDS);
}

/**
 * Verify a password against a stored hash.
 * Supports bcrypt ($2a$/$2b$ prefix) and legacy SHA-256 (salt:hash format).
 * @returns { valid, needsUpgrade } — needsUpgrade is true if the hash uses the old format
 */
function verifyPassword(
  password: string,
  storedHash: string,
): { valid: boolean; needsUpgrade: boolean } {
  // bcrypt format: starts with $2a$ or $2b$
  if (storedHash.startsWith("$2")) {
    return {
      valid: bcrypt.compareSync(password, storedHash),
      needsUpgrade: false,
    };
  }

  // Legacy SHA-256 format: salt:hash
  const parts = storedHash.split(":");
  if (parts.length === 2) {
    const [salt, hash] = parts;
    const computed = createHash("sha256")
      .update(salt + password)
      .digest("hex");
    try {
      const valid = timingSafeEqual(Buffer.from(computed), Buffer.from(hash));
      return { valid, needsUpgrade: valid }; // Upgrade on successful legacy verification
    } catch {
      return { valid: false, needsUpgrade: false };
    }
  }

  return { valid: false, needsUpgrade: false };
}

/**
 * Check if a hash needs migration (legacy format or low bcrypt rounds)
 */
function needsRehash(storedHash: string): boolean {
  return !storedHash.startsWith("$2");
}

// Hash a token/API key for storage (one-way)
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ---- AuthService ----

export class AuthService {
  // Register a new user
  async signUp(email: string, password: string): Promise<AuthResponse> {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new Error("Email already registered");
    }

    const userId = randomUUID();
    const passwordHash = hashPassword(password);

    const user = await prisma.user.create({
      data: {
        id: userId,
        email,
        passwordHash,
        role: "user",
      },
    });

    logger.info({ userId, email }, "User registered");

    const authUser: AuthUser = {
      id: user.id,
      email: user.email,
      role: user.role,
    };
    const accessToken = createToken(
      { sub: user.id, email: user.email, role: user.role, type: "access" },
      ACCESS_TOKEN_EXPIRY,
    );
    const refreshToken = await this.createRefreshToken(user.id);

    return { user: authUser, accessToken, refreshToken };
  }

  // Sign in with email + password
  async signIn(email: string, password: string): Promise<AuthResponse> {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash) {
      throw new Error("Invalid email or password");
    }

    const { valid, needsUpgrade } = verifyPassword(password, user.passwordHash);
    if (!valid) {
      throw new Error("Invalid email or password");
    }

    // Transparently upgrade legacy SHA-256 hash to bcrypt
    if (needsUpgrade) {
      const newHash = hashPassword(password);
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: newHash },
      });
      logger.info({ userId: user.id }, "Password hash upgraded to bcrypt");
    }

    logger.info({ userId: user.id }, "User signed in");

    const authUser: AuthUser = {
      id: user.id,
      email: user.email,
      role: user.role,
    };
    const accessToken = createToken(
      { sub: user.id, email: user.email, role: user.role, type: "access" },
      ACCESS_TOKEN_EXPIRY,
    );
    const refreshToken = await this.createRefreshToken(user.id);

    return { user: authUser, accessToken, refreshToken };
  }

  // Refresh access token using a refresh token
  async refreshAccessToken(token: string): Promise<AuthResponse> {
    // Try to decode as JWT first (refresh tokens are JWTs)
    const payload = verifyToken(token);
    if (!payload || payload.type !== "refresh") {
      throw new Error("Invalid refresh token");
    }

    // Check token hasn't been revoked
    const tokenHash = hashToken(token);
    const stored = await prisma.refreshToken.findFirst({
      where: { tokenHash, revoked: false },
    });
    if (!stored) {
      throw new Error("Refresh token revoked or expired");
    }
    if (stored.expiresAt < new Date()) {
      throw new Error("Refresh token expired");
    }

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      throw new Error("User not found");
    }

    // Revoke old refresh token
    await prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revoked: true },
    });

    const authUser: AuthUser = {
      id: user.id,
      email: user.email,
      role: user.role,
    };
    const accessToken = createToken(
      { sub: user.id, email: user.email, role: user.role, type: "access" },
      ACCESS_TOKEN_EXPIRY,
    );
    const newRefreshToken = await this.createRefreshToken(user.id);

    return { user: authUser, accessToken, refreshToken: newRefreshToken };
  }

  // Validate an access token and return the authenticated user
  async validateToken(token: string): Promise<AuthUser | null> {
    // Try JWT first
    const jwtPayload = verifyToken(token);
    if (jwtPayload && jwtPayload.type === "access") {
      return {
        id: jwtPayload.sub,
        email: jwtPayload.email,
        role: jwtPayload.role,
      };
    }

    // Try API key
    const keyHash = hashToken(token);
    const apiKey = await prisma.apiKey.findFirst({
      where: { keyHash, revoked: false },
      include: { user: true },
    });
    if (apiKey) {
      if (apiKey.expiresAt && apiKey.expiresAt < new Date()) return null;
      // Update last_used
      await prisma.apiKey.update({
        where: { id: apiKey.id },
        data: { lastUsed: new Date() },
      });
      return {
        id: apiKey.user.id,
        email: apiKey.user.email,
        role: apiKey.user.role,
      };
    }

    return null;
  }

  // Revoke a refresh token (sign out)
  async revokeRefreshToken(token: string): Promise<void> {
    const tokenHash = hashToken(token);
    await prisma.refreshToken.updateMany({
      where: { tokenHash, revoked: false },
      data: { revoked: true },
    });
  }

  // Get current user info
  async getUser(userId: string): Promise<AuthUser | null> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return null;
    return { id: user.id, email: user.email, role: user.role };
  }

  // ---- API Key Management ----

  async createApiKey(
    userId: string,
    name: string,
  ): Promise<CreateApiKeyResponse> {
    const key = `af_${randomUUID().replace(/-/g, "")}`;
    const id = randomUUID();
    const keyHash = hashToken(key);

    await prisma.apiKey.create({
      data: { id, userId, name, keyHash },
    });

    logger.info({ userId, keyId: id, name }, "API key created");
    return { key, id, name };
  }

  async listApiKeys(userId: string): Promise<ApiKeyDTO[]> {
    const keys = await prisma.apiKey.findMany({
      where: { userId, revoked: false },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        lastUsed: true,
        expiresAt: true,
        createdAt: true,
      },
    });

    return keys.map((k) => ({
      id: k.id,
      name: k.name,
      last_used: k.lastUsed?.toISOString() ?? null,
      expires_at: k.expiresAt?.toISOString() ?? null,
      created_at: k.createdAt.toISOString(),
    }));
  }

  async revokeApiKey(userId: string, keyId: string): Promise<boolean> {
    const result = await prisma.apiKey.updateMany({
      where: { id: keyId, userId, revoked: false },
      data: { revoked: true },
    });
    return result.count > 0;
  }

  // ---- Internal ----

  private async createRefreshToken(userId: string): Promise<string> {
    const id = randomUUID();
    const token = createToken(
      { sub: userId, email: "", role: "", type: "refresh" },
      REFRESH_TOKEN_EXPIRY,
    );
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY * 1000);

    await prisma.refreshToken.create({
      data: { id, userId, tokenHash, expiresAt },
    });

    return token;
  }
}

// Singleton instance
export const authService = new AuthService();
