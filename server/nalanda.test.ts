import { describe, expect, it, vi, beforeEach } from "vitest";
import { encrypt, decrypt } from "./automation/crypto";
import { appRouter } from "./routers";
import { COOKIE_NAME } from "../shared/const";
import type { TrpcContext } from "./_core/context";

// ── Crypto tests ──────────────────────────────────────────────────────────────

describe("crypto", () => {
  it("encrypts and decrypts a string correctly", () => {
    const original = "TestPassword123!";
    const encrypted = encrypt(original);
    expect(encrypted).not.toBe(original);
    expect(encrypted).toContain(":");
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(original);
  });

  it("produces different ciphertext for the same input", () => {
    const password = "SamePassword";
    const enc1 = encrypt(password);
    const enc2 = encrypt(password);
    expect(enc1).not.toBe(enc2); // IV aleatorio → diferente cada vez
    expect(decrypt(enc1)).toBe(password);
    expect(decrypt(enc2)).toBe(password);
  });

  it("throws on invalid encrypted format", () => {
    expect(() => decrypt("invalid-format")).toThrow();
  });

  it("encrypts special characters correctly", () => {
    const password = "P@ss!w0rd#2024$%^&*()";
    expect(decrypt(encrypt(password))).toBe(password);
  });
});

// ── Auth router tests ─────────────────────────────────────────────────────────

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAuthContext(): { ctx: TrpcContext; clearedCookies: { name: string; options: Record<string, unknown> }[] } {
  const clearedCookies: { name: string; options: Record<string, unknown> }[] = [];
  const user: AuthenticatedUser = {
    id: 1,
    openId: "test-user-openid",
    email: "test@example.com",
    name: "Test User",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  const ctx: TrpcContext = {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {
      clearCookie: (name: string, options: Record<string, unknown>) => {
        clearedCookies.push({ name, options });
      },
    } as TrpcContext["res"],
  };
  return { ctx, clearedCookies };
}

describe("auth.logout", () => {
  it("clears session cookie and returns success", async () => {
    const { ctx, clearedCookies } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.auth.logout();
    expect(result).toEqual({ success: true });
    expect(clearedCookies).toHaveLength(1);
    expect(clearedCookies[0]?.name).toBe(COOKIE_NAME);
    expect(clearedCookies[0]?.options).toMatchObject({ maxAge: -1, httpOnly: true, path: "/" });
  });
});

describe("auth.me", () => {
  it("returns the current user when authenticated", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    const user = await caller.auth.me();
    expect(user).not.toBeNull();
    expect(user?.email).toBe("test@example.com");
  });

  it("returns null when not authenticated", async () => {
    const ctx: TrpcContext = {
      user: null,
      req: { protocol: "https", headers: {} } as TrpcContext["req"],
      res: { clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    };
    const caller = appRouter.createCaller(ctx);
    const user = await caller.auth.me();
    expect(user).toBeNull();
  });
});

// ── Credentials router tests ──────────────────────────────────────────────────

describe("credentials.save", () => {
  it("requires authentication", async () => {
    const ctx: TrpcContext = {
      user: null,
      req: { protocol: "https", headers: {} } as TrpcContext["req"],
      res: { clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    };
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.credentials.save({ username: "test@test.com", password: "pass123", monthsBack: 6 })
    ).rejects.toThrow();
  });
});

describe("credentials.get", () => {
  it("requires authentication", async () => {
    const ctx: TrpcContext = {
      user: null,
      req: { protocol: "https", headers: {} } as TrpcContext["req"],
      res: { clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    };
    const caller = appRouter.createCaller(ctx);
    await expect(caller.credentials.get()).rejects.toThrow();
  });
});

// ── Schedule router tests ─────────────────────────────────────────────────────

describe("schedule.save", () => {
  it("validates cron expression is not empty", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.schedule.save({ cronExpression: "", timezone: "Europe/Madrid", enabled: false })
    ).rejects.toThrow();
  });
});

describe("runs.start", () => {
  it("requires authentication", async () => {
    const ctx: TrpcContext = {
      user: null,
      req: { protocol: "https", headers: {} } as TrpcContext["req"],
      res: { clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    };
    const caller = appRouter.createCaller(ctx);
    await expect(caller.runs.start({ triggeredBy: "manual" })).rejects.toThrow();
  });
});
