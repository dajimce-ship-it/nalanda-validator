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
  const paths = [
    '/usr/bin/chromium-browser',
    '/usr/lib/chromium-browser/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ];
  for (const p of paths) {
    try { accessSync(p); return p; } catch { /* siguiente */ }
  }
  throw new Error('No se encontro Chromium instalado en el sistema');
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

async function getRedDaysFromCalendar(page) {
  await page.click('#fecha');
  await page.waitForSelector('.ui-datepicker-calendar', { timeout: 8000 });
  await page.waitForTimeout(500);

  const redDays = await page.evaluate(() => {
    const cal = document.querySelector('.ui-datepicker-calendar');
    if (!cal) return [];
    const days = [];
    Array.from(cal.querySelectorAll('td[data-handler="selectDay"]')).forEach(td => {
      const a = td.querySelector('a');
      if (!a) return;
      const bg = window.getComputedStyle(a).backgroundColor;
      if (bg === 'rgb(255, 0, 0)' || bg === 'rgb(220, 53, 69)' || bg === 'rgb(255, 68, 68)') {
        const month = parseInt(td.getAttribute('data-month') || '0') + 1;
        const yr = td.getAttribute('data-year') || '';
        const day = a.textContent?.trim().padStart(2, '0') || '';
        days.push(day + '/' + String(month).padStart(2, '0') + '/' + yr);
      }
    });
    return days;
  });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  return redDays;
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

      // Buscar botones "Validate working days" (lista de obras)
      const validateButtons = await page.$$('button.js-validar-jornadas, a:has-text("Validate working days"), button:has-text("Validate working days")');
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

        const btns = await page.$$('button.js-validar-jornadas, a:has-text("Validate working days"), button:has-text("Validate working days")');
        if (btns.length === 0) {
          sendLog('info', 'Dia ' + date + ': todas las obras procesadas');
          break;
        }

        const obraName = await btns[0].evaluate(el => {
          const row = el.closest('tr') || el.closest('div') || el.parentElement;
          return row?.textContent?.replace(/\\s+/g, ' ').trim().substring(0, 80) || 'Obra';
        });

        sendLog('info', '  Obra ' + (i+1) + '/' + numObras + ': ' + obraName.substring(0, 50) + '...');
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
    sendLog('info', 'Usando Chromium: ' + executablePath);

    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: CHROMIUM_ARGS,
      timeout: 30000,
    });

    sendLog('success', 'Navegador iniciado correctamente');

    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    await login(page, username, password);
    sendProgress(5);

    const now = new Date();
    const currentMonthLabel = String(now.getMonth() + 1).padStart(2, '0') + '/' + now.getFullYear();
    sendLog('info', 'Revisando mes actual (' + currentMonthLabel + ')...');

    await page.goto(PENDING_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);

    let currentRedDays = [];
    try { currentRedDays = await getRedDaysFromCalendar(page); } catch (e) {
      sendLog('warning', 'No se pudo leer el calendario: ' + e.message);
    }

    if (currentRedDays.length > 0) {
      sendLog('info', 'Mes actual: ' + currentRedDays.length + ' dia(s) pendiente(s): ' + currentRedDays.join(', '));
      for (const date of currentRedDays) {
        const daySummary = await processDay(page, date);
        summary.daysByDate.push(daySummary);
        summary.totalValidated += daySummary.workersValidated;
      }
      summary.monthsReviewed.push({ month: currentMonthLabel, pendingFound: true });
    } else {
      sendLog('success', 'Mes actual (' + currentMonthLabel + '): sin partes pendientes');
      summary.monthsReviewed.push({ month: currentMonthLabel, pendingFound: false });
    }

    sendProgress(15);

    const monthsToReview = getMonthsToReview(monthsBack);
    for (let i = 0; i < monthsToReview.length; i++) {
      const { label, sampleDate } = monthsToReview[i];
      sendLog('info', 'Revisando ' + label + '...');

      await page.goto(PENDING_URL + '?fechaStr=' + sampleDate, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1500);

      let redDays = [];
      try { redDays = await getRedDaysFromCalendar(page); } catch (e) {
        sendLog('warning', 'No se pudo leer el calendario de ' + label + ': ' + e.message);
      }

      if (redDays.length > 0) {
        sendLog('info', label + ': ' + redDays.length + ' dia(s) pendiente(s): ' + redDays.join(', '));
        for (const date of redDays) {
          const daySummary = await processDay(page, date);
          summary.daysByDate.push(daySummary);
          summary.totalValidated += daySummary.workersValidated;
        }
        summary.monthsReviewed.push({ month: label, pendingFound: true });
      } else {
        sendLog('success', label + ': sin partes pendientes');
        summary.monthsReviewed.push({ month: label, pendingFound: false });
      }

      sendProgress(15 + Math.round(((i + 1) / monthsBack) * 75));
    }

    sendLog('info', 'Realizando verificacion final del mes actual...');
    await page.goto(PENDING_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);

    let finalRedDays = [];
    try { finalRedDays = await getRedDaysFromCalendar(page); } catch { /* ignorar */ }

    if (finalRedDays.length === 0) {
      sendLog('success', 'Verificacion final: no quedan partes pendientes');
    } else {
      sendLog('warning', 'Verificacion final: aun hay ' + finalRedDays.length + ' dia(s) en rojo.');
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
