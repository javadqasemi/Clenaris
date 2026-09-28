'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Copy, Save } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/primitives';
import { Checkbox } from '@/components/ui/controls';
import { DetailSection } from '@/components/app/page-parts';

/**
 * Öffnungs- und Einsatzzeiten.
 *
 * Gestaltungsentscheide:
 *
 *  • **Die ganze Woche in einem Formular, ein Speichern.** Der Endpunkt nimmt
 *    sieben Zeilen entgegen und gibt sieben zurück. Tag für Tag zu speichern
 *    wären sieben Anfragen, von denen jede für sich scheitern kann — und
 *    zurück bliebe ein halb gespeicherter Wochenplan.
 *
 *  • **„Auf alle übertragen" statt sechsmal Abtippen.** Fast jeder Betrieb hat
 *    Montag bis Freitag dieselben Zeiten. Die Schaltfläche überträgt die erste
 *    offene Zeile auf alle übrigen offenen Tage — geschlossene bleiben
 *    geschlossen.
 *
 *  • **Geschlossen blendet die Uhrzeiten aus, statt sie auszugrauen.** Ein
 *    ausgegrautes Feld mit „08:00" darin ist eine Behauptung, die nicht gilt.
 *
 *  • **Einsatzzeiten je Tag als zweite Zeile** (Produktsprint 2026-09-26).
 *    Vorgabe ist „wie Öffnungszeiten" — so verhielt sich das System bisher,
 *    und für die meisten Betriebe stimmt es. Wer abends reinigt, während das
 *    Büro tagsüber offen ist, stellt hier „eigene Zeiten" ein; die
 *    Öffnungszeiten auf der Website bleiben dabei, was sie sind. „Keine
 *    Einsätze" sperrt den Tag für Buchungen, auch wenn das Büro offen ist.
 */

export interface OpeningHourRow {
  weekday: number;
  opensAt: string | null;
  closesAt: string | null;
  closed: boolean;
  serviceOpensAt?: string | null;
  serviceClosesAt?: string | null;
  serviceClosed?: boolean;
}

type Einsatzmodus = 'wie' | 'eigene' | 'keine';

function modusVon(row: OpeningHourRow): Einsatzmodus {
  if (row.serviceClosed) return 'keine';
  if (row.serviceOpensAt || row.serviceClosesAt) return 'eigene';
  return 'wie';
}

const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

/** Montag zuerst — die Woche beginnt hierzulande nicht am Sonntag. */
const ORDER = [1, 2, 3, 4, 5, 6, 0];

export function OpeningHoursForm({ hours }: { hours: OpeningHourRow[] }) {
  const router = useRouter();
  const [rows, setRows] = React.useState<OpeningHourRow[]>(() => fill(hours));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const initial = React.useRef(JSON.stringify(fill(hours)));
  const dirty = JSON.stringify(rows) !== initial.current;

  const update = (weekday: number, patch: Partial<OpeningHourRow>) =>
    setRows((current) =>
      current.map((row) => (row.weekday === weekday ? { ...row, ...patch } : row)),
    );

  const copyToAll = () => {
    const source = ORDER.map((day) => rows.find((row) => row.weekday === day)!).find(
      (row) => !row.closed && row.opensAt,
    );
    if (!source) {
      toast.error('Kein offener Tag mit Zeiten, den man übertragen könnte.');
      return;
    }
    setRows((current) =>
      current.map((row) =>
        row.closed ? row : { ...row, opensAt: source.opensAt, closesAt: source.closesAt },
      ),
    );
    toast.success(`Zeiten von ${WEEKDAYS[source.weekday]} übertragen.`);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put('/api/opening-hours', {
        hours: rows.map((row) => {
          const modus = modusVon(row);
          return {
            weekday: row.weekday,
            opensAt: row.closed ? '' : (row.opensAt ?? ''),
            closesAt: row.closed ? '' : (row.closesAt ?? ''),
            closed: row.closed,
            serviceOpensAt: modus === 'eigene' ? (row.serviceOpensAt ?? '') : '',
            serviceClosesAt: modus === 'eigene' ? (row.serviceClosesAt ?? '') : '',
            serviceClosed: modus === 'keine',
          };
        }),
      });
      initial.current = JSON.stringify(rows);
      toast.success('Zeiten gespeichert.');
      router.refresh();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Speichern fehlgeschlagen.';
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DetailSection
      title="Öffnungs- und Einsatzzeiten"
      body="flush"
      action={
        <Button variant="outline" size="sm" onClick={copyToAll} type="button">
          <Copy aria-hidden />
          Auf alle offenen Tage übertragen
        </Button>
      }
    >
      <div className="space-y-3 px-6 py-5">
        {error ? <Alert variant="destructive">{error}</Alert> : null}

        {ORDER.map((day) => {
          const row = rows.find((entry) => entry.weekday === day)!;
          return (
            <div
              key={day}
              className="grid items-center gap-3 sm:grid-cols-[8rem_minmax(0,1fr)_auto]"
            >
              <span className="text-sm font-medium">{WEEKDAYS[day]}</span>

              {row.closed ? (
                <span className="text-sm text-muted-foreground">geschlossen</span>
              ) : (
                <span className="flex flex-wrap items-center gap-2">
                  <Input
                    type="time"
                    aria-label={`${WEEKDAYS[day]}, öffnet um`}
                    value={row.opensAt ?? ''}
                    onChange={(event) => update(day, { opensAt: event.target.value })}
                    className="max-w-[8rem] tabular-nums"
                  />
                  <span className="text-muted-foreground" aria-hidden>
                    –
                  </span>
                  <Input
                    type="time"
                    aria-label={`${WEEKDAYS[day]}, schliesst um`}
                    value={row.closesAt ?? ''}
                    onChange={(event) => update(day, { closesAt: event.target.value })}
                    className="max-w-[8rem] tabular-nums"
                  />
                </span>
              )}

              <label className="flex cursor-pointer items-center gap-2 justify-self-start text-sm sm:justify-self-end">
                <Checkbox
                  checked={row.closed}
                  onCheckedChange={(checked) => update(day, { closed: checked === true })}
                />
                geschlossen
              </label>

              <span className="text-xs text-muted-foreground sm:pl-3">Einsätze</span>
              <span className="flex flex-wrap items-center gap-2 sm:col-span-2">
                <select
                  aria-label={`${WEEKDAYS[day]}, Einsatzzeiten`}
                  value={modusVon(row)}
                  onChange={(event) => {
                    const modus = event.target.value as Einsatzmodus;
                    update(day,
                      modus === 'keine'
                        ? { serviceClosed: true, serviceOpensAt: null, serviceClosesAt: null }
                        : modus === 'eigene'
                          ? { serviceClosed: false, serviceOpensAt: row.serviceOpensAt || row.opensAt || '18:00', serviceClosesAt: row.serviceClosesAt || row.closesAt || '22:00' }
                          : { serviceClosed: false, serviceOpensAt: null, serviceClosesAt: null },
                    );
                  }}
                  className="h-9 rounded-lg border border-input bg-background px-2 text-sm"
                >
                  <option value="wie">wie Öffnungszeiten</option>
                  <option value="eigene">eigene Einsatzzeiten</option>
                  <option value="keine">keine Einsätze</option>
                </select>
                {modusVon(row) === 'eigene' ? (
                  <>
                    <Input
                      type="time"
                      aria-label={`${WEEKDAYS[day]}, Einsätze ab`}
                      value={row.serviceOpensAt ?? ''}
                      onChange={(event) => update(day, { serviceOpensAt: event.target.value })}
                      className="max-w-[8rem] tabular-nums"
                    />
                    <span className="text-muted-foreground" aria-hidden>
                      –
                    </span>
                    <Input
                      type="time"
                      aria-label={`${WEEKDAYS[day]}, Einsätze bis`}
                      value={row.serviceClosesAt ?? ''}
                      onChange={(event) => update(day, { serviceClosesAt: event.target.value })}
                      className="max-w-[8rem] tabular-nums"
                    />
                  </>
                ) : null}
              </span>
            </div>
          );
        })}

        <p className="prose-measure pt-2 text-meta leading-relaxed text-muted-foreground">
          Der Buchungsassistent bietet nur Anfangszeiten an, zu denen die ganze gewählte Leistung in die
          Einsatzzeit passt — und nur, wenn genug Mitarbeitende laut ihrer hinterlegten Arbeitszeit frei
          sind. Ausserhalb buchen kann das Büro jederzeit von Hand.
        </p>

        {dirty ? (
          <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setRows(JSON.parse(initial.current) as OpeningHourRow[])}
            >
              Verwerfen
            </Button>
            <Button type="button" onClick={save} loading={busy}>
              <Save aria-hidden />
              Zeiten speichern
            </Button>
          </div>
        ) : null}
      </div>
    </DetailSection>
  );
}

/** Fehlende Tage ergänzen — sonst fehlt im Formular eine Zeile. */
function fill(hours: OpeningHourRow[]): OpeningHourRow[] {
  return [0, 1, 2, 3, 4, 5, 6].map(
    (weekday) =>
      hours.find((hour) => hour.weekday === weekday) ?? {
        weekday,
        opensAt: null,
        closesAt: null,
        closed: true,
        serviceOpensAt: null,
        serviceClosesAt: null,
        serviceClosed: false,
      },
  );
}
