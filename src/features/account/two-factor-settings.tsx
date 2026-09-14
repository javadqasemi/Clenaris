'use client';

import * as React from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { Check, Copy, ShieldCheck, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/primitives';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/overlays';

/**
 * Zwei-Faktor-Anmeldung im eigenen Profil.
 *
 * Gestaltungsentscheide:
 *
 *  • **Die Wiederherstellungscodes erscheinen genau einmal, und der Dialog
 *    lässt sich nicht nebenbei wegklicken.** Sie sind der einzige Weg zurück,
 *    wenn das Telefon verloren geht; wer sie übersieht, merkt es erst im
 *    schlechtesten Moment. Deshalb ein Häkchen zum Bestätigen statt eines
 *    „Schliessen".
 *
 *  • **Das Geheimnis steht als Text neben dem QR-Code.** Nicht jede Kamera
 *    funktioniert, nicht jeder scannt vom eigenen Bildschirm — abtippen muss
 *    möglich bleiben.
 *
 *  • **Ausschalten verlangt Passwort und Code.** Beides, weil sonst eine
 *    übernommene Sitzung genügte, um den Schutz zu entfernen.
 */

export interface TwoFactorStatus {
  enabled: boolean;
  confirmedAt: string | null;
  remainingRecoveryCodes: number;
}

interface SetupData {
  secret: string;
  qrCode: string;
  otpauthUrl: string;
}

export function TwoFactorSettings({ status }: { status: TwoFactorStatus }) {
  const router = useRouter();
  const [setup, setSetup] = React.useState<SetupData | null>(null);
  const [token, setToken] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = React.useState<string[] | null>(null);
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [disabling, setDisabling] = React.useState(false);

  const begin = async () => {
    setBusy(true);
    setError(null);
    try {
      setSetup(await api.post<SetupData>('/api/auth/2fa/setup'));
      setToken('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Die Einrichtung ist fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ recoveryCodes: string[] }>('/api/auth/2fa/confirm', { token });
      setRecoveryCodes(result.recoveryCodes);
      setAcknowledged(false);
      setSetup(null);
      setToken('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Der Code stimmt nicht.');
    } finally {
      setBusy(false);
    }
  };

  const copyCodes = async () => {
    if (!recoveryCodes) return;
    try {
      await navigator.clipboard.writeText(recoveryCodes.join('\n'));
      toast.success('Codes kopiert.');
    } catch {
      toast.error('Kopieren nicht möglich — bitte abschreiben.');
    }
  };

  return (
    <>
      <section className="rounded-2xl border border-border bg-card shadow-soft">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
          <h2 className="flex items-center gap-2.5 font-display text-base font-semibold tracking-tight">
            Zwei-Faktor-Anmeldung
            {status.enabled ? (
              <Badge variant="success" size="sm">
                Aktiv
              </Badge>
            ) : (
              <Badge variant="neutral" size="sm">
                Nicht eingerichtet
              </Badge>
            )}
          </h2>

          {status.enabled ? (
            <Button variant="outline" size="sm" onClick={() => setDisabling(true)}>
              <ShieldOff aria-hidden />
              Ausschalten
            </Button>
          ) : setup ? null : (
            <Button size="sm" onClick={begin} loading={busy}>
              <ShieldCheck aria-hidden />
              Einrichten
            </Button>
          )}
        </header>

        <div className="space-y-5 px-6 py-4">
        <p className="prose-measure text-sm leading-relaxed text-muted-foreground">
          Ein zweiter Faktor schützt das Konto auch dann, wenn das Passwort in falsche Hände gerät.
          Sie brauchen dafür eine Authenticator-App auf dem Telefon.
        </p>

        {error && !setup ? <Alert variant="destructive">{error}</Alert> : null}

        {status.enabled ? (
          <dl className="protocol-list">
            <div className="protocol-row">
              <dt className="protocol-label">Eingerichtet</dt>
              <dd className="protocol-value">
                {status.confirmedAt
                  ? new Date(status.confirmedAt).toLocaleDateString('de-CH', {
                      day: '2-digit',
                      month: 'long',
                      year: 'numeric',
                      timeZone: 'Europe/Zurich',
                    })
                  : '—'}
              </dd>
            </div>
            <div className="protocol-row">
              <dt className="protocol-label">Wiederherstellungscodes</dt>
              <dd className="protocol-value">
                {status.remainingRecoveryCodes} übrig
                {status.remainingRecoveryCodes <= 2 ? (
                  <span className="ml-2 text-warning">
                    — schalten Sie den Faktor aus und neu ein, um frische zu erhalten.
                  </span>
                ) : null}
              </dd>
            </div>
          </dl>
        ) : null}

        {/* --- Einrichtung ------------------------------------------------- */}
        {setup ? (
          <div className="space-y-5 rounded-xl border border-border bg-muted/30 p-5">
            <ol className="space-y-4 text-sm">
              <li className="space-y-3">
                <p className="font-medium">1. QR-Code in der App scannen</p>
                <div className="flex flex-wrap items-start gap-5">
                  <span className="rounded-xl border border-border bg-white p-2">
                    {/* `unoptimized`: der Code ist ein Data-URI und wird zur
                        Laufzeit erzeugt — durch den Optimierer soll er nicht. */}
                    <Image
                      src={setup.qrCode}
                      alt="QR-Code zur Einrichtung"
                      width={200}
                      height={200}
                      unoptimized
                    />
                  </span>
                  <div className="min-w-0 flex-1 space-y-2">
                    <p className="text-meta text-muted-foreground">
                      Keine Kamera zur Hand? Geben Sie diesen Schlüssel von Hand ein:
                    </p>
                    <code className="block break-all rounded-lg bg-card px-3 py-2 font-mono text-sm">
                      {setup.secret}
                    </code>
                    <p className="text-2xs text-muted-foreground">
                      Google Authenticator, 1Password, Bitwarden, Aegis und Microsoft
                      Authenticator verstehen ihn alle.
                    </p>
                  </div>
                </div>
              </li>

              <li className="space-y-2">
                <p className="font-medium">2. Den angezeigten Code eingeben</p>
                <div className="flex flex-wrap gap-2">
                  <Input
                    value={token}
                    onChange={(event) => setToken(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="123456"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    className="max-w-[10rem] text-center font-mono text-lg tracking-widest"
                  />
                  <Button onClick={confirm} loading={busy} disabled={token.length !== 6}>
                    Bestätigen
                  </Button>
                  <Button variant="ghost" onClick={() => setSetup(null)}>
                    Abbrechen
                  </Button>
                </div>
                {error ? <Alert variant="destructive">{error}</Alert> : null}
              </li>
            </ol>

            <p className="text-meta leading-relaxed text-muted-foreground">
              Der Schutz ist erst nach dem bestätigten Code eingeschaltet. Bis dahin ändert sich an
              Ihrer Anmeldung nichts.
            </p>
          </div>
        ) : null}
        </div>
      </section>

      {/* --- Wiederherstellungscodes ---------------------------------------- */}
      <Dialog
        open={recoveryCodes !== null}
        onOpenChange={(open) => {
          if (!open && acknowledged) {
            setRecoveryCodes(null);
            router.refresh();
          }
        }}
      >
        <DialogContent size="md" hideClose>
          <DialogHeader>
            <DialogTitle>Wiederherstellungscodes</DialogTitle>
            <DialogDescription>
              Sie sehen diese Codes <strong>nur jetzt</strong>. Jeder gilt einmal und ersetzt den
              Code aus der App — sie sind der einzige Weg zurück, wenn das Telefon verloren geht.
            </DialogDescription>
          </DialogHeader>

          <ul className="grid grid-cols-2 gap-2 rounded-xl bg-muted/50 p-4 font-mono text-sm">
            {(recoveryCodes ?? []).map((code) => (
              <li key={code} className="tabular-nums">
                {code}
              </li>
            ))}
          </ul>

          <Button variant="outline" onClick={copyCodes} width="full">
            <Copy aria-hidden />
            In die Zwischenablage kopieren
          </Button>

          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-4 text-sm">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
              className="mt-0.5 size-4 accent-[hsl(var(--primary))]"
            />
            Ich habe die Codes an einem sicheren Ort gespeichert.
          </label>

          <DialogFooter>
            <Button
              disabled={!acknowledged}
              onClick={() => {
                setRecoveryCodes(null);
                router.refresh();
              }}
            >
              <Check aria-hidden />
              Fertig
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* --- Ausschalten ----------------------------------------------------- */}
      <DisableDialog open={disabling} onOpenChange={setDisabling} />
    </>
  );
}

function DisableDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [password, setPassword] = React.useState('');
  const [token, setToken] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setPassword('');
      setToken('');
      setError(null);
    }
  }, [open]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/2fa/disable', { password, token });
      toast.success('Zwei-Faktor-Anmeldung ausgeschaltet.');
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Ausschalten fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Zwei-Faktor-Anmeldung ausschalten?</DialogTitle>
          <DialogDescription>
            Danach genügt Ihr Passwort allein, um sich anzumelden. Zur Sicherheit brauchen wir
            beides: Ihr Passwort und einen gültigen Code.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="disable-password" className="text-sm font-medium">
              Passwort
            </label>
            <Input
              id="disable-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="disable-token" className="text-sm font-medium">
              Code aus der App oder Wiederherstellungscode
            </label>
            <Input
              id="disable-token"
              value={token}
              onChange={(event) => setToken(event.target.value.toUpperCase())}
              className="font-mono"
              autoComplete="one-time-code"
            />
          </div>
        </div>

        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button
            variant="destructive"
            onClick={confirm}
            loading={busy}
            disabled={password.length === 0 || token.length < 6}
          >
            Ausschalten
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
