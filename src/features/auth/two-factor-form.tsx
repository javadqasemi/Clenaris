'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { KeyRound, ShieldCheck } from 'lucide-react';

import { api, ApiError } from '@/lib/api/client';
import { resolveRedirect, safeReturnPath } from '@/lib/auth/safe-redirect';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/primitives';

/**
 * Zweiter Schritt der Anmeldung.
 *
 * Gestaltungsentscheide:
 *
 *  • **Sechs grosse Felder statt eines Textfelds.** Ein sechsstelliger Code
 *    wird abgelesen und abgetippt, oft in Eile. Einzelne Felder zeigen den
 *    Fortschritt, fangen das Einfügen aus der Zwischenablage ab und
 *    verhindern den häufigsten Fehler — eine Ziffer zu viel.
 *
 *  • **Abgeschickt wird automatisch bei der sechsten Ziffer.** Wer den Code
 *    getippt hat, will nicht noch eine Schaltfläche suchen; das Zeitfenster
 *    beträgt dreissig Sekunden.
 *
 *  • **Der Wiederherstellungscode ist einen Klick entfernt, nicht versteckt.**
 *    Wer ihn braucht, hat das Telefon nicht — und dann ist Suchen das
 *    Letzte, was hilft.
 */
export function TwoFactorForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Dasselbe Ziel wie im Anmeldeformular — und dieselbe Prüfung. Ohne sie
  // bliebe die offene Weiterleitung über den Umweg des zweiten Faktors offen.
  const returnTo = safeReturnPath(searchParams.get('weiter'));

  const [digits, setDigits] = React.useState<string[]>(Array(6).fill(''));
  const [recoveryMode, setRecoveryMode] = React.useState(false);
  const [recoveryCode, setRecoveryCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const inputs = React.useRef<(HTMLInputElement | null)[]>([]);

  const submit = React.useCallback(
    async (token: string) => {
      setBusy(true);
      setError(null);
      try {
        const result = await api.post<{
          redirectTo: string;
          usedRecoveryCode: boolean;
          remainingRecoveryCodes: number;
        }>('/api/auth/2fa/verify', { token });

        if (result.usedRecoveryCode) {
          // Der Hinweis muss stehen bleiben, bis die Seite wechselt — deshalb
          // hier und nicht als flüchtige Meldung.
          setNotice(
            `Wiederherstellungscode verbraucht. Es sind noch ${result.remainingRecoveryCodes} übrig.`,
          );
        }

        router.replace(resolveRedirect(returnTo, result.redirectTo));
        router.refresh();
      } catch (err) {
        setError(
          err instanceof ApiError ? err.message : 'Die Bestätigung ist fehlgeschlagen.',
        );
        setDigits(Array(6).fill(''));
        inputs.current[0]?.focus();
      } finally {
        setBusy(false);
      }
    },
    [returnTo, router],
  );

  const setDigit = (index: number, value: string) => {
    const clean = value.replace(/\D/g, '');

    // Eingefügter Code: alle Stellen auf einmal übernehmen.
    if (clean.length > 1) {
      const next = clean.slice(0, 6).split('');
      const filled = Array(6)
        .fill('')
        .map((_, i) => next[i] ?? '');
      setDigits(filled);
      if (filled.every(Boolean)) void submit(filled.join(''));
      else inputs.current[Math.min(next.length, 5)]?.focus();
      return;
    }

    const next = [...digits];
    next[index] = clean;
    setDigits(next);

    if (clean && index < 5) inputs.current[index + 1]?.focus();
    if (next.every(Boolean)) void submit(next.join(''));
  };

  const onKeyDown = (index: number, event: React.KeyboardEvent<HTMLInputElement>) => {
    // Rücktaste im leeren Feld springt zurück — sonst hängt man fest.
    if (event.key === 'Backspace' && !digits[index] && index > 0) {
      inputs.current[index - 1]?.focus();
    }
  };

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <span className="flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <ShieldCheck className="size-5" aria-hidden />
        </span>
        <h1 className="text-title font-bold tracking-tight">Bestätigung</h1>
        <p className="prose-measure text-sm leading-relaxed text-muted-foreground">
          {recoveryMode
            ? 'Geben Sie einen Ihrer Wiederherstellungscodes ein. Jeder gilt genau einmal.'
            : 'Geben Sie den sechsstelligen Code aus Ihrer Authenticator-App ein.'}
        </p>
      </header>

      {error ? <Alert variant="destructive">{error}</Alert> : null}
      {notice ? <Alert variant="info">{notice}</Alert> : null}

      {recoveryMode ? (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(recoveryCode);
          }}
          noValidate
        >
          <div className="space-y-2">
            <label htmlFor="recovery" className="text-sm font-medium">
              Wiederherstellungscode
            </label>
            <Input
              id="recovery"
              value={recoveryCode}
              onChange={(event) => setRecoveryCode(event.target.value.toUpperCase())}
              placeholder="ABCDE-FGHJK"
              className="font-mono tracking-wider"
              autoComplete="one-time-code"
              autoFocus
            />
          </div>
          <Button type="submit" width="full" loading={busy} disabled={recoveryCode.length < 8}>
            <KeyRound aria-hidden />
            Bestätigen
          </Button>
        </form>
      ) : (
        <div className="space-y-4">
          <div className="flex justify-between gap-2" role="group" aria-label="Sechsstelliger Code">
            {digits.map((digit, index) => (
              <input
                key={index}
                ref={(element) => {
                  inputs.current[index] = element;
                }}
                value={digit}
                onChange={(event) => setDigit(index, event.target.value)}
                onKeyDown={(event) => onKeyDown(index, event)}
                inputMode="numeric"
                autoComplete={index === 0 ? 'one-time-code' : 'off'}
                maxLength={6}
                aria-label={`Ziffer ${index + 1} von 6`}
                autoFocus={index === 0}
                disabled={busy}
                className="h-14 w-full rounded-xl border border-input bg-card text-center text-xl font-semibold tabular-nums shadow-soft focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              />
            ))}
          </div>
          <p className="text-meta text-muted-foreground">
            Der Code wechselt alle 30 Sekunden. Stimmt er nie, prüfen Sie die Uhrzeit Ihres
            Telefons — die Bestätigung hängt daran.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5 text-sm">
        <button
          type="button"
          onClick={() => {
            setRecoveryMode((value) => !value);
            setError(null);
          }}
          className="text-primary underline-offset-4 hover:underline"
        >
          {recoveryMode ? 'Zurück zum Code aus der App' : 'Telefon nicht zur Hand?'}
        </button>
        <Link href="/auth/anmelden" className="text-muted-foreground underline-offset-4 hover:underline">
          Abbrechen
        </Link>
      </div>
    </div>
  );
}
