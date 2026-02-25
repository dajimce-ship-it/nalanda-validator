/**
 * Worker de automatización de Nalanda.
 * Se ejecuta como proceso hijo con `node worker.mjs` (NO tsx).
 * Recibe los parámetros vía stdin (JSON) y envía logs vía stdout (JSON lines).
 * Esto evita el problema de tsx bloqueando el lanzamiento de Chromium.
 */
import { chromium } from 'playwright';
import { accessSync as _accessSync } from 'fs';

const NALANDA_URL = 'https://app.nalandaglobal.com';
const PENDING_URL = `${NALANDA_URL}/obra-guiada/verObrasConJornadasPendientes.action`;

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
  process.stdout.write(JSON.stringify({ type: 'log', level, message }) + '\n');
}

function sendProgress(percent) {
  process.stdout.write(JSON.stringify({ type: 'progress', percent }) + '\n');
}

function sendResult(summary) {
  process.stdout.write(JSON.stringify({ type: 'result', summary }) + '\n');
}

function sendError(message) {
  process.stdout.write(JSON.stringify({ type: 'error', message }) + '\n');
}

function findChromiumExecutable() {
  const paths = [
    '/usr/bin/chromium-browser',
    '/usr/lib/chromium-browser/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ];
  for (const p of paths) {
    try { _accessSync(p); return p; } catch { /* siguiente */ }
  }
  throw new Error('No se encontró Chromium en el sistema');
}

function getMonthsToReview(monthsBack) {
  const months = [];
  const now = new Date();
  for (let i = 1; i <= monthsBack; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    months.push({ label: `${mm}/${yyyy}`, sampleDate: `15/${mm}/${yyyy}` });
  }
  return months;
}

async function login(page, username, password) {
  sendLog('info', 'Navegando a Nalanda Global...');
  await page.goto(NALANDA_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  const currentUrl = page.url();
  if (currentUrl.includes('app.nalandaglobal.com') && !currentUrl.includes('identity.nalandaglobal.com')) {
    sendLog('success', 'Sesión ya activa, continuando...');
    return;
  }

  await page.waitForSelector('#username', { timeout: 15000 });
  sendLog('info', `Iniciando sesión como ${username}...`);
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
      throw new Error(`Error de login: ${errorText?.trim() || 'Credenciales incorrectas'}`);
    }
    throw new Error('Timeout esperando redirección tras login');
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
        days.push(`${day}/${String(month).padStart(2, '0')}/${yr}`);
      }
    });
    return days;
  });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  return redDays;
}

async function processDay(page, date, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      sendLog('info', `Procesando día ${date}...`);
      await page.goto(`${PENDING_URL}?fechaStr=${date}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(1000);

      const bodyText = await page.evaluate(() => document.body.textContent || '');
      if (bodyText.includes('There are no works with pending days') || bodyText.includes('no hay obras')) {
        sendLog('info', `Día ${date}: sin partes pendientes`);
        return { date, workersValidated: 0, obras: [] };
      }

      const validateButtons = await page.$$('a:has-text("Validate working days"), button:has-text("Validate working days")');
      if (validateButtons.length === 0) {
        sendLog('warning', `Día ${date}: no se encontraron botones de validación`);
        return { date, workersValidated: 0, obras: [] };
      }

      const obras = [];
      let totalWorkers = 0;
      const numObras = validateButtons.length;
      sendLog('info', `Día ${date}: ${numObras} obra(s) con partes pendientes`);

      for (let i = 0; i < numObras; i++) {
        await page.goto(`${PENDING_URL}?fechaStr=${date}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await page.waitForTimeout(1000);

        const btns = await page.$$('a:has-text("Validate working days"), button:has-text("Validate working days")');
        if (i >= btns.length) break;

        const obraName = await btns[i].evaluate(el => {
          const row = el.closest('tr') || el.closest('div') || el.parentElement;
          return row?.textContent?.replace(/\s+/g, ' ').trim().substring(0, 80) || 'Obra';
        });

        sendLog('info', `  Obra ${i + 1}/${numObras}: validando...`);
        await btns[i].click();

        try {
          await page.waitForURL(url => url.toString().includes('mostrarJornadasValidables'), { timeout: 12000 });
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
            if (!await cb.isChecked()) await cb.check();
          }
        }

        const checkedCount = await page.$$eval('tbody input[type="checkbox"]:checked', els => els.length);
        totalWorkers += checkedCount;
        sendLog('info', `  → ${checkedCount} trabajadores seleccionados`);

        const validateBtn = await page.$('button:has-text("Validate selected days"), a:has-text("Validate selected days"), #js-validar-seleccionadas');
        if (!validateBtn) throw new Error("No se encontró el botón 'Validate selected days'");
        await validateBtn.click();
        await page.waitForTimeout(1000);

        try {
          const confirmBtn = await page.waitForSelector('#btnConfirmacion, button:has-text("Ok"), button:has-text("OK")', { timeout: 5000 });
          if (confirmBtn) await confirmBtn.click();
          await page.waitForTimeout(800);
        } catch { /* puede no aparecer */ }

        try {
          const okBtn = await page.waitForSelector('button:has-text("Aceptar"), button:has-text("Accept")', { timeout: 5000 });
          if (okBtn) await okBtn.click();
          await page.waitForTimeout(800);
        } catch { /* puede no aparecer */ }

        obras.push(obraName);
        sendLog('success', `  ✓ Obra ${i + 1} validada: ${checkedCount} jornadas`);
      }

      sendLog('success', `Día ${date}: ${totalWorkers} jornadas validadas en ${obras.length} obra(s)`);
      return { date, workersValidated: totalWorkers, obras };

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (attempt < retries) {
        sendLog('warning', `Intento ${attempt}/${retries} fallido para ${date}: ${errMsg}. Reintentando...`);
        await new Promise(r => setTimeout(r, 3000));
      } else {
        sendLog('error', `Error procesando ${date} tras ${retries} intentos: ${errMsg}`);
        return { date, workersValidated: 0, obras: [] };
      }
    }
  }
  return { date, workersValidated: 0, obras: [] };
}

async function main() {
  // Leer parámetros desde stdin
  let inputData = '';
  for await (const chunk of process.stdin) {
    inputData += chunk;
  }

  const { username, password, monthsBack } = JSON.parse(inputData);

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

    // Encontrar Chromium del sistema
    const executablePath = findChromiumExecutable();
    sendLog('info', `Usando Chromium: ${executablePath}`);

    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: CHROMIUM_ARGS,
      timeout: 30000,
    });

    sendLog('success', 'Navegador iniciado correctamente');

    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    // LOGIN
    await login(page, username, password);
    sendProgress(5);

    // MES ACTUAL
    const now = new Date();
    const currentMonthLabel = `${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
    sendLog('info', `Revisando mes actual (${currentMonthLabel})...`);

    await page.goto(PENDING_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);

    let currentRedDays = [];
    try { currentRedDays = await getRedDaysFromCalendar(page); } catch (e) {
      sendLog('warning', `No se pudo leer el calendario: ${e.message}`);
    }

    if (currentRedDays.length > 0) {
      sendLog('info', `Mes actual: ${currentRedDays.length} día(s) pendiente(s): ${currentRedDays.join(', ')}`);
      for (const date of currentRedDays) {
        const daySummary = await processDay(page, date);
        summary.daysByDate.push(daySummary);
        summary.totalValidated += daySummary.workersValidated;
      }
      summary.monthsReviewed.push({ month: currentMonthLabel, pendingFound: true });
    } else {
      sendLog('success', `Mes actual (${currentMonthLabel}): sin partes pendientes`);
      summary.monthsReviewed.push({ month: currentMonthLabel, pendingFound: false });
    }

    sendProgress(15);

    // MESES ANTERIORES
    const monthsToReview = getMonthsToReview(monthsBack);
    for (let i = 0; i < monthsToReview.length; i++) {
      const { label, sampleDate } = monthsToReview[i];
      sendLog('info', `Revisando ${label}...`);

      await page.goto(`${PENDING_URL}?fechaStr=${sampleDate}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1500);

      let redDays = [];
      try { redDays = await getRedDaysFromCalendar(page); } catch (e) {
        sendLog('warning', `No se pudo leer el calendario de ${label}: ${e.message}`);
      }

      if (redDays.length > 0) {
        sendLog('info', `${label}: ${redDays.length} día(s) pendiente(s): ${redDays.join(', ')}`);
        for (const date of redDays) {
          const daySummary = await processDay(page, date);
          summary.daysByDate.push(daySummary);
          summary.totalValidated += daySummary.workersValidated;
        }
        summary.monthsReviewed.push({ month: label, pendingFound: true });
      } else {
        sendLog('success', `${label}: sin partes pendientes`);
        summary.monthsReviewed.push({ month: label, pendingFound: false });
      }

      sendProgress(15 + Math.round(((i + 1) / monthsBack) * 75));
    }

    // VERIFICACIÓN FINAL
    sendLog('info', 'Realizando verificación final del mes actual...');
    await page.goto(PENDING_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);

    let finalRedDays = [];
    try { finalRedDays = await getRedDaysFromCalendar(page); } catch { /* ignorar */ }

    if (finalRedDays.length === 0) {
      sendLog('success', '✓ Verificación final: no quedan partes pendientes');
    } else {
      sendLog('warning', `Verificación final: aún hay ${finalRedDays.length} día(s) en rojo.`);
    }

    sendLog('success', `Proceso completado. Total: ${summary.totalValidated} jornadas validadas en ${summary.daysByDate.filter(d => d.workersValidated > 0).length} día(s)`);
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
