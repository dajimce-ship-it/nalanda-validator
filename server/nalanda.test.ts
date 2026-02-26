import { describe, expect, it } from "vitest";
import { encrypt, decrypt } from "./automation/crypto";
import { appRouter } from "./routers";
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
    expect(enc1).not.toBe(enc2);
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

// ── Contexto público (sin usuario) ───────────────────────────────────────────

function createPublicContext(): TrpcContext {
  return {
    user: null,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

// ── Auth router tests ─────────────────────────────────────────────────────────

describe("auth.logout", () => {
  it("returns success without requiring authentication", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.auth.logout();
    expect(result).toEqual({ success: true });
  });
});

describe("auth.me", () => {
  it("returns null (no authentication required)", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    const user = await caller.auth.me();
    expect(user).toBeNull();
  });
});

// ── Credentials router tests ──────────────────────────────────────────────────

describe("credentials.save", () => {
  it("is accessible without authentication", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    // Debe resolver (no rechazar) — acceso libre
    await expect(
      caller.credentials.save({ username: "test@test.com", password: "pass123", monthsBack: 6 })
    ).resolves.toEqual({ success: true });
  });
});

describe("credentials.get", () => {
  it("is accessible without authentication", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    // Debe resolver (puede ser null si no hay credenciales guardadas)
    const result = await caller.credentials.get();
    expect(result === null || typeof result === "object").toBe(true);
  });
});

// ── Schedule router tests ─────────────────────────────────────────────────────

describe("schedule.save", () => {
  it("validates cron expression is not empty", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.schedule.save({ cronExpression: "", timezone: "Europe/Madrid", enabled: false })
    ).rejects.toThrow();
  });
});

describe("runs.start", () => {
  it("is accessible without authentication and starts a run", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.runs.start({ triggeredBy: "manual" });
    expect(result).toHaveProperty("runId");
    expect(typeof result.runId).toBe("number");
  });
});
