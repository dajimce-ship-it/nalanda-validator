import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import {
  saveCredentials, getCredentials, getRuns, getRunById, getRunLogs,
  getSchedule, saveSchedule, toggleSchedule
} from "./db";
import { encrypt, decrypt } from "./automation/crypto";
import { startRun } from "./automation/runner";

export const appRouter = router({
  system: systemRouter,

  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  // ── Credenciales ────────────────────────────────────────────────────────────
  credentials: router({
    save: protectedProcedure
      .input(z.object({
        username: z.string().min(1),
        password: z.string().min(1),
        monthsBack: z.number().min(1).max(24).default(6),
      }))
      .mutation(async ({ ctx, input }) => {
        const enc = encrypt(input.password);
        await saveCredentials(ctx.user.id, {
          nalandaUsername: input.username,
          nalandaPasswordEnc: enc,
          monthsBack: input.monthsBack,
        });
        return { success: true };
      }),

    get: protectedProcedure.query(async ({ ctx }) => {
      const creds = await getCredentials(ctx.user.id);
      if (!creds) return null;
      return {
        username: creds.nalandaUsername,
        monthsBack: creds.monthsBack,
        hasPassword: true,
        updatedAt: creds.updatedAt,
      };
    }),

    test: protectedProcedure.mutation(async ({ ctx }) => {
      const creds = await getCredentials(ctx.user.id);
      if (!creds) throw new TRPCError({ code: "NOT_FOUND", message: "No hay credenciales configuradas" });
      // Test básico: verificar que se pueden descifrar
      try {
        const pwd = decrypt(creds.nalandaPasswordEnc);
        if (!pwd) throw new Error("Contraseña vacía");
        return { success: true, username: creds.nalandaUsername };
      } catch {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Error al descifrar las credenciales" });
      }
    }),
  }),

  // ── Ejecuciones ─────────────────────────────────────────────────────────────
  runs: router({
    start: protectedProcedure
      .input(z.object({ triggeredBy: z.enum(["manual", "scheduled"]).default("manual") }))
      .mutation(async ({ ctx, input }) => {
        const runId = await startRun(ctx.user.id, input.triggeredBy);
        return { runId };
      }),

    list: protectedProcedure
      .input(z.object({ limit: z.number().min(1).max(100).default(20) }))
      .query(async ({ ctx, input }) => {
        return getRuns(ctx.user.id, input.limit);
      }),

    get: protectedProcedure
      .input(z.object({ runId: z.number() }))
      .query(async ({ ctx, input }) => {
        const run = await getRunById(input.runId);
        if (!run || run.userId !== ctx.user.id) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }
        return run;
      }),

    logs: protectedProcedure
      .input(z.object({ runId: z.number() }))
      .query(async ({ ctx, input }) => {
        const run = await getRunById(input.runId);
        if (!run || run.userId !== ctx.user.id) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }
        return getRunLogs(input.runId);
      }),
  }),

  // ── Programación ────────────────────────────────────────────────────────────
  schedule: router({
    get: protectedProcedure.query(async ({ ctx }) => {
      const sched = await getSchedule(ctx.user.id);
      return sched ?? {
        enabled: false,
        cronExpression: "0 8 * * 1-5",
        timezone: "Europe/Madrid",
        nextRunAt: null,
        lastRunAt: null,
      };
    }),

    save: protectedProcedure
      .input(z.object({
        cronExpression: z.string().min(1),
        timezone: z.string().min(1),
        enabled: z.boolean(),
      }))
      .mutation(async ({ ctx, input }) => {
        await saveSchedule(ctx.user.id, input);
        return { success: true };
      }),

    toggle: protectedProcedure
      .input(z.object({ enabled: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        await toggleSchedule(ctx.user.id, input.enabled);
        return { success: true };
      }),
  }),
});

export type AppRouter = typeof appRouter;
