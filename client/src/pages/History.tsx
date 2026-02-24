import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { CheckCircle2, ChevronDown, ChevronUp, Clock, Loader2, RefreshCw, XCircle } from "lucide-react";
import { useState } from "react";

type RunSummary = {
  totalValidated: number;
  daysByDate: { date: string; workersValidated: number; obras: string[] }[];
  monthsReviewed: { month: string; pendingFound: boolean }[];
  errors: string[];
};

function StatusBadge({ status }: { status: string }) {
  if (status === "completed") return <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200">Completado</Badge>;
  if (status === "failed") return <Badge className="bg-red-100 text-red-700 border-red-200">Fallido</Badge>;
  if (status === "running") return <Badge className="bg-blue-100 text-blue-700 border-blue-200">En ejecución</Badge>;
  return <Badge variant="outline">Pendiente</Badge>;
}

function RunDetail({ runId }: { runId: number }) {
  const { data: logs, isLoading } = trpc.runs.logs.useQuery({ runId });

  if (isLoading) return <div className="flex items-center gap-2 p-3 text-muted-foreground text-sm"><Loader2 className="h-3 w-3 animate-spin" /> Cargando logs...</div>;

  const levelColor: Record<string, string> = {
    info: "text-blue-400",
    success: "text-emerald-400",
    warning: "text-amber-400",
    error: "text-red-400",
  };
  const levelIcon: Record<string, string> = { info: "→", success: "✓", warning: "⚠", error: "✗" };

  return (
    <div className="bg-gray-950 rounded-lg p-3 max-h-60 overflow-y-auto font-mono text-xs space-y-0.5">
      {logs?.map((log) => (
        <div key={log.id} className={`flex gap-2 ${levelColor[log.level] || "text-gray-300"}`}>
          <span className="shrink-0 w-4">{levelIcon[log.level]}</span>
          <span className="text-gray-500 shrink-0">
            {new Date(log.createdAt).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
          <span className="break-all">{log.message}</span>
        </div>
      ))}
      {logs?.length === 0 && <p className="text-gray-500">Sin logs disponibles</p>}
    </div>
  );
}

export default function History() {
  const [expandedRun, setExpandedRun] = useState<number | null>(null);
  const { data: runs, isLoading, refetch } = trpc.runs.list.useQuery({ limit: 50 });

  const toggleExpand = (runId: number) => {
    setExpandedRun(expandedRun === runId ? null : runId);
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-4xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Historial de ejecuciones</h1>
            <p className="text-muted-foreground mt-1">Registro de todos los procesos de validación ejecutados</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2">
            <RefreshCw className="h-3 w-3" />
            Actualizar
          </Button>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Cargando historial...</span>
          </div>
        ) : !runs || runs.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <Clock className="h-10 w-10 text-muted-foreground/50 mb-3" />
              <p className="text-muted-foreground">No hay ejecuciones anteriores</p>
              <p className="text-sm text-muted-foreground/70 mt-1">Las ejecuciones aparecerán aquí una vez que inicies el proceso</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {runs.map((run) => {
              const summary = run.summary as RunSummary | null;
              const isExpanded = expandedRun === run.id;
              const duration = run.durationMs ? Math.round(run.durationMs / 1000) : null;

              return (
                <Card key={run.id} className={run.status === "failed" ? "border-red-200" : ""}>
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {run.status === "completed" && <CheckCircle2 className="h-5 w-5 text-emerald-500" />}
                        {run.status === "failed" && <XCircle className="h-5 w-5 text-red-500" />}
                        {run.status === "running" && <Loader2 className="h-5 w-5 animate-spin text-blue-500" />}
                        <div>
                          <div className="flex items-center gap-2">
                            <StatusBadge status={run.status} />
                            <Badge variant="outline" className="text-xs">
                              {run.triggeredBy === "manual" ? "Manual" : "Programado"}
                            </Badge>
                          </div>
                          <p className="text-sm text-muted-foreground mt-0.5">
                            {new Date(run.startedAt).toLocaleString("es-ES", {
                              day: "2-digit", month: "2-digit", year: "numeric",
                              hour: "2-digit", minute: "2-digit"
                            })}
                            {duration && ` · ${duration}s`}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        {summary && (
                          <div className="text-right">
                            <p className="text-sm font-semibold text-foreground">{summary.totalValidated} jornadas</p>
                            <p className="text-xs text-muted-foreground">{summary.daysByDate.filter(d => d.workersValidated > 0).length} días procesados</p>
                          </div>
                        )}
                        {run.errorMessage && (
                          <p className="text-xs text-red-600 max-w-48 truncate">{run.errorMessage}</p>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => toggleExpand(run.id)}
                          className="h-8 w-8 p-0"
                        >
                          {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </Button>
                      </div>
                    </div>
                  </CardHeader>

                  {isExpanded && (
                    <CardContent className="pt-0 space-y-3">
                      {summary && summary.daysByDate.filter(d => d.workersValidated > 0).length > 0 && (
                        <div>
                          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Partes validados</p>
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                            {summary.daysByDate.filter(d => d.workersValidated > 0).map((day) => (
                              <div key={day.date} className="flex items-center justify-between bg-muted/50 rounded px-2 py-1.5 text-xs">
                                <span className="font-medium">{day.date}</span>
                                <span className="text-muted-foreground">{day.workersValidated} trab.</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      <div>
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Log de ejecución</p>
                        <RunDetail runId={run.id} />
                      </div>
                    </CardContent>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
