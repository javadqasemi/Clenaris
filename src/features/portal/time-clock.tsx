'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { LocateFixed, LogIn, LogOut, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';

import { cn, formatDuration } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';

/**
 * Ein- und Ausstempeln mit Standort.
 *
 * Architekturentscheide:
 *  • Der Standort wird angefragt, aber nicht erzwungen. In Tiefgaragen und
 *    Kellern gibt es kein GPS — dort trotzdem stempeln zu können ist wichtiger
 *    als ein lückenloser Standortnachweis. Fehlt die Position, wird die
 *    Erfassung markiert und im Büro geprüft.
 *  • Die laufende Zeit läuft im Sekundentakt weiter, damit erkennbar ist, dass
 *    die Erfassung aktiv ist. Massgebend ist die Serverzeit beim Ausstempeln.
 */

export function TimeClock({
  jobId,
  activeEntry,
}: {
  jobId: string;
  activeEntry: { id: string; startedAt: string } | null;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [elapsed, setElapsed] = React.useState(0);
  const [warning, setWarning] = React.useState<string | null>(null);

  // Laufende Dauer im Sekundentakt aktualisieren.
  React.useEffect(() => {
    if (!activeEntry) {
      setElapsed(0);
      return;
    }

    const started = new Date(activeEntry.startedAt).getTime();
    const tick = () => setElapsed(Math.floor((Date.now() - started) / 1000));

    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [activeEntry]);

  const getPosition = (): Promise<{ lat: number; lng: number; accuracy?: number } | null> =>
    new Promise((resolve) => {
      if (!('geolocation' in navigator)) return resolve(null);

      navigator.geolocation.getCurrentPosition(
        (position) =>
          resolve({
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy,
          }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 30_000 },
      );
    });

  const punch = async (direction: 'in' | 'out') => {
    setPending(true);
    setWarning(null);

    try {
      const position = await getPosition();

      const result = await api.post<{ warning?: string; minutes?: number }>(
        `/api/time/${direction === 'in' ? 'clock-in' : 'clock-out'}`,
        {
          jobId,
          // Ohne Standort senden wir 0/0; der Server erkennt das an der fehlenden Genauigkeit.
          lat: position?.lat ?? 0,
          lng: position?.lng ?? 0,
          accuracy: position?.accuracy,
        },
      );

      if (result.warning) setWarning(result.warning);

      toast.success(
        direction === 'in'
          ? 'Eingestempelt. Guten Einsatz!'
          : `Ausgestempelt${result.minutes ? ` · ${formatDuration(result.minutes)} erfasst` : ''}.`,
      );

      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'Die Zeiterfassung hat nicht funktioniert.',
      );
    } finally {
      setPending(false);
    }
  };

  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;

  return (
    <div className="space-y-3">
      {activeEntry ? (
        <div
          className={cn(
            'flex items-center justify-between gap-4 rounded-2xl border border-primary/30 bg-primary/[0.06] p-5',
          )}
        >
          <div>
            <p className="flex items-center gap-2 text-sm font-medium text-primary">
              <span className="status-dot bg-primary" aria-hidden />
              Zeiterfassung läuft
            </p>
            <p
              className="font-display text-3xl font-bold tabular-nums tracking-tight"
              aria-live="off"
            >
              {String(hours).padStart(2, '0')}:{String(minutes).padStart(2, '0')}:
              {String(seconds).padStart(2, '0')}
            </p>
          </div>

          <Button
            size="lg"
            variant="destructive"
            onClick={() => punch('out')}
            loading={pending}
            className="shrink-0"
          >
            <LogOut aria-hidden />
            Ausstempeln
          </Button>
        </div>
      ) : (
        <Button size="xl" width="full" onClick={() => punch('in')} loading={pending}>
          <LogIn aria-hidden />
          Einstempeln
        </Button>
      )}

      {warning ? (
        <Alert variant="warning" title="Standort weicht ab">
          {warning}
        </Alert>
      ) : null}

      <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
        <LocateFixed className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        Wir erfassen den Standort nur beim Ein- und Ausstempeln, um die Anwesenheit zu belegen.
        Ohne GPS-Empfang funktioniert die Erfassung trotzdem — sie wird dann zur Prüfung markiert.
      </p>
    </div>
  );
}

/** Warnhinweis für nachträglich erfasste oder markierte Zeiten. */
export function TimeEntryFlag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-warning">
      <TriangleAlert className="size-3.5" aria-hidden />
      {children}
    </span>
  );
}
