#!/usr/bin/env node
/**
 * Script de inicio para producción.
 * Instala Chromium de Playwright si no está disponible, luego arranca el servidor.
 */
import { execSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Verificar si Chromium de Playwright está disponible
let chromiumAvailable = false;
try {
  const { chromium } = await import('playwright');
  const execPath = chromium.executablePath();
  if (execPath && existsSync(execPath)) {
    chromiumAvailable = true;
    console.log('[start] Chromium disponible en:', execPath);
  }
} catch (e) {
  console.log('[start] Playwright no puede encontrar Chromium:', e.message);
}

// Si no está disponible, intentar instalar
if (!chromiumAvailable) {
  // Verificar rutas del sistema
  const systemPaths = [
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ];
  const systemChromium = systemPaths.find(p => existsSync(p));
  
  if (systemChromium) {
    console.log('[start] Usando Chromium del sistema:', systemChromium);
  } else {
    console.log('[start] Instalando Chromium de Playwright...');
    try {
      execSync('playwright install chromium', { 
        stdio: 'inherit',
        timeout: 300000 // 5 minutos
      });
      console.log('[start] Chromium instalado correctamente');
    } catch (e) {
      console.warn('[start] No se pudo instalar Chromium:', e.message);
      console.warn('[start] El servidor arrancará pero la automatización puede fallar');
    }
  }
}

// Arrancar el servidor principal
console.log('[start] Arrancando servidor...');
const server = spawn('node', ['dist/index.js'], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production' }
});

server.on('exit', (code) => {
  process.exit(code ?? 0);
});

process.on('SIGTERM', () => server.kill('SIGTERM'));
process.on('SIGINT', () => server.kill('SIGINT'));
