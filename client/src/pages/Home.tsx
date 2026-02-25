import { useAuth } from "@/_core/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { AlertCircle, CalendarCheck, CheckCircle2, Clock, Loader2, Play, RefreshCw, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import DashboardLayout from "@/components/DashboardLayout";

type LogEntry = {
  level: "info" | "success" | "warning" | "error";
  message: string;
  timestamp: string | Date;
  type?: string;
};

type RunSummary = {
  totalValidated: number;
  daysByDate: { date: string; workersValidated: number; obras: string[] }[];
  monthsReviewed: { month: string; pendingFound: boolean }[];
  errors: string[];
};

const levelIcon = {
  info: "→",
  success: "✓",
  warning: "⚠",
  error: "✗",
};

const levelColor = {
  info: "text-blue-400",
  success: "text-emerald-400",
  warning: "text-amber-400",
  error: "text-red-400",
};

export default function Home() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const [runId, setRunId] = useState<number | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [runStatus, setRunStatus] = useState<"idle" | "running" | "completed" | "failed">("idle");
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [progress, setProgress] = useState(0);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const { data: credentials } = trpc.credentials.get.useQuery();
  const { data: recentRuns } = trpc.runs.list.useQuery({ limit: 5 });
  const startRunMutation = trpc.runs.start.useMutation();
  const utils = trpc.useUtils();

  // Auto-scroll al final del log
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  // Conectar SSE cuando hay un runId activo
  useEffect(() => {
    if (!runId) return;

    const es = new EventSource(`/api/runs/${runId}/stream`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as LogEntry & { type?: string; status?: string; summary?: RunSummary };
        if (data.type === "done") {
          setRunStatus(data.status === "completed" ? "completed" : "failed");
          setIsRunning(false);
          if (data.summary) setSummary(data.summary as RunSummary);
          setProgress(100);
          utils.runs.list.invalidate();
          es.close();
        } else {
          setLogs((prev) => [...prev, data]);
          if (data.level === "success") setProgress((p) => Math.min(p + 5, 95));
        }
      } catch { /* ignorar errores de parseo */ }
    };

    es.onerror = () => {
      setIsRunning(false);
      setRunStatus("failed");
      es.close();
    };

    return () => { es.close(); };
  }, [runId]);

  const handleStart = async () => {
    if (!credentials) {
      navigate("/credentials");
      return;
    }
    setLogs([]);
    setSummary(null);
    setProgress(0);
    setRunStatus("running");
    setIsRunning(true);

    try {
      const { runId: newRunId } = await startRunMutation.mutateAsync({ triggeredBy: "manual" });
      setRunId(newRunId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Error al iniciar el proceso";
      setLogs([{ level: "error", message: msg, timestamp: new Date() }]);
      setIsRunning(false);
      setRunStatus("failed");
    }
  };

  const handleReset = () => {
    setRunStatus("idle");
    setLogs([]);
    setSummary(null);
    setProgress(0);
    setRunId(null);
  };

  const lastRun = recentRuns?.[0];

  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-5xl">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Panel de control</h1>
            <p className="text-muted-foreground mt-1">
              Automatización de validación de partes pendientes en Nalanda Global
            </p>
          </div>
          <Badge variant="outline" className="text-xs font-mono text-muted-foreground border-muted shrink-0 mt-1">
            v2.5.0 · worker-inline
          </Badge>
        </div>

        {/* Estado de credenciales */}
        {!credentials && (
          <Card className="border-amber-200 bg-amber-50">
            <CardContent className="flex items-center gap-3 pt-4 pb-4">
              <AlertCircle className="h-5 w-5 text-amber-600 shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-medium text-amber-800">Credenciales no configuradas</p>
                <p className="text-xs text-amber-700 mt-0.5">Configura las credenciales de Nalanda antes de iniciar el proceso.</p>
              </div>
              <Button size="sm" variant="outline" onClick={() => navigate("/credentials")} className="border-amber-300 text-amber-800 hover:bg-amber-100">
                Configurar
              </Button>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Panel principal de acción */}
          <div className="lg:col-span-2 space-y-4">
            {/* Botón de inicio */}
            {runStatus === "idle" && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <CalendarCheck className="h-5 w-5 text-primary" />
                    Validar partes pendientes
                  </CardTitle>
                  <CardDescription>
                    El proceso revisará el mes actual y los últimos {credentials?.monthsBack ?? 6} meses en busca de partes sin aprobar.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Button
                    size="lg"
                    className="w-full gap-2"
                    onClick={handleStart}
                    disabled={isRunning || !credentials}
                  >
                    <Play className="h-4 w-4" />
                    Iniciar validación
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* Log en tiempo real */}
            {(runStatus === "running" || runStatus === "completed" || runStatus === "failed") && (
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="flex items-center gap-2 text-base">
                      {runStatus === "running" && <Loader2 className="h-4 w-4 animate-spin text-blue-500" />}
                      {runStatus === "completed" && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                      {runStatus === "failed" && <XCircle className="h-4 w-4 text-red-500" />}
                      {runStatus === "running" ? "Proceso en ejecución..." : runStatus === "completed" ? "Proceso completado" : "Proceso fallido"}
                    </CardTitle>
                    {runStatus !== "running" && (
                      <Button size="sm" variant="outline" onClick={handleReset} className="gap-1">
                        <RefreshCw className="h-3 w-3" />
                        Nueva ejecución
                      </Button>
                    )}
                  </div>
                  {/* Barra de progreso */}
                  <div className="w-full bg-muted rounded-full h-1.5 mt-2">
                    <div
                      className="bg-primary h-1.5 rounded-full transition-all duration-500"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </CardHeader>
                <CardContent>
                  <div
                    ref={logContainerRef}
                    className="bg-gray-950 rounded-lg p-4 h-72 overflow-y-auto font-mono text-xs space-y-1"
                  >
                    {logs.length === 0 && (
                      <p className="text-gray-500">Iniciando proceso...</p>
                    )}
                    {logs.map((log, i) => (
                      <div key={i} className={`flex gap-2 ${levelColor[log.level] || "text-gray-300"}`}>
                        <span className="shrink-0 w-4">{levelIcon[log.level]}</span>
                        <span className="text-gray-500 shrink-0">
                          {new Date(log.timestamp).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                        </span>
                        <span className="break-all">{log.message}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Panel de resultados */}
            {summary && runStatus === "completed" && (
              <Card className="border-emerald-200">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base text-emerald-700">
                    <CheckCircle2 className="h-5 w-5" />
                    Resumen de la validación
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-3 gap-3">
                    <div className="bg-emerald-50 rounded-lg p-3 text-center">
                      <p className="text-2xl font-bold text-emerald-700">{summary.totalValidated}</p>
                      <p className="text-xs text-emerald-600 mt-0.5">Jornadas validadas</p>
                    </div>
                    <div className="bg-blue-50 rounded-lg p-3 text-center">
                      <p className="text-2xl font-bold text-blue-700">{summary.daysByDate.filter(d => d.workersValidated > 0).length}</p>
                      <p className="text-xs text-blue-600 mt-0.5">Días procesados</p>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-3 text-center">
                      <p className="text-2xl font-bold text-gray-700">{summary.monthsReviewed.length}</p>
                      <p className="text-xs text-gray-600 mt-0.5">Meses revisados</p>
                    </div>
                  </div>

                  {summary.daysByDate.filter(d => d.workersValidated > 0).length > 0 && (
                    <div>
                      <p className="text-sm font-medium text-foreground mb-2">Partes validados por día</p>
                      <div className="space-y-1.5">
                        {summary.daysByDate.filter(d => d.workersValidated > 0).map((day) => (
                          <div key={day.date} className="flex items-center justify-between text-sm bg-muted/50 rounded px-3 py-1.5">
                            <span className="font-medium">{day.date}</span>
                            <Badge variant="secondary">{day.workersValidated} trabajadores</Badge>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div>
                    <p className="text-sm font-medium text-foreground mb-2">Meses revisados</p>
                    <div className="flex flex-wrap gap-2">
                      {summary.monthsReviewed.map((m) => (
                        <Badge key={m.month} variant={m.pendingFound ? "default" : "outline"} className={m.pendingFound ? "bg-emerald-100 text-emerald-700 border-emerald-200" : ""}>
                          {m.month} {m.pendingFound ? "✓" : "—"}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  <p className="text-sm text-emerald-700 font-medium bg-emerald-50 rounded-lg px-3 py-2">
                    ✓ No quedan partes pendientes de validar
                  </p>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Panel lateral: estadísticas y última ejecución */}
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Última ejecución</CardTitle>
              </CardHeader>
              <CardContent>
                {lastRun ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      {lastRun.status === "completed" && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                      {lastRun.status === "failed" && <XCircle className="h-4 w-4 text-red-500" />}
                      {lastRun.status === "running" && <Loader2 className="h-4 w-4 animate-spin text-blue-500" />}
                      <span className="text-sm font-medium capitalize">{lastRun.status === "completed" ? "Completado" : lastRun.status === "failed" ? "Fallido" : "En ejecución"}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {new Date(lastRun.startedAt).toLocaleString("es-ES")}
                    </p>
                    {lastRun.durationMs && (
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {Math.round(lastRun.durationMs / 1000)}s de duración
                      </p>
                    )}
                    {lastRun.summary != null && (
                      <p className="text-xs text-emerald-600 font-medium">
                        {(lastRun.summary as RunSummary).totalValidated} jornadas validadas
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Sin ejecuciones anteriores</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Configuración</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Usuario</span>
                  <span className="font-medium truncate max-w-32">{credentials?.username || "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Meses a revisar</span>
                  <span className="font-medium">{credentials?.monthsBack ?? 6}</span>
                </div>
                <Button variant="outline" size="sm" className="w-full mt-2" onClick={() => navigate("/credentials")}>
                  Editar configuración
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
