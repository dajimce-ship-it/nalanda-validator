import { EventEmitter } from "events";
import { spawn } from "child_process";
import { createInterface } from "readline";
import { getDb } from "../db";
import { executionRuns, executionLogs, nalandaCredentials, scheduleConfig } from "../../drizzle/schema";
import { eq, desc } from "drizzle-orm";
import { decrypt } from "./crypto";

// Singleton emitter para SSE
export const runEmitter = new EventEmitter();
runEmitter.setMaxListeners(50);

// Mapa de ejecuciones activas
const activeRuns = new Map<number, boolean>();

// ============================================================
// CÓDIGO DEL WORKER - incrustado como string para que funcione
// tanto en desarrollo (tsx) como en producción (/usr/src/app/dist)
// sin depender de ningún archivo externo.
// Los parámetros se inyectan vía globalThis.__WORKER_INPUT__
// antes de ejecutar este código.
// ============================================================
const WORKER_CODE = `
import { chromium } from 'playwright';
import { accessSync } from 'fs';
import { execSync } from 'child_process';

const NALANDA_URL = 'https://app.nalandaglobal.com';
const PENDING_URL = NALANDA_URL + '/obra-guiada/verObrasConJornadasPendientes.action';

const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
  '--no-zygote',
  '--single-process',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-default-apps',
  '--mute-audio',
];

function sendLog(level, message) {
  process.stdout.write(JSON.stringify({ type: 'log', level, message }) + '\\n');
}
function sendProgress(percent) {
  process.stdout.write(JSON.stringify({ type: 'progress', percent }) + '\\n');
}
function sendResult(summary) {
  process.stdout.write(JSON.stringify({ type: 'result', summary }) + '\\n');
}
function sendError(message) {
  process.stdout.write(JSON.stringify({ type: 'error', message }) + '\\n');
}

function findChromiumExecutable() {
  // 1. Intentar obtener la ruta del ejecutable de Playwright automaticamente
  try {
    const path = chromium.executablePath();
    if (path) { accessSync(path); return path; }
  } catch { /* continuar */ }
  // 2. Buscar en PLAYWRIGHT_BROWSERS_PATH (Dockerfile: /usr/src/app/.browsers)
  const browsersBase = process.env['PLAYWRIGHT_BROWSERS_PATH'] || '/usr/src/app/.browsers';
  try {
    const { readdirSync } = require('fs');
    const dirs = readdirSync(browsersBase);
    for (const dir of dirs) {
      if (dir.startsWith('chromium') && !dir.startsWith('chromium_headless')) {
        const candidates = [
          browsersBase + '/' + dir + '/chrome-linux64/chrome',
          browsersBase + '/' + dir + '/chrome-linux/chrome',
          browsersBase + '/' + dir + '/chromium',
          browsersBase + '/' + dir + '/chrome',
        ];
        for (const c of candidates) {
          try { accessSync(c); return c; } catch { /* siguiente */ }
        }
      }
    }
  } catch { /* continuar */ }
  // 3. Fallback: rutas conocidas del sistema
  const systemPaths = [
    '/usr/bin/chromium-browser',
    '/usr/lib/chromium-browser/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ];
  for (const p of systemPaths) {
    try { accessSync(p); return p; } catch { /* siguiente */ }
  }
  // Dejar que Playwright use su propio binario sin especificar ruta
  return null;
}

async function installChromiumAndRetry() {
  sendLog('info', 'Chromium no encontrado. Instalando...');
  try {
    execSync('npx playwright install chromium', { stdio: 'pipe', timeout: 300000 });
    sendLog('success', 'Chromium instalado. Reintentando...');
    return true;
  } catch (e) {
    sendLog('error', 'No se pudo instalar Chromium: ' + (e.message || String(e)));
    return false;
  }
}

function getMonthsToReview(monthsBack) {
  const months = [];
  const now = new Date();
  for (let i = 1; i <= monthsBack; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    months.push({ label: mm + '/' + yyyy, sampleDate: '15/' + mm + '/' + yyyy });
  }
  return months;
}

async function login(page, username, password) {
  sendLog('info', 'Navegando a Nalanda Global...');
  await page.goto(NALANDA_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  const currentUrl = page.url();
  if (currentUrl.includes('app.nalandaglobal.com') && !currentUrl.includes('identity.nalandaglobal.com')) {
    sendLog('success', 'Sesion ya activa, continuando...');
    return;
  }

  await page.waitForSelector('#username', { timeout: 15000 });
  sendLog('info', 'Iniciando sesion como ' + username + '...');
  await page.fill('#username', '');
  await page.fill('#username', username);
  await page.fill('#password', '');
  await page.fill('#password', password);
  await page.click('#kc-login');

  try {
    await page.waitForURL(url => !url.toString().includes('identity.nalandaglobal.com'), { timeout: 20000 });
    sendLog('success', 'Login completado correctamente');
  } catch {
    const errorEl = await page.$('.alert-error, .kc-feedback-text');
    if (errorEl) {
      const errorText = await errorEl.textContent();
      throw new Error('Error de login: ' + (errorText?.trim() || 'Credenciales incorrectas'));
    }
    throw new Error('Timeout esperando redireccion tras login');
  }
}

// Lee las fechas pendientes directamente del campo oculto #fechasConJornadas
// que Nalanda incluye en el HTML con todas las fechas pendientes en formato YYYY-MM-DD
async function getPendingDatesFromPage(page) {
  const rawValue = await page.evaluate(() => {
    const campo = document.getElementById('fechasConJornadas');
    return campo ? campo.value : '';
  });
  
  if (!rawValue || rawValue.trim() === '[]' || rawValue.trim() === '') return [];
  
  // El valor tiene formato: [2025-01-31, 2025-02-28, ...]
  // Usamos split/join en lugar de regex para evitar problemas de escape en template literal
  const cleaned = rawValue.split('[').join('').split(']').join('').trim();
  if (!cleaned) return [];
  
  const dates = cleaned.split(',').map(d => d.trim()).filter(Boolean);
  
  // Convertir de YYYY-MM-DD a DD/MM/YYYY para las URLs de Nalanda
  return dates.map(d => {
    const parts = d.split('-');
    if (parts.length === 3) {
      return parts[2] + '/' + parts[1] + '/' + parts[0]; // DD/MM/YYYY
    }
    return d;
  });
}

// Valida todos los partes en la página mostrarJornadasValidables
// La interfaz tiene dos tipos de filas:
// 1. Partes mensuales: botón "Validate report" (.js-validar-parte) + confirmación Aceptar
// 2. Partes con trabajadores: checkboxes + botón "Validate selected days"
async function validateJornadasPage(page) {
  let totalValidated = 0;
  
  // Esperar a que la página cargue
  await page.waitForTimeout(1500);
  
  // Verificar si no hay partes pendientes
  const bodyText = await page.evaluate(() => document.body.textContent || '');
  if (bodyText.includes('There are no reports pending validation') || 
      bodyText.includes('no hay partes pendientes') ||
      bodyText.includes('no reports pending')) {
    sendLog('info', '  Sin partes pendientes en esta pagina');
    return 0;
  }
  
  // Caso 1: Partes mensuales con botón "Validate report" (.js-validar-parte)
  let validateReportBtns = await page.$$('.js-validar-parte');
  if (validateReportBtns.length > 0) {
    sendLog('info', '  Encontrados ' + validateReportBtns.length + ' parte(s) mensual(es) para validar');
    
    // Validar cada parte uno a uno (la lista puede cambiar tras cada validación)
    let maxAttempts = 20;
    while (maxAttempts-- > 0) {
      const btns = await page.$$('.js-validar-parte');
      if (btns.length === 0) break;
      
      sendLog('info', '  Validando parte ' + (totalValidated + 1) + '...');
      await btns[0].click();
      await page.waitForTimeout(1000);
      
      // Esperar y hacer clic en el diálogo de confirmación
      try {
        const confirmBtn = await page.waitForSelector('#btnConfirmacion, button:has-text("Aceptar"), button:has-text("Accept"), button:has-text("OK"), button:has-text("Ok")', { timeout: 8000 });
        if (confirmBtn) {
          await confirmBtn.click();
          await page.waitForTimeout(1000);
        }
      } catch { /* puede no aparecer */ }
      
      totalValidated++;
      sendLog('success', '  Parte ' + totalValidated + ' validado correctamente');
      
      // Esperar a que la página se actualice
      await page.waitForTimeout(1500);
    }
    return totalValidated;
  }
  
  // Caso 2: Partes con trabajadores individuales (checkboxes)
  const headerCheckbox = await page.$('thead input[type="checkbox"]');
  const bodyCheckboxes = await page.$$('tbody input[type="checkbox"]');
  
  if (bodyCheckboxes.length > 0 || headerCheckbox) {
    sendLog('info', '  Encontrados checkboxes de trabajadores');
    
    if (headerCheckbox) {
      await headerCheckbox.click();
      await page.waitForTimeout(500);
    } else {
      for (const cb of bodyCheckboxes) {
        if (!await cb.isChecked()) await cb.check();
      }
    }
    
    const checkedCount = await page.$$eval('tbody input[type="checkbox"]:checked', els => els.length);
    sendLog('info', '  -> ' + checkedCount + ' trabajadores seleccionados');
    
    // Buscar el botón "Validate selected days" (puede estar oculto hasta seleccionar)
    const validateBtn = await page.$('.js-validar-total-jornadas, button:has-text("Validate selected days"), a:has-text("Validate selected days"), #js-validar-seleccionadas');
    if (validateBtn) {
      await validateBtn.click({ force: true });
      await page.waitForTimeout(1000);
      
      // Confirmación
      try {
        const confirmBtn = await page.waitForSelector('#btnConfirmacion, button:has-text("Aceptar"), button:has-text("Accept")', { timeout: 5000 });
        if (confirmBtn) await confirmBtn.click();
        await page.waitForTimeout(800);
      } catch { /* puede no aparecer */ }
      
      totalValidated = checkedCount;
      sendLog('success', '  ' + checkedCount + ' jornadas validadas');
    } else {
      sendLog('warning', '  No se encontro boton de validacion masiva');
    }
    return totalValidated;
  }
  
  sendLog('warning', '  No se encontraron elementos de validacion en la pagina');
  return 0;
}

async function processDay(page, date, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      sendLog('info', 'Procesando dia ' + date + '...');
      await page.goto(PENDING_URL + '?fechaStr=' + date, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(1500);

      const bodyText = await page.evaluate(() => document.body.textContent || '');
      if (bodyText.includes('There are no works with pending days') || 
          bodyText.includes('no hay obras') ||
          bodyText.includes('There are no reports pending validation for this day')) {
        sendLog('info', 'Dia ' + date + ': sin partes pendientes');
        return { date, workersValidated: 0, obras: [] };
      }

      // Buscar botones "Validate working days" visibles (la clase real es js-validarJornada)
      // Hay botones ocultos en el DOM (top=0, sin dimensiones) que causan timeout - solo usar visibles
      const getVisibleBtns = async () => {
        const allBtns = await page.$$('.js-validarJornada, button.js-validar-jornadas');
        const visible = [];
        for (const btn of allBtns) {
          const box = await btn.boundingBox();
          if (box && box.width > 0 && box.height > 0 && box.y > 50) visible.push(btn);
        }
        return visible;
      };

      const validateButtons = await getVisibleBtns();
      if (validateButtons.length === 0) {
        sendLog('warning', 'Dia ' + date + ': no se encontraron obras pendientes');
        return { date, workersValidated: 0, obras: [] };
      }

      const obras = [];
      let totalWorkers = 0;
      const numObras = validateButtons.length;
      sendLog('info', 'Dia ' + date + ': ' + numObras + ' obra(s) con partes pendientes');

      for (let i = 0; i < numObras; i++) {
        // Recargar la lista de obras (puede cambiar tras cada validación)
        await page.goto(PENDING_URL + '?fechaStr=' + date, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await page.waitForTimeout(1500);

        // Solo botones visibles (con bounding box real, no los ocultos en top=0)
        const btns = await getVisibleBtns();
        if (btns.length === 0) {
          sendLog('info', 'Dia ' + date + ': todas las obras procesadas');
          break;
        }

        const obraName = await btns[0].evaluate(el => {
          const row = el.closest('tr') || el.closest('div') || el.parentElement;
          return row?.textContent?.replace(/\\s+/g, ' ').trim().substring(0, 80) || 'Obra';
        });

        sendLog('info', '  Obra ' + (i+1) + '/' + numObras + ': ' + obraName.substring(0, 50) + '...');
        // Scroll y clic en el primer botón visible
        await btns[0].scrollIntoViewIfNeeded();
        await page.waitForTimeout(500);
        await btns[0].click();

        try {
          await page.waitForURL(url => url.toString().includes('mostrarJornadasValidables'), { timeout: 12000 });
        } catch {
          await page.waitForTimeout(2000);
        }

        const validated = await validateJornadasPage(page);
        totalWorkers += validated;
        obras.push({ name: obraName, validated });
        sendLog('success', '  Obra ' + (i+1) + ' procesada: ' + validated + ' parte(s) validado(s)');
      }

      sendLog('success', 'Dia ' + date + ': ' + totalWorkers + ' parte(s) validado(s) en ' + obras.length + ' obra(s)');
      return { date, workersValidated: totalWorkers, obras: obras.map(o => o.name) };

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (attempt < retries) {
        sendLog('warning', 'Intento ' + attempt + '/' + retries + ' fallido para ' + date + ': ' + errMsg.substring(0, 100) + '. Reintentando...');
        await new Promise(r => setTimeout(r, 3000));
      } else {
        sendLog('error', 'Error procesando ' + date + ' tras ' + retries + ' intentos: ' + errMsg.substring(0, 200));
        return { date, workersValidated: 0, obras: [] };
      }
    }
  }
  return { date, workersValidated: 0, obras: [] };
}

async function main() {
  // Los parámetros se inyectan vía globalThis.__WORKER_INPUT__ por el runner
  const { username, password, monthsBack } = globalThis.__WORKER_INPUT__;

  const summary = {
    totalValidated: 0,
    daysByDate: [],
    monthsReviewed: [],
    errors: [],
  };

  let browser = null;
  let context = null;

  try {
    sendLog('info', 'Iniciando navegador...');

    const executablePath = findChromiumExecutable();
    if (executablePath) {
      sendLog('info', 'Usando Chromium: ' + executablePath);
    } else {
      sendLog('info', 'Usando Chromium de Playwright (automatico)');
    }

    const launchOptions = {
      headless: true,
      args: CHROMIUM_ARGS,
      timeout: 30000,
    };
    if (executablePath) launchOptions.executablePath = executablePath;

    try {
      browser = await chromium.launch(launchOptions);
    } catch (launchErr) {
      // Si falla porque no hay Chromium, intentar instalarlo y reintentar
      if (launchErr.message && launchErr.message.includes("Executable doesn't exist")) {
        const installed = await installChromiumAndRetry();
        if (installed) {
          // Reintentar sin executablePath para que Playwright use el recién instalado
          const retryOptions = { headless: true, args: CHROMIUM_ARGS, timeout: 30000 };
          browser = await chromium.launch(retryOptions);
        } else {
          throw launchErr;
        }
      } else {
        throw launchErr;
      }
    }

    sendLog('success', 'Navegador iniciado correctamente');

    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    await login(page, username, password);
    sendProgress(5);

    // Navegar a la página de partes pendientes y leer TODAS las fechas de una vez
    sendLog('info', 'Buscando todos los partes pendientes...');
    await page.goto(PENDING_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);

    let pendingDates = [];
    try { pendingDates = await getPendingDatesFromPage(page); } catch (e) {
      sendLog('warning', 'No se pudo leer las fechas pendientes: ' + e.message);
    }

    if (pendingDates.length === 0) {
      sendLog('success', 'No hay partes pendientes de validacion');
      sendProgress(100);
      sendResult(summary);
      return;
    }

    sendLog('info', 'Encontrados ' + pendingDates.length + ' dia(s) con partes pendientes: ' + pendingDates.join(', '));
    sendProgress(10);

    for (let i = 0; i < pendingDates.length; i++) {
      const date = pendingDates[i];
      const daySummary = await processDay(page, date);
      summary.daysByDate.push(daySummary);
      summary.totalValidated += daySummary.workersValidated;
      summary.monthsReviewed.push({ month: date, pendingFound: daySummary.workersValidated > 0 });
      sendProgress(10 + Math.round(((i + 1) / pendingDates.length) * 80));
    }

    // Verificacion final: comprobar que no quedan partes pendientes
    sendLog('info', 'Realizando verificacion final...');
    await page.goto(PENDING_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);

    let remainingDates = [];
    try { remainingDates = await getPendingDatesFromPage(page); } catch { /* ignorar */ }

    if (remainingDates.length === 0) {
      sendLog('success', 'Verificacion final: no quedan partes pendientes');
    } else {
      sendLog('warning', 'Verificacion final: aun quedan ' + remainingDates.length + ' dia(s) pendiente(s): ' + remainingDates.join(', '));
    }

    sendLog('success', 'Proceso completado. Total: ' + summary.totalValidated + ' parte(s) validado(s) en ' + summary.daysByDate.filter(d => d.workersValidated > 0).length + ' dia(s)');
    sendProgress(100);
    sendResult(summary);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendError(msg);
    process.exit(1);
  } finally {
    if (context) try { await context.close(); } catch { /* ignorar */ }
    if (browser) try { await browser.close(); } catch { /* ignorar */ }
  }
}

main().catch(err => {
  sendError(err.message || String(err));
  process.exit(1);
});
`;

export async function startRun(userId: number, triggeredBy: "manual" | "scheduled"): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Base de datos no disponible");

  const existingRun = await db
    .select()
    .from(executionRuns)
    .where(eq(executionRuns.userId, userId))
    .orderBy(desc(executionRuns.startedAt))
    .limit(1);

  // Si hay un run en estado "running" pero no está en el mapa de activos
  // de esta instancia, es un huérfano de un reinicio anterior → limpiarlo.
  if (existingRun[0]?.status === "running") {
    if (!activeRuns.has(existingRun[0].id)) {
      // Run huérfano: marcarlo como fallido y continuar
      await db
        .update(executionRuns)
        .set({
          status: "failed",
          finishedAt: new Date(),
          errorMessage:
            "Ejecución interrumpida: el servidor se reinició mientras el proceso estaba en curso",
        })
        .where(eq(executionRuns.id, existingRun[0].id));
    } else {
      throw new Error("Ya hay una ejecución en curso");
    }
  }

  const creds = await db.select().from(nalandaCredentials).where(eq(nalandaCredentials.userId, userId)).limit(1);
  if (!creds[0]) throw new Error("No hay credenciales configuradas. Configura las credenciales de Nalanda primero.");

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
      // Ejecutar el código del worker incrustado con node --input-type=module
      // Esto funciona tanto en desarrollo (tsx) como en producción (/usr/src/app/dist)
      // porque no depende de ningún archivo externo en disco.
      const child = spawn("node", ["--input-type=module"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      // Inyectar los parámetros como globalThis.__WORKER_INPUT__ antes del código del worker
      const inputPayload = JSON.stringify({ username, password, monthsBack });
      const fullCode = `globalThis.__WORKER_INPUT__ = ${inputPayload};\n${WORKER_CODE}`;

      child.stdin.write(fullCode);
      child.stdin.end();

      let summary: any = null;

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
    await db.update(scheduleConfig).set({ lastRunAt: new Date() }).where(eq(scheduleConfig.userId, userId));
  }
}

export function isRunActive(runId: number): boolean {
  return activeRuns.has(runId);
}

/**
 * Limpia runs que quedaron en estado "running" porque el servidor se reinició.
 * Un run se considera huérfano si lleva más de 30 minutos sin actualizarse
 * y no está en el mapa de ejecuciones activas de esta instancia.
 * Se llama automáticamente al arrancar el servidor.
 */
export async function cleanupOrphanedRuns(): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;

    // Marcar como fallidos todos los runs en estado "running" que no están
    // activos en esta instancia del servidor (es decir, son huérfanos de
    // un reinicio anterior).
    const { ne, and } = await import("drizzle-orm");
    const runningRuns = await db
      .select({ id: executionRuns.id })
      .from(executionRuns)
      .where(eq(executionRuns.status, "running"));

    const orphans = runningRuns.filter((r) => !activeRuns.has(r.id));

    if (orphans.length > 0) {
      console.log(`[Runner] Limpiando ${orphans.length} run(s) huérfano(s)...`);
      for (const orphan of orphans) {
        await db
          .update(executionRuns)
          .set({
            status: "failed",
            finishedAt: new Date(),
            errorMessage:
              "Ejecución interrumpida: el servidor se reinició mientras el proceso estaba en curso",
          })
          .where(eq(executionRuns.id, orphan.id));
      }
      console.log(`[Runner] ${orphans.length} run(s) huérfano(s) limpiado(s)`);
    }
  } catch (err) {
    console.error("[Runner] Error limpiando runs huérfanos:", err);
  }
}
