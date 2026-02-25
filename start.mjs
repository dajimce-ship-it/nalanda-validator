#!/usr/bin/env node
/**
 * Script de inicio para producción.
 * Garantiza que Chromium de Playwright esté disponible antes de arrancar el servidor.
 * No depende de NODE_ENV - verifica directamente si el ejecutable existe.
 */
import { execSync } from 'child_process';
import { spawn } from 'child_process';
import { existsSync } from 'fs';

function log(msg) {
  console.log(`[start] ${msg}`);
}

async function ensureChromium() {
  // 1. Verificar rutas del sistema (Linux)
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
  try {
    const { chromium } = await import('playwright');
    const execPath = chromium.executablePath();
    if (execPath && existsSync(execPath)) {
      log(`Chromium de Playwright encontrado: ${execPath}`);
      return;
    }
    log(`Chromium de Playwright NO encontrado en: ${execPath}`);
  } catch (e) {
    log(`No se pudo verificar Chromium de Playwright: ${e.message}`);
  }

  // 3. No hay Chromium disponible → instalar
  log('Instalando Chromium de Playwright (primera ejecución en este servidor)...');
  try {
    execSync('npx playwright install chromium', {
      stdio: 'inherit',
      timeout: 300000, // 5 minutos
    });
    log('Chromium instalado correctamente');
  } catch (e) {
    log(`ADVERTENCIA: No se pudo instalar Chromium: ${e.message}`);
    log('El servidor arrancará pero la automatización puede fallar al intentar lanzar el navegador');
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
