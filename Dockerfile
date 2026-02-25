# ============================================================
# Nalanda Validator - Dockerfile para Railway
# Incluye todas las dependencias del sistema para Chromium/Playwright
# ============================================================

FROM node:22-bookworm-slim AS base

# Instalar dependencias del sistema necesarias para Chromium/Playwright
# Estas librerías son las que faltan en el servidor de producción de Manus
RUN apt-get update && apt-get install -y --no-install-recommends \
  # Chromium core dependencies
  libnss3 \
  libnspr4 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libdrm2 \
  libxkbcommon0 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxrandr2 \
  libgbm1 \
  libasound2 \
  libpango-1.0-0 \
  libcairo2 \
  libatspi2.0-0 \
  libx11-6 \
  libxext6 \
  libxcb1 \
  libx11-xcb1 \
  # Fonts for rendering web pages
  fonts-liberation \
  fonts-noto-color-emoji \
  # Utilities
  ca-certificates \
  wget \
  && rm -rf /var/lib/apt/lists/*

# Instalar pnpm globalmente
RUN npm install -g pnpm@10.4.1

# ============================================================
# Etapa de dependencias
# ============================================================
FROM base AS deps

WORKDIR /usr/src/app

# Copiar archivos de dependencias
COPY package.json pnpm-lock.yaml ./
COPY patches/ ./patches/

# Instalar todas las dependencias (incluyendo devDependencies para el build)
RUN pnpm install --frozen-lockfile

# Instalar Chromium de Playwright en el directorio del proyecto
# PLAYWRIGHT_BROWSERS_PATH garantiza que el binario esté en una ruta conocida
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/src/app/.browsers
RUN npx playwright install chromium && \
    echo "Chromium instalado en: $(npx playwright --version)"

# ============================================================
# Etapa de build
# ============================================================
FROM deps AS builder

WORKDIR /usr/src/app

# Copiar el código fuente
COPY . .

# Compilar frontend (Vite) y backend (esbuild)
RUN pnpm build

# ============================================================
# Etapa de producción
# ============================================================
FROM base AS production

WORKDIR /usr/src/app

# Variables de entorno para producción
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/src/app/.browsers
ENV PORT=3000

# Copiar dependencias y binarios de Chromium desde la etapa de build
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/.browsers ./.browsers
COPY --from=builder /usr/src/app/dist ./dist

# Copiar archivos de configuración y scripts de inicio
COPY package.json pnpm-lock.yaml ./
COPY start.mjs ./
COPY patches/ ./patches/

# Exponer el puerto
EXPOSE 3000

# Healthcheck para Railway
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

# Arrancar el servidor
CMD ["node", "start.mjs"]
