import { EventEmitter } from "events";
import { getDb } from "../db";
import { executionRuns, executionLogs, nalandaCredentials, scheduleConfig } from "../../drizzle/schema";
import { eq, desc } from "drizzle-orm";
import { decrypt } from "./crypto";
import { runNalandaAutomation, LogEntry, RunSummary } from "./nalanda";

// Singleton emitter para SSE
export const runEmitter = new EventEmitter();
runEmitter.setMaxListeners(50);

// Mapa de ejecuciones activas
const activeRuns = new Map<number, boolean>();

export async function startRun(userId: number, triggeredBy: "manual" | "scheduled"): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Base de datos no disponible");

  // Verificar que no hay otra ejecución activa para este usuario
  const existingRun = await db
    .select()
    .from(executionRuns)
    .where(eq(executionRuns.userId, userId))
    .orderBy(desc(executionRuns.startedAt))
    .limit(1);

  if (existingRun[0]?.status === "running") {
    throw new Error("Ya hay una ejecución en curso");
  }

  // Obtener credenciales
  const creds = await db.select().from(nalandaCredentials).where(eq(nalandaCredentials.userId, userId)).limit(1);
  if (!creds[0]) throw new Error("No hay credenciales configuradas. Configura las credenciales de Nalanda primero.");

  // Crear registro de ejecución
  const [result] = await db.insert(executionRuns).values({
    userId,
    status: "running",
    triggeredBy,
    startedAt: new Date(),
  });

  const runId = (result as any).insertId as number;
  activeRuns.set(runId, true);

  const { nalandaUsername, nalandaPasswordEnc, monthsBack } = creds[0];
  const password = decrypt(nalandaPasswordEnc);

  // Ejecutar en background
  executeRun(runId, userId, nalandaUsername, password, monthsBack).catch(console.error);

  return runId;
}

async function addLog(db: Awaited<ReturnType<typeof getDb>>, runId: number, level: LogEntry["level"], message: string) {
  if (!db) return;
  await db.insert(executionLogs).values({ runId, level, message, createdAt: new Date() });
  runEmitter.emit(`run:${runId}`, { level, message, timestamp: new Date() });
}

async function executeRun(runId: number, userId: number, username: string, password: string, monthsBack: number) {
  const db = await getDb();
  if (!db) return;

  const startTime = Date.now();
  let summary: RunSummary | null = null;

  try {
    summary = await runNalandaAutomation(username, password, monthsBack, {
      onLog: async (entry) => {
        await addLog(db, runId, entry.level, entry.message);
      },
      onProgress: (percent) => {
        runEmitter.emit(`run:${runId}:progress`, percent);
      },
    });

    const durationMs = Date.now() - startTime;
    await db.update(executionRuns).set({
      status: "completed",
      finishedAt: new Date(),
      durationMs,
      summary: summary as any,
    }).where(eq(executionRuns.id, runId));

    runEmitter.emit(`run:${runId}:done`, { status: "completed", summary });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startTime;

    await addLog(db, runId, "error", `Error fatal: ${errorMessage}`);
    await db.update(executionRuns).set({
      status: "failed",
      finishedAt: new Date(),
      durationMs,
      errorMessage,
    }).where(eq(executionRuns.id, runId));

    runEmitter.emit(`run:${runId}:done`, { status: "failed", error: errorMessage });
  } finally {
    activeRuns.delete(runId);

    // Actualizar lastRunAt en schedule si aplica
    await db.update(scheduleConfig).set({ lastRunAt: new Date() }).where(eq(scheduleConfig.userId, userId));
  }
}

export function isRunActive(runId: number): boolean {
  return activeRuns.has(runId);
}
