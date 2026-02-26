import { eq, desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, users, nalandaCredentials, executionRuns, executionLogs, scheduleConfig, InsertNalandaCredentials } from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) { console.warn("[Database] Cannot upsert user: database not available"); return; }

  try {
    const values: InsertUser = { openId: user.openId };
    const updateSet: Record<string, unknown> = {};
    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];
    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };
    textFields.forEach(assignNullable);
    if (user.lastSignedIn !== undefined) { values.lastSignedIn = user.lastSignedIn; updateSet.lastSignedIn = user.lastSignedIn; }
    if (user.role !== undefined) { values.role = user.role; updateSet.role = user.role; }
    else if (user.openId === ENV.ownerOpenId) { values.role = 'admin'; updateSet.role = 'admin'; }
    if (!values.lastSignedIn) values.lastSignedIn = new Date();
    if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();
    await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// ── Credenciales ──────────────────────────────────────────────────────────────

export async function saveCredentials(userId: number, data: { nalandaUsername: string; nalandaPasswordEnc: string; monthsBack: number }) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const existing = await db.select().from(nalandaCredentials).where(eq(nalandaCredentials.userId, userId)).limit(1);
  if (existing[0]) {
    await db.update(nalandaCredentials).set({ ...data, updatedAt: new Date() }).where(eq(nalandaCredentials.userId, userId));
  } else {
    await db.insert(nalandaCredentials).values({ userId, ...data });
  }
}

export async function getCredentials(userId: number) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.select().from(nalandaCredentials).where(eq(nalandaCredentials.userId, userId)).limit(1);
  return result[0] ?? null;
}

// ── Ejecuciones ───────────────────────────────────────────────────────────────

export async function getRuns(userId: number, limit = 20) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(executionRuns).where(eq(executionRuns.userId, userId)).orderBy(desc(executionRuns.startedAt)).limit(limit);
}

export async function getRunById(runId: number) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.select().from(executionRuns).where(eq(executionRuns.id, runId)).limit(1);
  return result[0] ?? null;
}

export async function getRunLogs(runId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(executionLogs).where(eq(executionLogs.runId, runId)).orderBy(executionLogs.createdAt);
}

// ── Programación ──────────────────────────────────────────────────────────────

export async function getSchedule(userId: number) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.select().from(scheduleConfig).where(eq(scheduleConfig.userId, userId)).limit(1);
  return result[0] ?? null;
}

export async function saveSchedule(userId: number, data: { cronExpression: string; timezone: string; enabled: boolean }) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const existing = await db.select().from(scheduleConfig).where(eq(scheduleConfig.userId, userId)).limit(1);
  if (existing[0]) {
    await db.update(scheduleConfig).set({ ...data, updatedAt: new Date() }).where(eq(scheduleConfig.userId, userId));
  } else {
    await db.insert(scheduleConfig).values({ userId, ...data });
  }
}

export async function toggleSchedule(userId: number, enabled: boolean) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(scheduleConfig).set({ enabled, updatedAt: new Date() }).where(eq(scheduleConfig.userId, userId));
}

// ── Auth por email/contraseña ─────────────────────────────────────────────────

export async function getUserByEmail(email: string) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return result[0] ?? null;
}

export async function createUserWithPassword(data: { email: string; name: string; passwordHash: string }) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.insert(users).values({
    email: data.email,
    name: data.name,
    passwordHash: data.passwordHash,
    loginMethod: "email",
    lastSignedIn: new Date(),
  });
  const result = await db.select().from(users).where(eq(users.email, data.email)).limit(1);
  return result[0];
}

export async function updateUserPassword(userId: number, passwordHash: string) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  await db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, userId));
}

export async function updateUserLastSignedIn(userId: number) {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({ lastSignedIn: new Date() }).where(eq(users.id, userId));
}
