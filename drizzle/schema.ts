import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, boolean, json } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  passwordHash: text("passwordHash"), // Para login con email/contraseña
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// Credenciales de Nalanda Global (cifradas en servidor)
export const nalandaCredentials = mysqlTable("nalanda_credentials", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  nalandaUsername: varchar("nalandaUsername", { length: 320 }).notNull(),
  nalandaPasswordEnc: text("nalandaPasswordEnc").notNull(), // AES-256 cifrado
  monthsBack: int("monthsBack").default(6).notNull(), // cuántos meses revisar
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type NalandaCredentials = typeof nalandaCredentials.$inferSelect;
export type InsertNalandaCredentials = typeof nalandaCredentials.$inferInsert;

// Ejecuciones del proceso de automatización
export const executionRuns = mysqlTable("execution_runs", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  status: mysqlEnum("status", ["pending", "running", "completed", "failed"]).default("pending").notNull(),
  triggeredBy: mysqlEnum("triggeredBy", ["manual", "scheduled"]).default("manual").notNull(),
  startedAt: timestamp("startedAt").defaultNow().notNull(),
  finishedAt: timestamp("finishedAt"),
  durationMs: int("durationMs"),
  summary: json("summary"), // { totalValidated, daysByDate, monthsReviewed, errors }
  errorMessage: text("errorMessage"),
});

export type ExecutionRun = typeof executionRuns.$inferSelect;
export type InsertExecutionRun = typeof executionRuns.$inferInsert;

// Logs de cada ejecución (streaming en tiempo real)
export const executionLogs = mysqlTable("execution_logs", {
  id: int("id").autoincrement().primaryKey(),
  runId: int("runId").notNull(),
  level: mysqlEnum("level", ["info", "success", "warning", "error"]).default("info").notNull(),
  message: text("message").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type ExecutionLog = typeof executionLogs.$inferSelect;
export type InsertExecutionLog = typeof executionLogs.$inferInsert;

// Programación de ejecuciones automáticas
export const scheduleConfig = mysqlTable("schedule_config", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().unique(),
  enabled: boolean("enabled").default(false).notNull(),
  cronExpression: varchar("cronExpression", { length: 100 }).default("0 8 * * 1-5").notNull(), // L-V a las 8:00
  timezone: varchar("timezone", { length: 64 }).default("Europe/Madrid").notNull(),
  nextRunAt: timestamp("nextRunAt"),
  lastRunAt: timestamp("lastRunAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ScheduleConfig = typeof scheduleConfig.$inferSelect;
export type InsertScheduleConfig = typeof scheduleConfig.$inferInsert;
