import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc";
import { CalendarCheck, Clock, Info, Loader2, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const PRESETS = [
  { label: "Cada día laborable a las 8:00", cron: "0 8 * * 1-5" },
  { label: "Cada día laborable a las 9:00", cron: "0 9 * * 1-5" },
  { label: "Lunes y jueves a las 8:00", cron: "0 8 * * 1,4" },
  { label: "Cada día a las 7:00", cron: "0 7 * * *" },
  { label: "Cada lunes a las 8:00", cron: "0 8 * * 1" },
];

function describeCron(cron: string): string {
  const parts = cron.split(" ");
  if (parts.length !== 5) return cron;
  const [min, hour, , , dow] = parts;
  const time = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  const days: Record<string, string> = {
    "*": "todos los días",
    "1-5": "días laborables (L-V)",
    "1": "lunes",
    "2": "martes",
    "3": "miércoles",
    "4": "jueves",
    "5": "viernes",
    "1,4": "lunes y jueves",
    "0": "domingos",
    "6": "sábados",
  };
  return `A las ${time} · ${days[dow] || dow}`;
}

export default function Schedule() {
  const [cronExpression, setCronExpression] = useState("0 8 * * 1-5");
  const [timezone, setTimezone] = useState("Europe/Madrid");
  const [enabled, setEnabled] = useState(false);

  const { data: schedule, isLoading } = trpc.schedule.get.useQuery();
  const saveMutation = trpc.schedule.save.useMutation();
  const toggleMutation = trpc.schedule.toggle.useMutation();
  const utils = trpc.useUtils();

  useEffect(() => {
    if (schedule) {
      setCronExpression(schedule.cronExpression);
      setTimezone(schedule.timezone);
      setEnabled(schedule.enabled);
    }
  }, [schedule]);

  const handleSave = async () => {
    try {
      await saveMutation.mutateAsync({ cronExpression, timezone, enabled });
      utils.schedule.get.invalidate();
      toast.success("Programación guardada correctamente");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error al guardar la programación");
    }
  };

  const handleToggle = async (value: boolean) => {
    setEnabled(value);
    try {
      await toggleMutation.mutateAsync({ enabled: value });
      utils.schedule.get.invalidate();
      toast.success(value ? "Programación activada" : "Programación desactivada");
    } catch (err) {
      setEnabled(!value);
      toast.error(err instanceof Error ? err.message : "Error al cambiar el estado");
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-2xl">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Programación automática</h1>
          <p className="text-muted-foreground mt-1">
            Configura ejecuciones automáticas periódicas del proceso de validación
          </p>
        </div>

        {/* Toggle principal */}
        <Card>
          <CardContent className="flex items-center justify-between pt-5 pb-5">
            <div className="flex items-center gap-3">
              <div className={`flex h-10 w-10 items-center justify-center rounded-full ${enabled ? "bg-emerald-100" : "bg-muted"}`}>
                <CalendarCheck className={`h-5 w-5 ${enabled ? "text-emerald-600" : "text-muted-foreground"}`} />
              </div>
              <div>
                <p className="font-medium text-foreground">Ejecución automática</p>
                <p className="text-sm text-muted-foreground">
                  {enabled ? `Activa · ${describeCron(cronExpression)}` : "Desactivada"}
                </p>
              </div>
            </div>
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <Switch checked={enabled} onCheckedChange={handleToggle} />
            )}
          </CardContent>
        </Card>

        {/* Configuración */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-primary" />
              Configuración del horario
            </CardTitle>
            <CardDescription>
              Define cuándo se ejecutará automáticamente el proceso de validación
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Presets */}
            <div className="space-y-2">
              <Label>Horarios predefinidos</Label>
              <div className="grid grid-cols-1 gap-2">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.cron}
                    onClick={() => setCronExpression(preset.cron)}
                    className={`text-left px-3 py-2 rounded-lg border text-sm transition-colors ${
                      cronExpression === preset.cron
                        ? "border-primary bg-primary/5 text-primary font-medium"
                        : "border-border hover:border-primary/50 hover:bg-muted/50 text-foreground"
                    }`}
                  >
                    {preset.label}
                    <span className="text-xs text-muted-foreground ml-2 font-mono">{preset.cron}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Cron personalizado */}
            <div className="space-y-2">
              <Label htmlFor="cron">Expresión cron personalizada</Label>
              <Input
                id="cron"
                value={cronExpression}
                onChange={(e) => setCronExpression(e.target.value)}
                placeholder="0 8 * * 1-5"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Formato: <code className="bg-muted px-1 rounded">minuto hora día mes día_semana</code>
                {" · "}
                <span className="text-primary">{describeCron(cronExpression)}</span>
              </p>
            </div>

            {/* Zona horaria */}
            <div className="space-y-2">
              <Label htmlFor="timezone">Zona horaria</Label>
              <Input
                id="timezone"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder="Europe/Madrid"
              />
            </div>

            {/* Última / próxima ejecución */}
            {schedule && (
              <div className="grid grid-cols-2 gap-3 pt-2">
                <div className="bg-muted/50 rounded-lg p-3">
                  <p className="text-xs text-muted-foreground">Última ejecución</p>
                  <p className="text-sm font-medium mt-0.5">
                    {schedule.lastRunAt
                      ? new Date(schedule.lastRunAt).toLocaleString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
                      : "Nunca"}
                  </p>
                </div>
                <div className="bg-muted/50 rounded-lg p-3">
                  <p className="text-xs text-muted-foreground">Próxima ejecución</p>
                  <p className="text-sm font-medium mt-0.5">
                    {schedule.nextRunAt
                      ? new Date(schedule.nextRunAt).toLocaleString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
                      : enabled ? "Calculando..." : "—"}
                  </p>
                </div>
              </div>
            )}

            <Button onClick={handleSave} disabled={saveMutation.isPending} className="gap-2 w-full">
              {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Guardar configuración
            </Button>
          </CardContent>
        </Card>

        <Card className="border-muted bg-muted/30">
          <CardContent className="pt-4 pb-4">
            <div className="flex gap-3">
              <Info className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">Sobre la programación automática</p>
                <p className="text-xs text-muted-foreground">
                  El proceso programado se ejecuta en el servidor y no requiere que tengas el navegador abierto. Asegúrate de que las credenciales estén configuradas correctamente antes de activar la programación automática.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
