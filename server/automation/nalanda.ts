import { Browser, BrowserContext, Page, chromium } from "playwright";
import { execSync } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
const sleep = promisify(setTimeout);

const NALANDA_URL = "https://app.nalandaglobal.com";
const PENDING_URL = `${NALANDA_URL}/obra-guiada/verObrasConJornadasPendientes.action`;

export type LogLevel = "info" | "success" | "warning" | "error";

export type LogEntry = {
  level: LogLevel;
  message: string;
  timestamp: Date;
};

export type DaySummary = {
  date: string;
  workersValidated: number;
  obras: string[];
};

export type RunSummary = {
  totalValidated: number;
  daysByDate: DaySummary[];
  monthsReviewed: { month: string; pendingFound: boolean }[];
  errors: string[];
};

export type AutomationCallbacks = {
  onLog: (entry: LogEntry) => void;
  onProgress?: (percent: number) => void;
};

function log(callbacks: AutomationCallbacks, level: LogLevel, message: string) {
  callbacks.onLog({ level, message, timestamp: new Date() });
}

function getMonthsToReview(monthsBack: number): { label: string; sampleDate: string }[] {
  const months = [];
  const now = new Date();
  for (let i = 1; i <= monthsBack; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    months.push({
      label: `${mm}/${yyyy}`,
      sampleDate: `15/${mm}/${yyyy}`,
    });
  }
  return months;
}

/**
 * Obtiene el ejecutable de Chromium de forma robusta.
 * 1. Usa chromium.executablePath() de Playwright (siempre correcto para el entorno actual)
 * 2. Si el archivo no existe, instala Chromium automáticamente con npx playwright install
 * 3. Devuelve la ruta verificada
 */
async function getChromiumExecutable(callbacks: AutomationCallbacks): Promise<string> {
  // Obtener la ruta que Playwright espera para este entorno
  const execPath = chromium.executablePath();
  log(callbacks, "info", `Ruta Playwright Chromium: ${execPath}`);

  if (existsSync(execPath)) {
    log(callbacks, "success", `Chromium encontrado en: ${execPath}`);
    return execPath;
  }

  // No existe → instalar automáticamente
  log(callbacks, "warning", "Chromium no encontrado. Instalando automáticamente (puede tardar 1-2 min)...");
  try {
    execSync("npx playwright install chromium --with-deps", {
      stdio: "pipe",
      timeout: 120000,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: process.env.HOME + "/.playwright" },
    });
    log(callbacks, "success", "Chromium instalado correctamente");
  } catch (installErr) {
    // Intentar sin --with-deps (por si falta permisos para deps del sistema)
    try {
      execSync("npx playwright install chromium", {
        stdio: "pipe",
        timeout: 120000,
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: process.env.HOME + "/.playwright" },
      });
      log(callbacks, "success", "Chromium instalado (sin deps del sistema)");
    } catch (e2) {
      throw new Error(`No se pudo instalar Chromium: ${e2 instanceof Error ? e2.message : e2}`);
    }
  }

  // Verificar que ahora sí existe
  const newPath = chromium.executablePath();
  if (!existsSync(newPath)) {
    throw new Error(`Chromium instalado pero no encontrado en: ${newPath}`);
  }
  return newPath;
}

async function login(page: Page, username: string, password: string, callbacks: AutomationCallbacks): Promise<void> {
  log(callbacks, "info", "Navegando a Nalanda Global...");
  await page.goto(NALANDA_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);

  const currentUrl = page.url();
  if (currentUrl.includes("app.nalandaglobal.com") && !currentUrl.includes("identity.nalandaglobal.com")) {
    log(callbacks, "success", "Sesión ya activa, continuando...");
    return;
  }

  try {
    await page.waitForSelector("#username", { timeout: 15000 });
  } catch {
    throw new Error("No se encontró el formulario de login de Nalanda");
  }

  log(callbacks, "info", `Iniciando sesión como ${username}...`);
  await page.fill("#username", "");
  await page.fill("#username", username);
  await page.fill("#password", "");
  await page.fill("#password", password);
  await page.click("#kc-login");

  try {
    await page.waitForURL(
      (url) => !url.toString().includes("identity.nalandaglobal.com"),
      { timeout: 20000 }
    );
    log(callbacks, "success", "Login completado correctamente");
  } catch {
    const errorEl = await page.$(".alert-error, .kc-feedback-text");
    if (errorEl) {
      const errorText = await errorEl.textContent();
      throw new Error(`Error de login: ${errorText?.trim() || "Credenciales incorrectas"}`);
    }
    throw new Error("Timeout esperando redirección tras login");
  }
}

async function getRedDaysFromCalendar(page: Page): Promise<string[]> {
  await page.click("#fecha");
  await page.waitForSelector(".ui-datepicker-calendar", { timeout: 8000 });
  await page.waitForTimeout(500);

  const redDays = await page.evaluate(() => {
    const cal = document.querySelector(".ui-datepicker-calendar");
    if (!cal) return [];
    const days: string[] = [];
    Array.from(cal.querySelectorAll('td[data-handler="selectDay"]')).forEach((td) => {
      const a = (td as HTMLElement).querySelector("a");
      if (!a) return;
      const bg = window.getComputedStyle(a).backgroundColor;
      if (bg === "rgb(255, 0, 0)" || bg === "rgb(220, 53, 69)" || bg === "rgb(255, 68, 68)") {
        const month = parseInt((td as HTMLElement).getAttribute("data-month") || "0") + 1;
        const yr = (td as HTMLElement).getAttribute("data-year") || "";
        const day = a.textContent?.trim().padStart(2, "0") || "";
        days.push(`${day}/${String(month).padStart(2, "0")}/${yr}`);
      }
    });
    return days;
  });

  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  return redDays;
}

async function processDay(
  page: Page,
  date: string,
  callbacks: AutomationCallbacks,
  retries = 3
): Promise<DaySummary> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      log(callbacks, "info", `Procesando día ${date}...`);
      await page.goto(`${PENDING_URL}?fechaStr=${date}`, { waitUntil: "domcontentloaded", timeout: 25000 });
      await page.waitForTimeout(1000);

      const bodyText = await page.evaluate(() => document.body.textContent || "");
      if (bodyText.includes("There are no works with pending days") || bodyText.includes("no hay obras")) {
        log(callbacks, "info", `Día ${date}: sin partes pendientes`);
        return { date, workersValidated: 0, obras: [] };
      }

      const validateButtons = await page.$$('a:has-text("Validate working days"), button:has-text("Validate working days")');
      if (validateButtons.length === 0) {
        log(callbacks, "warning", `Día ${date}: no se encontraron botones de validación`);
        return { date, workersValidated: 0, obras: [] };
      }

      const obras: string[] = [];
      let totalWorkers = 0;
      const numObras = validateButtons.length;
      log(callbacks, "info", `Día ${date}: ${numObras} obra(s) con partes pendientes`);

      for (let i = 0; i < numObras; i++) {
        await page.goto(`${PENDING_URL}?fechaStr=${date}`, { waitUntil: "domcontentloaded", timeout: 25000 });
        await page.waitForTimeout(1000);

        const btns = await page.$$('a:has-text("Validate working days"), button:has-text("Validate working days")');
        if (i >= btns.length) break;

        const obraName = await btns[i].evaluate((el) => {
          const row = el.closest("tr") || el.closest("div") || el.parentElement;
          return row?.textContent?.replace(/\s+/g, " ").trim().substring(0, 80) || "Obra";
        });

        log(callbacks, "info", `  Obra ${i + 1}/${numObras}: validando...`);
        await btns[i].click();

        try {
          await page.waitForURL((url) => url.toString().includes("mostrarJornadasValidables"), { timeout: 12000 });
        } catch {
          await page.waitForTimeout(2000);
        }

        const headerCheckbox = await page.$('thead input[type="checkbox"]');
        if (headerCheckbox) {
          await headerCheckbox.click();
          await page.waitForTimeout(500);
        } else {
          const checkboxes = await page.$$('tbody input[type="checkbox"]');
          for (const cb of checkboxes) {
            const isChecked = await cb.isChecked();
            if (!isChecked) await cb.check();
          }
        }

        const checkedCount = await page.$$eval('tbody input[type="checkbox"]:checked', (els) => els.length);
        totalWorkers += checkedCount;
        log(callbacks, "info", `  → ${checkedCount} trabajadores seleccionados`);

        const validateBtn = await page.$(
          'button:has-text("Validate selected days"), a:has-text("Validate selected days"), #js-validar-seleccionadas'
        );
        if (!validateBtn) throw new Error("No se encontró el botón 'Validate selected days'");
        await validateBtn.click();
        await page.waitForTimeout(1000);

        try {
          const confirmBtn = await page.waitForSelector(
            '#btnConfirmacion, button:has-text("Ok"), button:has-text("OK")',
            { timeout: 5000 }
          );
          if (confirmBtn) await confirmBtn.click();
          await page.waitForTimeout(800);
        } catch { /* puede no aparecer */ }

        try {
          const okBtn = await page.waitForSelector(
            'button:has-text("Aceptar"), button:has-text("Accept")',
            { timeout: 5000 }
          );
          if (okBtn) await okBtn.click();
          await page.waitForTimeout(800);
        } catch { /* puede no aparecer */ }

        obras.push(obraName);
        log(callbacks, "success", `  ✓ Obra ${i + 1} validada: ${checkedCount} jornadas`);
      }

      log(callbacks, "success", `Día ${date}: ${totalWorkers} jornadas validadas en ${obras.length} obra(s)`);
      return { date, workersValidated: totalWorkers, obras };

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (attempt < retries) {
        log(callbacks, "warning", `Intento ${attempt}/${retries} fallido para ${date}: ${errMsg}. Reintentando...`);
        await page.waitForTimeout(3000);
      } else {
        log(callbacks, "error", `Error procesando ${date} tras ${retries} intentos: ${errMsg}`);
        return { date, workersValidated: 0, obras: [] };
      }
    }
  }
  return { date, workersValidated: 0, obras: [] };
}

export async function runNalandaAutomation(
  username: string,
  password: string,
  monthsBack: number = 6,
  callbacks: AutomationCallbacks
): Promise<RunSummary> {
  const summary: RunSummary = {
    totalValidated: 0,
    daysByDate: [],
    monthsReviewed: [],
    errors: [],
  };

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    log(callbacks, "info", "Iniciando navegador...");

    // Obtener ejecutable de Chromium de forma robusta (con auto-install si falta)
    const executablePath = await getChromiumExecutable(callbacks);

    // Lanzar Chromium directamente con Playwright (sin depender de CDP externo)
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--metrics-recording-only",
        "--disable-default-apps",
      ],
    });

    log(callbacks, "success", "Navegador iniciado correctamente");

    context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    // === LOGIN ===
    await login(page, username, password, callbacks);
    callbacks.onProgress?.(5);

    // === MES ACTUAL ===
    const currentDate = new Date();
    const currentMonthLabel = `${String(currentDate.getMonth() + 1).padStart(2, "0")}/${currentDate.getFullYear()}`;
    log(callbacks, "info", `Revisando mes actual (${currentMonthLabel})...`);

    await page.goto(PENDING_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(1500);

    let currentRedDays: string[] = [];
    try {
      currentRedDays = await getRedDaysFromCalendar(page);
    } catch (e) {
      log(callbacks, "warning", `No se pudo leer el calendario del mes actual: ${e instanceof Error ? e.message : e}`);
    }

    if (currentRedDays.length > 0) {
      log(callbacks, "info", `Mes actual: ${currentRedDays.length} día(s) pendiente(s): ${currentRedDays.join(", ")}`);
      for (const date of currentRedDays) {
        const daySummary = await processDay(page, date, callbacks);
        summary.daysByDate.push(daySummary);
        summary.totalValidated += daySummary.workersValidated;
      }
      summary.monthsReviewed.push({ month: currentMonthLabel, pendingFound: true });
    } else {
      log(callbacks, "success", `Mes actual (${currentMonthLabel}): sin partes pendientes`);
      summary.monthsReviewed.push({ month: currentMonthLabel, pendingFound: false });
    }

    callbacks.onProgress?.(15);

    // === MESES ANTERIORES ===
    const monthsToReview = getMonthsToReview(monthsBack);

    for (let i = 0; i < monthsToReview.length; i++) {
      const { label, sampleDate } = monthsToReview[i];
      log(callbacks, "info", `Revisando ${label}...`);

      await page.goto(`${PENDING_URL}?fechaStr=${sampleDate}`, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(1500);

      let redDays: string[] = [];
      try {
        redDays = await getRedDaysFromCalendar(page);
      } catch (e) {
        log(callbacks, "warning", `No se pudo leer el calendario de ${label}: ${e instanceof Error ? e.message : e}`);
      }

      if (redDays.length > 0) {
        log(callbacks, "info", `${label}: ${redDays.length} día(s) pendiente(s): ${redDays.join(", ")}`);
        for (const date of redDays) {
          const daySummary = await processDay(page, date, callbacks);
          summary.daysByDate.push(daySummary);
          summary.totalValidated += daySummary.workersValidated;
        }
        summary.monthsReviewed.push({ month: label, pendingFound: true });
      } else {
        log(callbacks, "success", `${label}: sin partes pendientes`);
        summary.monthsReviewed.push({ month: label, pendingFound: false });
      }

      callbacks.onProgress?.(15 + Math.round(((i + 1) / monthsBack) * 75));
    }

    // === VERIFICACIÓN FINAL ===
    log(callbacks, "info", "Realizando verificación final del mes actual...");
    await page.goto(PENDING_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(1500);

    let finalRedDays: string[] = [];
    try {
      finalRedDays = await getRedDaysFromCalendar(page);
    } catch { /* ignorar */ }

    if (finalRedDays.length === 0) {
      log(callbacks, "success", "✓ Verificación final: no quedan partes pendientes");
    } else {
      log(callbacks, "warning", `Verificación final: aún hay ${finalRedDays.length} día(s) en rojo. Puede requerir revisión manual.`);
    }

    log(
      callbacks,
      "success",
      `Proceso completado. Total: ${summary.totalValidated} jornadas validadas en ${summary.daysByDate.filter((d) => d.workersValidated > 0).length} día(s)`
    );
    callbacks.onProgress?.(100);

    return summary;
  } finally {
    if (context) {
      try { await context.close(); } catch { /* ignorar */ }
    }
    if (browser) {
      try { await browser.close(); } catch { /* ignorar */ }
    }
  }
}
