import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { CheckCircle2, Eye, EyeOff, KeyRound, Loader2, Save, Shield } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export default function Credentials() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [monthsBack, setMonthsBack] = useState(6);
  const [showPassword, setShowPassword] = useState(false);
  const [saved, setSaved] = useState(false);

  const { data: existing, isLoading } = trpc.credentials.get.useQuery();
  const saveMutation = trpc.credentials.save.useMutation();
  const testMutation = trpc.credentials.test.useMutation();
  const utils = trpc.useUtils();

  useEffect(() => {
    if (existing) {
      setUsername(existing.username);
      setMonthsBack(existing.monthsBack);
    }
  }, [existing]);

  const handleSave = async () => {
    if (!username.trim()) { toast.error("El usuario es obligatorio"); return; }
    if (!password.trim() && !existing) { toast.error("La contraseña es obligatoria"); return; }

    try {
      await saveMutation.mutateAsync({
        username: username.trim(),
        password: password || "KEEP_EXISTING",
        monthsBack,
      });
      utils.credentials.get.invalidate();
      setSaved(true);
      setPassword("");
      toast.success("Credenciales guardadas correctamente");
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error al guardar las credenciales");
    }
  };

  const handleTest = async () => {
    try {
      const result = await testMutation.mutateAsync();
      toast.success(`Credenciales válidas para ${result.username}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error al verificar las credenciales");
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-2xl">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Credenciales</h1>
          <p className="text-muted-foreground mt-1">
            Configura las credenciales de acceso a Nalanda Global. La contraseña se almacena cifrada con AES-256.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-primary" />
              Credenciales de Nalanda Global
            </CardTitle>
            <CardDescription>
              Introduce las mismas credenciales que usas para acceder a{" "}
              <a href="https://app.nalandaglobal.com" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                app.nalandaglobal.com
              </a>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {isLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm">Cargando...</span>
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="username">Usuario (email)</Label>
                  <Input
                    id="username"
                    type="email"
                    placeholder="usuario@empresa.com"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="password">
                    Contraseña
                    {existing && <span className="text-muted-foreground text-xs ml-2">(deja en blanco para mantener la actual)</span>}
                  </Label>
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      placeholder={existing ? "••••••••••" : "Contraseña de Nalanda"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="monthsBack">Meses a revisar hacia atrás</Label>
                  <div className="flex items-center gap-3">
                    <Input
                      id="monthsBack"
                      type="number"
                      min={1}
                      max={24}
                      value={monthsBack}
                      onChange={(e) => setMonthsBack(parseInt(e.target.value) || 6)}
                      className="w-24"
                    />
                    <span className="text-sm text-muted-foreground">
                      El proceso revisará el mes actual más los últimos {monthsBack} meses
                    </span>
                  </div>
                </div>

                <div className="flex gap-3 pt-2">
                  <Button
                    onClick={handleSave}
                    disabled={saveMutation.isPending}
                    className="gap-2"
                  >
                    {saveMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : saved ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    {saved ? "Guardado" : "Guardar credenciales"}
                  </Button>

                  {existing && (
                    <Button
                      variant="outline"
                      onClick={handleTest}
                      disabled={testMutation.isPending}
                      className="gap-2"
                    >
                      {testMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                      Verificar
                    </Button>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="border-muted bg-muted/30">
          <CardContent className="pt-4 pb-4">
            <div className="flex gap-3">
              <Shield className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">Seguridad de las credenciales</p>
                <p className="text-xs text-muted-foreground">
                  La contraseña se cifra con AES-256-GCM antes de almacenarse en la base de datos. Nunca se transmite en texto plano y solo se descifra en el servidor durante la ejecución del proceso de automatización.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
