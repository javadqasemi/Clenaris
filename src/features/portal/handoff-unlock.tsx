'use client';

import * as React from 'react';
import { ArrowLeft, Lock } from 'lucide-react';

import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/form';
import { Alert } from '@/components/ui/primitives';

/**
 * Zurück zum Mitarbeiterbereich — die Bestätigung nach der Geräterückgabe.
 *
 * **Was hier bewusst fehlt.** Kein Feld für die E-Mail-Adresse: Die Person
 * ist bekannt, ihre Sitzung besteht die ganze Zeit. Kein zweiter Faktor: Der
 * schützt den *Zugang zum Konto*, und der wurde heute früh schon erbracht.
 * Kein eigener Zahlencode: Ein vierstelliger Zusatz neben einem starken
 * Passwort wäre das schwächere Geheimnis, das dann gilt.
 *
 * Was bleibt, ist eine Frage: Ist wieder die Person am Gerät, der es gehört?
 * Das Passwort beantwortet sie — ohne Abmelden, ohne Neuanmeldung, ohne dass
 * jemand zwischen zwei Terminen auf einem Telefon eine E-Mail-Adresse tippt.
 */
interface Zustand {
  active: boolean;
  jobNumber?: string;
  signatureStatus?: string;
  presentedByName?: string | null;
}

export function HandoffUnlock() {
  const [zustand, setZustand] = React.useState<Zustand | null>(null);
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [fehler, setFehler] = React.useState<string | null>(null);

  React.useEffect(() => {
    api
      .get<Zustand>('/api/handoff')
      .then(setZustand)
      .catch(() => setZustand({ active: false }));
  }, []);

  const entsperren = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFehler(null);
    try {
      const ergebnis = await api.post<{ weiter: string }>('/api/handoff/unlock', { password });
      /**
       * Voller Seitenwechsel statt `router.push`: Die Sperre steckte im
       * Zugangstoken, und das ist gerade neu ausgestellt worden. Ein
       * Client-Wechsel zeigte womöglich noch eine Seite, die der Router aus
       * dem Zwischenspeicher nimmt — und die stammt aus der gesperrten Zeit.
       */
      window.location.assign(ergebnis?.weiter ?? '/portal');
    } catch (error) {
      setFehler(
        error instanceof ApiError ? error.message : 'Das Entsperren hat nicht funktioniert.',
      );
      setBusy(false);
    }
  };

  /**
   * Keine aktive Übergabe mehr — die Person kann einfach weiterarbeiten.
   * Das passiert etwa, wenn sie in einem zweiten Tab bereits entsperrt hat.
   */
  if (zustand && !zustand.active) {
    return (
      <div className="container max-w-md space-y-6 py-16">
        <Alert variant="success" title="Das Gerät ist wieder frei">
          Es läuft keine Kundenabnahme mehr auf diesem Gerät.
        </Alert>
        <Button asChild className="w-full">
          <a href="/portal">
            <ArrowLeft aria-hidden />
            Zum Mitarbeiterbereich
          </a>
        </Button>
      </div>
    );
  }

  return (
    <div className="container max-w-md space-y-6 py-16">
      <header className="space-y-2 text-center">
        <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-muted">
          <Lock className="size-5 text-muted-foreground" aria-hidden />
        </span>
        <h1 className="font-display text-title font-bold">Zurück zum Mitarbeiterbereich</h1>
        <p className="text-sm text-muted-foreground">
          {zustand?.jobNumber
            ? `Das Gerät war für die Kundenabnahme von Einsatz ${zustand.jobNumber} übergeben.`
            : 'Das Gerät war für eine Kundenabnahme übergeben.'}{' '}
          Bitte bestätigen Sie mit Ihrem Passwort, dass Sie es wieder in der Hand haben.
        </p>
      </header>

      {zustand?.signatureStatus === 'COMPLETED' ? (
        <Alert variant="success" title="Abnahme abgeschlossen">
          Die Kundschaft hat den Rapport bestätigt.
        </Alert>
      ) : null}

      <form onSubmit={entsperren} className="space-y-4 rounded-2xl border border-border bg-card p-6 shadow-card">
        {fehler ? <Alert variant="destructive">{fehler}</Alert> : null}

        <div className="space-y-2">
          <Label htmlFor="handoff-password" required>
            Ihr Passwort
          </Label>
          <Input
            id="handoff-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            autoFocus
          />
        </div>

        <Button type="submit" className="w-full" loading={busy} disabled={password.length === 0}>
          Gerät übernehmen
        </Button>
      </form>

      <p className="text-center text-2xs text-muted-foreground">
        Sie bleiben angemeldet — dies ist keine neue Anmeldung, sondern eine Bestätigung.
      </p>
    </div>
  );
}
