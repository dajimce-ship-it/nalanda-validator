#!/usr/bin/env node
/**
 * Script de inicio para producción.
 * Verifica que Chromium esté disponible antes de arrancar el servidor.
 * En Railway/Docker, Chromium ya está instalado en PLAYWRIGHT_BROWSERS_PATH.
 * En otros entornos, intenta instalarlo automáticamente.
 */
import { execSync } from 'child_process';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

function log(msg) {
  console.log(`[start] ${msg}`);
}

async function ensureChromium() {
  // 1. Verificar rutas del sistema (Linux) - disponibles en dev/sandbox
  const systemPaths = [
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/local/bin/chromium',
  ];
  for (const p of systemPaths) {
    if (existsSync(p)) {
      log(`Chromium del sistema encontrado: ${p}`);
      return;
    }
  }

  // 2. Verificar si Playwright ya tiene su propio Chromium instalado
  // (respeta PLAYWRIGHT_BROWSERS_PATH si está configurado)
  try {
    const { chromium } = await import('playwright');
    const execPath = chromium.executablePath();
    if (execPath && existsSync(execPath)) {
      log(`Chromium de Playwright encontrado: ${execPath}`);
      return;
    }
    log(`Chromium de Playwright NO encontrado en: ${execPath}`);
    log(`PLAYWRIGHT_BROWSERS_PATH = ${process.env.PLAYWRIGHT_BROWSERS_PATH || '(no configurado)'}`);
  } catch (e) {
    log(`No se pudo verificar Chromium de Playwright: ${e.message}`);
  }

  // 3. No hay Chromium disponible → instalar en la ruta configurada
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH || join(process.cwd(), '.browsers');
  log(`Instalando Chromium en: ${browsersPath}`);
  log('Esto solo ocurre la primera vez y puede tardar 1-2 minutos...');
  
  try {
    execSync('npx playwright install chromium --with-deps', {
      stdio: 'inherit',
      timeout: 300000, // 5 minutos
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: browsersPath,
      },
    });
    log('Chromium instalado correctamente');
  } catch (e) {
    log(`Error instalando con --with-deps, intentando sin dependencias del sistema...`);
    try {
      execSync('npx playwright install chromium', {
        stdio: 'inherit',
        timeout: 300000,
        env: {
          ...process.env,
          PLAYWRIGHT_BROWSERS_PATH: browsersPath,
        },
      });
      log('Chromium instalado correctamente (sin dependencias del sistema)');
    } catch (e2) {
      log(`ADVERTENCIA: No se pudo instalar Chromium: ${e2.message}`);
      log('El servidor arrancará pero la automatización puede fallar');
    }
  }
}

// Ejecutar verificación de Chromium
await ensureChromium();

// Arrancar el servidor principal
log('Arrancando servidor...');
const server = spawn('node', ['dist/index.js'], {
  stdio: 'inherit',
  env: { ...process.env },
});

server.on('exit', (code) => {
  process.exit(code ?? 0);
});

process.on('SIGTERM', () => server.kill('SIGTERM'));
process.on('SIGINT', () => server.kill('SIGINT'));
