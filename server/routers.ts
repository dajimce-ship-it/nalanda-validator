import { existsSync } from "fs";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import z from "zod";
import {
  saveCredentials, getCredentials, getRuns, getRunById, getRunLogs,
  getSchedule, saveSchedule, toggleSchedule,
} from "./db";
import { encrypt, decrypt } from "./automation/crypto";
import { startRun } from "./automation/runner";

// Usuario del sistema fijo — sin autenticación
const SYSTEM_USER_ID = 1;

// Verificar si Chromium está disponible en el sistema
function getChromiumStatus(): { ready: boolean; message: string } {
  const systemPaths = [
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  for (const p of systemPaths) {
    if (existsSync(p)) return { ready: true, message: "Chromium listo" };
  }
  try {
    const { chromium } = require("playwright");
    const execPath: string = chromium.executablePath();
    if (existsSync(execPath)) return { ready: true, message: "Chromium listo" };
  } catch {}
  return { ready: false, message: "Chromium no instalado. El servidor lo instalará automáticamente al iniciar la primera ejecución (puede tardar 1-2 minutos)." };
}

export const appRouter = router({
  system: systemRouter,

  auth: router({
    me: publicProcedure.query(() => null),
    logout: publicProcedure.mutation(() => ({ success: true } as const)),
  }),

  // ── Credenciales ────────────────────────────────────────────────────────────
  credentials: router({
    save: publicProcedure
      .input(z.object({
        username: z.string().min(1),
        password: z.string(),
        monthsBack: z.number().min(1).max(24).default(6),
      }))
      .mutation(async ({ input }) => {
        let passwordEnc: string | undefined;
        if (input.password && input.password !== "KEEP_EXISTING" && input.password.trim().length > 0) {
          passwordEnc = encrypt(input.password);
        } else {
          const existing = await getCredentials(SYSTEM_USER_ID);
          if (!existing) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "La contraseña es obligatoria para la primera configuración" });
          }
          passwordEnc = existing.nalandaPasswordEnc;
        }
        await saveCredentials(SYSTEM_USER_ID, {
          nalandaUsername: input.username,
          nalandaPasswordEnc: passwordEnc,
          monthsBack: input.monthsBack,
        });
        return { success: true };
      }),

    get: publicProcedure.query(async () => {
      const creds = await getCredentials(SYSTEM_USER_ID);
      if (!creds) return null;
      return {
        username: creds.nalandaUsername,
        monthsBack: creds.monthsBack,
        hasPassword: true,
        updatedAt: creds.updatedAt,
      };
    }),

    test: publicProcedure.mutation(async () => {
      const creds = await getCredentials(SYSTEM_USER_ID);
      if (!creds) throw new TRPCError({ code: "NOT_FOUND", message: "No hay credenciales configuradas" });
      try {
        const pwd = decrypt(creds.nalandaPasswordEnc);
        if (!pwd) throw new Error("Contraseña vacía");
        return { success: true, username: creds.nalandaUsername };
      } catch {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Error al descifrar las credenciales" });
      }
    }),
  }),

  // ── Estado del sistema ────────────────────────────────────────────────────
  system2: router({
    chromiumStatus: publicProcedure.query(() => {
      return getChromiumStatus();
    }),

    diagnose: publicProcedure.query(() => {
      const { execSync } = require("child_process");
      const os = require("os");
      const results: Record<string, string> = {};

      results.user = os.userInfo().username;
      results.platform = os.platform();
      results.homeDir = os.homedir();
      results.tmpDir = os.tmpdir();
      results.cwd = process.cwd();
      results.nodeVersion = process.version;

      const paths = [
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/root/.cache/ms-playwright",
        `${os.homedir()}/.cache/ms-playwright`,
      ];
      for (const p of paths) {
        results[`exists:${p}`] = existsSync(p) ? "YES" : "no";
      }

      try {
        const { chromium } = require("playwright");
        results.playwrightExecPath = chromium.executablePath();
        results.playwrightExecExists = existsSync(chromium.executablePath()) ? "YES" : "no";
      } catch (e: unknown) {
        results.playwrightError = String(e);
      }

      try {
        const output = execSync("npx playwright install chromium --dry-run 2>&1", { timeout: 10000 }).toString();
        results.installDryRun = output.substring(0, 500);
      } catch (e: unknown) {
        results.installDryRunError = String(e).substring(0, 500);
      }

      try {
        results.diskFree = execSync("df -h / 2>&1").toString().substring(0, 200);
      } catch {}

      return results;
    }),
  }),

  // ── Ejecuciones ─────────────────────────────────────────────────────────────
  runs: router({
    start: publicProcedure
      .input(z.object({ triggeredBy: z.enum(["manual", "scheduled"]).default("manual") }))
      .mutation(async ({ input }) => {
        const runId = await startRun(SYSTEM_USER_ID, input.triggeredBy);
        return { runId };
      }),

    list: publicProcedure
      .input(z.object({ limit: z.number().min(1).max(100).default(20) }))
      .query(async ({ input }) => {
        return getRuns(SYSTEM_USER_ID, input.limit);
      }),

    get: publicProcedure
      .input(z.object({ runId: z.number() }))
      .query(async ({ input }) => {
        const run = await getRunById(input.runId);
        if (!run) throw new TRPCError({ code: "NOT_FOUND" });
        return run;
      }),

    logs: publicProcedure
      .input(z.object({ runId: z.number() }))
      .query(async ({ input }) => {
        const run = await getRunById(input.runId);
        if (!run) throw new TRPCError({ code: "NOT_FOUND" });
        return getRunLogs(input.runId);
      }),
  }),

  // ── Programación ────────────────────────────────────────────────────────────
  schedule: router({
    get: publicProcedure.query(async () => {
      const sched = await getSchedule(SYSTEM_USER_ID);
      return sched ?? {
        enabled: false,
        cronExpression: "0 8 * * 1-5",
        timezone: "Europe/Madrid",
        nextRunAt: null,
        lastRunAt: null,
      };
    }),

    save: publicProcedure
      .input(z.object({
        cronExpression: z.string().min(1),
        timezone: z.string().min(1),
        enabled: z.boolean(),
      }))
      .mutation(async ({ input }) => {
        await saveSchedule(SYSTEM_USER_ID, input);
        return { success: true };
      }),

    toggle: publicProcedure
      .input(z.object({ enabled: z.boolean() }))
      .mutation(async ({ input }) => {
        await toggleSchedule(SYSTEM_USER_ID, input.enabled);
        return { success: true };
      }),
  }),
});

export type AppRouter = typeof appRouter;
