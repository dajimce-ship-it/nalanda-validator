import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { runEmitter, isRunActive, cleanupOrphanedRuns } from "../automation/runner";
import { getRunLogs, getRunById } from "../db";
import { jwtVerify } from "jose";
import { COOKIE_NAME } from "@shared/const";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);

  // SSE endpoint para streaming de logs en tiempo real
  app.get("/api/runs/:runId/stream", async (req, res) => {
    const runId = parseInt(req.params.runId);
    if (isNaN(runId)) { res.status(400).json({ error: "Invalid runId" }); return; }

    // Verificar autenticación via cookie
    const cookieHeader = req.headers.cookie || "";
    const sessionMatch = cookieHeader.match(/session=([^;]+)/);
    if (!sessionMatch) { res.status(401).json({ error: "Unauthorized" }); return; }
    try {
      const secret = new TextEncoder().encode(process.env.JWT_SECRET || "");
      await jwtVerify(sessionMatch[1], secret);
    } catch {
      res.status(401).json({ error: "Invalid session" }); return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.flushHeaders();

    // Enviar logs históricos primero
    const existingLogs = await getRunLogs(runId);
    for (const log of existingLogs) {
      res.write(`data: ${JSON.stringify({ level: log.level, message: log.message, timestamp: log.createdAt })}\n\n`);
    }

    // Si la ejecución ya terminó, enviar done y cerrar
    const run = await getRunById(runId);
    if (run && (run.status === "completed" || run.status === "failed")) {
      res.write(`data: ${JSON.stringify({ type: "done", status: run.status, summary: run.summary })}\n\n`);
      res.end();
      return;
    }

    // Suscribirse a nuevos logs en tiempo real
    const onLog = (entry: { level: string; message: string; timestamp: Date }) => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    };
    const onDone = (data: { status: string; summary?: unknown; error?: string }) => {
      res.write(`data: ${JSON.stringify({ type: "done", ...data })}\n\n`);
      cleanup();
      res.end();
    };

    const cleanup = () => {
      runEmitter.off(`run:${runId}`, onLog);
      runEmitter.off(`run:${runId}:done`, onDone);
    };

    runEmitter.on(`run:${runId}`, onLog);
    runEmitter.on(`run:${runId}:done`, onDone);

    // Heartbeat para mantener la conexión viva
    const heartbeat = setInterval(() => { res.write(`: heartbeat\n\n`); }, 15000);

    req.on("close", () => { cleanup(); clearInterval(heartbeat); });
  });

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
    // Limpiar runs huérfanos de reinicios anteriores
    cleanupOrphanedRuns().catch(console.error);
  });
}

startServer().catch(console.error);
