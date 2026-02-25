# Nalanda Validator - TODO

## Base de datos y esquema
- [x] Tabla `nalanda_credentials` (usuario, contraseña cifrada, configuración)
- [x] Tabla `execution_runs` (id, estado, inicio, fin, resumen JSON)
- [x] Tabla `execution_logs` (id, run_id, timestamp, nivel, mensaje)
- [x] Tabla `schedule_config` (id, activo, cron expression, próxima ejecución)

## Backend - Motor de automatización
- [x] Instalar Playwright en el servidor
- [x] Script `server/automation/nalanda.ts` con el flujo completo de Playwright
- [x] Login en Nalanda Global
- [x] Detección de días en rojo en el calendario (mes actual + N meses anteriores)
- [x] Aprobación de partes por día (seleccionar todos + validar)
- [x] Emisión de eventos SSE para log en tiempo real
- [x] Manejo de errores con reintentos automáticos (máx. 3 intentos)
- [x] Módulo de cifrado AES-256-GCM para contraseñas

## Backend - Endpoints tRPC
- [x] `credentials.save` - Guardar credenciales cifradas
- [x] `credentials.get` - Obtener credenciales (sin contraseña en claro)
- [x] `credentials.test` - Probar credenciales contra Nalanda
- [x] `runs.start` - Iniciar ejecución manual
- [x] `runs.list` - Listar historial de ejecuciones
- [x] `runs.get` - Obtener detalle de una ejecución
- [x] `runs.logs` - Obtener logs de una ejecución
- [x] `schedule.get` - Obtener configuración de programación
- [x] `schedule.save` - Guardar/actualizar programación
- [x] `schedule.toggle` - Activar/desactivar programación
- [x] Endpoint SSE `/api/runs/:id/stream` para log en tiempo real

## Frontend - Páginas y componentes
- [x] Layout con sidebar oscuro (DashboardLayout)
- [x] Página principal: panel de control con botón de inicio
- [x] Componente de log en tiempo real (SSE streaming con terminal oscura)
- [x] Panel de resultados con resumen final (jornadas, días, meses)
- [x] Página de credenciales con formulario seguro y cifrado
- [x] Página de historial de ejecuciones con logs expandibles
- [x] Página de programación (scheduler con cron y presets)
- [x] Indicadores de estado (en ejecución, completado, error)
- [x] Notificaciones toast para errores y éxitos

## Tests
- [x] Tests de cifrado AES-256 (encrypt/decrypt)
- [x] Tests de auth (logout, me)
- [x] Tests de validación de inputs (credentials, schedule, runs)

## Pendiente
- [x] Añadir número de versión visible en el panel de control
- [x] Corregir definitivamente el motor de automatización (fallo recurrente)
- [x] Actualizar lógica de validación para usar flujo real de Nalanda (js-validar-parte + confirmación Aceptar)
