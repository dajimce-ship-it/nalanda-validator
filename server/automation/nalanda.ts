import { chromium, Browser, Page } from "playwright";
import path from "path";

const NALANDA_URL = "https://app.nalandaglobal.com";
const PENDING_URL = `${NALANDA_URL}/obra-guiada/verObrasConJornadasPendientes.action`;
const PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.HOME || "/home/ubuntu", ".playwright");

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

function formatDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
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

async function login(page: Page, username: string, password: string, callbacks: AutomationCallbacks): Promise<boolean> {
  log(callbacks, "info", "Navegando a Nalanda Global...");
  await page.goto(NALANDA_URL, { waitUntil: "networkidle", timeout: 30000 });

  // Esperar a que aparezca el formulario de login
  try {
    await page.waitForSelector("#username", { timeout: 15000 });
  } catch {
    // Ya puede estar logueado
    if (page.url().includes("nalandaglobal.com") && !page.url().includes("identity")) {
      log(callbacks, "success", "Sesión ya activa, continuando...");
      return true;
    }
    throw new Error("No se encontró el formulario de login");
  }

  log(callbacks, "info", `Iniciando sesión como ${username}...`);
  await page.fill("#username", username);
  await page.fill("#password", password);
  await page.click("#kc-login");

  try {
    await page.waitForURL((url) => !url.toString().includes("identity.nalandaglobal.com"), { timeout: 15000 });
    log(callbacks, "success", "Login completado correctamente");
    return true;
  } catch {
    const errorEl = await page.$(".alert-error, .kc-feedback-text");
    if (errorEl) {
      const errorText = await errorEl.textContent();
      throw new Error(`Error de login: ${errorText?.trim() || "Credenciales incorrectas"}`);
    }
    throw new Error("Timeout esperando redirección tras login");
  }
}

async function getRedDaysInCalendar(page: Page): Promise<string[]> {
  // Abrir el calendario
  await page.click("#fecha");
  await page.waitForSelector(".ui-datepicker-calendar", { timeout: 5000 });

  const redDays = await page.evaluate(() => {
    const cal = document.querySelector(".ui-datepicker-calendar");
    if (!cal) return [];
    const days: string[] = [];
    Array.from(cal.querySelectorAll('td[data-handler="selectDay"]')).forEach((td) => {
      const a = (td as HTMLElement).querySelector("a");
      if (!a) return;
      const bg = window.getComputedStyle(a).backgroundColor;
      if (bg === "rgb(255, 0, 0)") {
        const month = parseInt((td as HTMLElement).getAttribute("data-month") || "0") + 1;
        const yr = (td as HTMLElement).getAttribute("data-year") || "";
        const day = a.textContent?.trim().padStart(2, "0") || "";
        days.push(`${day}/${String(month).padStart(2, "0")}/${yr}`);
      }
    });
    return days;
  });

  // Cerrar el calendario
  await page.keyboard.press("Escape");
  return redDays;
}

async function navigateCalendarToPrevMonth(page: Page): Promise<void> {
  await page.click("#fecha");
  await page.waitForSelector(".ui-datepicker-prev", { timeout: 5000 });
  await page.click(".ui-datepicker-prev");
  await page.waitForTimeout(500);
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
      await page.goto(`${PENDING_URL}?fechaStr=${date}`, { waitUntil: "networkidle", timeout: 20000 });

      // Verificar si hay obras pendientes
      const noPending = await page.$eval(
        "body",
        (el) => el.textContent?.includes("There are no works with pending days") || false
      );
      if (noPending) {
        log(callbacks, "info", `Día ${date}: sin partes pendientes`);
        return { date, workersValidated: 0, obras: [] };
      }

      // Buscar botones de validación
      const validateButtons = await page.$$('a:has-text("Validate working days"), button:has-text("Validate working days")');
      if (validateButtons.length === 0) {
        log(callbacks, "warning", `Día ${date}: no se encontraron botones de validación`);
        return { date, workersValidated: 0, obras: [] };
      }

      const obras: string[] = [];
      let totalWorkers = 0;

      // Procesar cada obra del día
      for (let i = 0; i < validateButtons.length; i++) {
        // Recargar los botones en cada iteración (el DOM puede cambiar)
        await page.goto(`${PENDING_URL}?fechaStr=${date}`, { waitUntil: "networkidle", timeout: 20000 });
        const btns = await page.$$('a:has-text("Validate working days"), button:has-text("Validate working days")');
        if (i >= btns.length) break;

        // Obtener nombre de la obra si está disponible
        const obraName = await btns[i].evaluate((el) => {
          const row = el.closest("tr") || el.closest(".obra-row") || el.parentElement;
          return row?.textContent?.trim().substring(0, 60) || "Obra desconocida";
        });

        await btns[i].click();
        await page.waitForURL((url) => url.toString().includes("mostrarJornadasValidables"), { timeout: 10000 });

        // Seleccionar todos los trabajadores
        const headerCheckbox = await page.$('thead input[type="checkbox"]');
        if (headerCheckbox) {
          await headerCheckbox.click();
          await page.waitForTimeout(300);
        } else {
          // Seleccionar individualmente
          const checkboxes = await page.$$('tbody input[type="checkbox"]');
          for (const cb of checkboxes) {
            await cb.check();
          }
        }

        // Contar trabajadores seleccionados
        const checkedCount = await page.$$eval('tbody input[type="checkbox"]:checked', (els) => els.length);
        totalWorkers += checkedCount;

        log(callbacks, "info", `  → ${checkedCount} trabajadores seleccionados`);

        // Hacer clic en "Validate selected days"
        const validateBtn = await page.$('button:has-text("Validate selected days"), a:has-text("Validate selected days"), #js-validar-seleccionadas');
        if (!validateBtn) {
          // Intentar con texto alternativo
          const altBtn = await page.$('[id*="validar"], [class*="validar-btn"]');
          if (altBtn) await altBtn.click();
          else throw new Error("No se encontró el botón de validación");
        } else {
          await validateBtn.click();
        }

        // Confirmar primer diálogo
        try {
          await page.waitForSelector('#btnConfirmacion, button:has-text("Ok"), button:has-text("Aceptar")', { timeout: 5000 });
          const confirmBtn = await page.$('#btnConfirmacion, button:has-text("Ok")');
          if (confirmBtn) await confirmBtn.click();
          await page.waitForTimeout(500);
        } catch { /* puede no aparecer */ }

        // Confirmar segundo diálogo
        try {
          await page.waitForSelector('button:has-text("Aceptar"), button:has-text("OK")', { timeout: 5000 });
          const okBtn = await page.$('button:has-text("Aceptar"), button:has-text("OK")');
          if (okBtn) await okBtn.click();
          await page.waitForTimeout(500);
        } catch { /* puede no aparecer */ }

        obras.push(obraName.replace(/\s+/g, " ").trim());
        log(callbacks, "success", `  ✓ Obra validada: ${checkedCount} trabajadores`);
      }

      log(callbacks, "success", `Día ${date}: ${totalWorkers} jornadas validadas en ${obras.length} obra(s)`);
      return { date, workersValidated: totalWorkers, obras };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (attempt < retries) {
        log(callbacks, "warning", `Intento ${attempt}/${retries} fallido para ${date}: ${errMsg}. Reintentando...`);
        await page.waitForTimeout(2000);
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

  try {
    log(callbacks, "info", "Iniciando navegador...");
    browser = await chromium.launch({
      headless: true,
      executablePath: `${PLAYWRIGHT_BROWSERS_PATH}/chromium_headless_shell-1208/chrome-linux/headless_shell`,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    // Login
    await login(page, username, password, callbacks);

    // === MES ACTUAL ===
    log(callbacks, "info", "Revisando mes actual...");
    await page.goto(PENDING_URL, { waitUntil: "networkidle", timeout: 20000 });

    const currentDate = new Date();
    const currentMonthLabel = `${String(currentDate.getMonth() + 1).padStart(2, "0")}/${currentDate.getFullYear()}`;

    await page.click("#fecha");
    await page.waitForSelector(".ui-datepicker-calendar", { timeout: 5000 });

    const currentRedDays = await page.evaluate(() => {
      const cal = document.querySelector(".ui-datepicker-calendar");
      if (!cal) return [];
      const days: string[] = [];
      Array.from(cal.querySelectorAll('td[data-handler="selectDay"]')).forEach((td) => {
        const a = (td as HTMLElement).querySelector("a");
        if (!a) return;
        const bg = window.getComputedStyle(a).backgroundColor;
        if (bg === "rgb(255, 0, 0)") {
          const month = parseInt((td as HTMLElement).getAttribute("data-month") || "0") + 1;
          const yr = (td as HTMLElement).getAttribute("data-year") || "";
          const day = a.textContent?.trim().padStart(2, "0") || "";
          days.push(`${day}/${String(month).padStart(2, "0")}/${yr}`);
        }
      });
      return days;
    });

    await page.keyboard.press("Escape");

    if (currentRedDays.length > 0) {
      log(callbacks, "info", `Mes actual: ${currentRedDays.length} día(s) pendiente(s) encontrado(s): ${currentRedDays.join(", ")}`);
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

    // === MESES ANTERIORES ===
    const monthsToReview = getMonthsToReview(monthsBack);

    for (let i = 0; i < monthsToReview.length; i++) {
      const { label, sampleDate } = monthsToReview[i];
      log(callbacks, "info", `Revisando ${label}...`);

      await page.goto(`${PENDING_URL}?fechaStr=${sampleDate}`, { waitUntil: "networkidle", timeout: 20000 });

      // Abrir calendario y navegar al mes correcto
      await page.click("#fecha");
      await page.waitForSelector(".ui-datepicker-calendar", { timeout: 5000 });

      // El calendario debería mostrar el mes del sampleDate
      const redDays = await page.evaluate(() => {
        const cal = document.querySelector(".ui-datepicker-calendar");
        if (!cal) return [];
        const days: string[] = [];
        Array.from(cal.querySelectorAll('td[data-handler="selectDay"]')).forEach((td) => {
          const a = (td as HTMLElement).querySelector("a");
          if (!a) return;
          const bg = window.getComputedStyle(a).backgroundColor;
          if (bg === "rgb(255, 0, 0)") {
            const month = parseInt((td as HTMLElement).getAttribute("data-month") || "0") + 1;
            const yr = (td as HTMLElement).getAttribute("data-year") || "";
            const day = a.textContent?.trim().padStart(2, "0") || "";
            days.push(`${day}/${String(month).padStart(2, "0")}/${yr}`);
          }
        });
        return days;
      });

      await page.keyboard.press("Escape");

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

      callbacks.onProgress?.(Math.round(((i + 2) / (monthsBack + 2)) * 100));
    }

    // === VERIFICACIÓN FINAL ===
    log(callbacks, "info", "Realizando verificación final...");
    await page.goto(PENDING_URL, { waitUntil: "networkidle", timeout: 20000 });
    await page.click("#fecha");
    await page.waitForSelector(".ui-datepicker-calendar", { timeout: 5000 });

    const finalRedDays = await page.evaluate(() => {
      const cal = document.querySelector(".ui-datepicker-calendar");
      if (!cal) return [];
      const days: string[] = [];
      Array.from(cal.querySelectorAll('td[data-handler="selectDay"]')).forEach((td) => {
        const a = (td as HTMLElement).querySelector("a");
        if (!a) return;
        const bg = window.getComputedStyle(a).backgroundColor;
        if (bg === "rgb(255, 0, 0)") days.push("found");
      });
      return days;
    });

    await page.keyboard.press("Escape");

    if (finalRedDays.length === 0) {
      log(callbacks, "success", "✓ Verificación final: no quedan partes pendientes en el mes actual");
    } else {
      log(callbacks, "warning", `Verificación final: aún hay ${finalRedDays.length} día(s) en rojo. Puede requerir revisión manual.`);
    }

    log(callbacks, "success", `Proceso completado. Total: ${summary.totalValidated} jornadas validadas en ${summary.daysByDate.filter(d => d.workersValidated > 0).length} día(s)`);
    callbacks.onProgress?.(100);

    return summary;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
