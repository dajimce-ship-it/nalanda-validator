import { EventEmitter } from "events";
import { spawn } from "child_process";
import { createInterface } from "readline";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { getDb } from "../db";
import { executionRuns, executionLogs, nalandaCredentials, scheduleConfig } from "../../drizzle/schema";
import { eq, desc } from "drizzle-orm";
import { decrypt } from "./crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Ruta al worker .mjs que se ejecuta con node puro (no tsx)
const WORKER_PATH = join(__dirname, "worker.mjs");

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

  // Ejecutar en background usando proceso hijo con node puro
  executeRun(runId, userId, nalandaUsername, password, monthsBack).catch(console.error);

  return runId;
}

async function addLog(db: Awaited<ReturnType<typeof getDb>>, runId: number, level: string, message: string) {
  if (!db) return;
  await db.insert(executionLogs).values({ runId, level: level as any, message, createdAt: new Date() });
  runEmitter.emit(`run:${runId}`, { level, message, timestamp: new Date() });
}

async function executeRun(runId: number, userId: number, username: string, password: string, monthsBack: number) {
  const db = await getDb();
  if (!db) return;

  const startTime = Date.now();

  try {
    await new Promise<void>((resolve, reject) => {
      // Lanzar el worker con node puro (no tsx) para evitar el bloqueo de Chromium
      const child = spawn("node", [WORKER_PATH], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      // Enviar parámetros al worker vía stdin
      child.stdin.write(JSON.stringify({ username, password, monthsBack }));
      child.stdin.end();

      let summary: any = null;

      // Leer logs del worker vía stdout (JSON lines)
      const rl = createInterface({ input: child.stdout });
      rl.on("line", async (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.type === "log") {
            await addLog(db, runId, msg.level, msg.message);
          } else if (msg.type === "progress") {
            runEmitter.emit(`run:${runId}:progress`, msg.percent);
          } else if (msg.type === "result") {
            summary = msg.summary;
          } else if (msg.type === "error") {
            reject(new Error(msg.message));
          }
        } catch { /* ignorar líneas no JSON */ }
      });

      // Capturar stderr para diagnóstico
      let stderrOutput = "";
      child.stderr.on("data", (data) => {
        stderrOutput += data.toString();
      });

      child.on("close", async (code) => {
        if (code === 0 && summary) {
          const durationMs = Date.now() - startTime;
          await db.update(executionRuns).set({
            status: "completed",
            finishedAt: new Date(),
            durationMs,
            summary: summary as any,
          }).where(eq(executionRuns.id, runId));

          runEmitter.emit(`run:${runId}:done`, { status: "completed", summary });
          resolve();
        } else if (code !== 0) {
          const errMsg = stderrOutput.trim() || `Worker terminó con código ${code}`;
          reject(new Error(errMsg));
        } else {
          // code === 0 pero no hay summary (error silencioso)
          reject(new Error("El worker terminó sin resultado. Revisa los logs."));
        }
      });

      child.on("error", (err) => {
        reject(new Error(`Error al lanzar el worker: ${err.message}`));
      });
    });

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
