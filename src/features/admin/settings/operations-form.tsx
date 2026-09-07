'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Save } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/primitives';
import { Switch } from '@/components/ui/controls';
import type { OperationSettings } from '@/lib/validation/settings';

/**
 * Betriebseinstellungen — die Schalter, die den Alltag steuern.
 *
 * Gestaltungsentscheide:
 *
 *  • **Jede Einstellung trägt ihre Folge im Text, nicht nur ihren Namen.**
 *    „Vorlaufzeit: 24" sagt niemandem etwas. „Kurzfristiger als 24 Stunden
 *    kann online nicht gebucht werden" schon — und wer das liest, merkt
 *    selbst, ob die Zahl stimmt.
 *
 *  • **Gesendet wird nur, was sich geändert hat.** Der Endpunkt nimmt
 *    Teiländerungen an. Zwei gleichzeitig geöffnete Masken verwerfen sich so
 *    nicht gegenseitig.
 *
 *  • **Die Zahlen sind begrenzt, und die Grenzen stehen dran.** Eine
 *    Vorlaufzeit von 4000 Tagen ist ein Tippfehler, kein Wunsch.
 */

interface NumberSpec {
  name: keyof OperationSettings;
  label: string;
  unit: string;
  min: number;
  max: number;
  effect: string;
}

interface ToggleSpec {
  name: keyof OperationSettings;
  label: string;
  effect: string;
}

const SECTIONS: {
  title: string;
  numbers: NumberSpec[];
  toggles: ToggleSpec[];
}[] = [
  {
    title: 'Buchung',
    numbers: [
      {
        name: 'bookingLeadDays',
        label: 'Buchbar im Voraus',
        unit: 'Tage',
        min: 0,
        max: 365,
        effect: 'So weit reicht der Kalender im Buchungsassistenten in die Zukunft.',
      },
      {
        name: 'bookingMinNoticeHours',
        label: 'Kürzeste Vorlaufzeit',
        unit: 'Stunden',
        min: 0,
        max: 720,
        effect: 'Kurzfristiger kann online nicht gebucht werden. Das Büro schon.',
      },
      {
        name: 'cancellationDeadlineHours',
        label: 'Kostenlose Stornierung bis',
        unit: 'Stunden vorher',
        min: 0,
        max: 720,
        effect: 'Danach wird eine Stornierung kostenpflichtig. Steht so auch in den AGB.',
      },
    ],
    toggles: [
      {
        name: 'smsRemindersEnabled',
        label: 'Terminerinnerung per SMS',
        effect:
          'Zusätzlich zur E-Mail. Ohne konfigurierten SMS-Dienst wird nur protokolliert statt versendet.',
      },
    ],
  },
  {
    title: 'Rechnungen und Mahnwesen',
    numbers: [
      {
        name: 'firstReminderAfterDays',
        label: 'Erste Mahnung nach',
        unit: 'Tagen Verzug',
        min: 1,
        max: 90,
        effect: 'Gerechnet ab dem Fälligkeitsdatum, nicht ab dem Rechnungsdatum.',
      },
    ],
    toggles: [
      {
        name: 'autoDunningEnabled',
        label: 'Mahnläufe automatisch starten',
        effect:
          'Der nächtliche Lauf mahnt überfällige Rechnungen selbständig. Ausgeschaltet bleibt das Mahnen Handarbeit.',
      },
    ],
  },
  {
    title: 'Bewertungen',
    numbers: [
      {
        name: 'reviewRequestAfterDays',
        label: 'Bewertung anfragen nach',
        unit: 'Tagen',
        min: 0,
        max: 90,
        effect: 'Gerechnet ab dem abgeschlossenen Einsatz. 0 bedeutet: am selben Tag.',
      },
    ],
    toggles: [
      {
        name: 'moderateReviews',
        label: 'Bewertungen erst nach Freigabe zeigen',
        effect:
          'Ausgeschaltet erscheint jede neue Bewertung sofort öffentlich — auch eine, die auf einem Missverständnis beruht.',
      },
    ],
  },
];

export function OperationsForm({ settings }: { settings: OperationSettings }) {
  const router = useRouter();
  const [values, setValues] = React.useState<OperationSettings>(settings);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const saved = React.useRef(settings);
  const changed = (Object.keys(values) as (keyof OperationSettings)[]).filter(
    (key) => values[key] !== saved.current[key],
  );

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const patch = Object.fromEntries(changed.map((key) => [key, values[key]]));
      await api.patch('/api/settings', patch);
      saved.current = values;
      toast.success('Einstellungen gespeichert.');
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
    <div className="space-y-6">
      {error ? <Alert variant="destructive">{error}</Alert> : null}

      {SECTIONS.map((section) => (
        <section key={section.title} className="rounded-2xl border border-border bg-card shadow-soft">
          <header className="border-b border-border px-6 py-4">
            <h2 className="font-display text-base font-semibold tracking-tight">{section.title}</h2>
          </header>

          <div className="divide-y divide-border">
            {section.numbers.map((spec) => (
              <div
                key={spec.name}
                className="grid gap-3 px-6 py-4 sm:grid-cols-[minmax(0,1fr)_11rem] sm:items-start"
              >
                <div className="min-w-0">
                  <label htmlFor={spec.name} className="text-sm font-medium">
                    {spec.label}
                  </label>
                  <p className="prose-measure mt-1 text-meta leading-relaxed text-muted-foreground">
                    {spec.effect}
                  </p>
                </div>
                <span className="flex items-center gap-2">
                  <Input
                    id={spec.name}
                    type="number"
                    inputMode="numeric"
                    min={spec.min}
                    max={spec.max}
                    value={String(values[spec.name])}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        [spec.name]: clamp(Number(event.target.value), spec.min, spec.max),
                      }))
                    }
                    className="max-w-[6rem] tabular-nums"
                  />
                  <span className="text-meta text-muted-foreground">{spec.unit}</span>
                </span>
              </div>
            ))}

            {section.toggles.map((spec) => (
              <div
                key={spec.name}
                className="grid gap-3 px-6 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
              >
                <div className="min-w-0">
                  <label htmlFor={spec.name} className="text-sm font-medium">
                    {spec.label}
                  </label>
                  <p className="prose-measure mt-1 text-meta leading-relaxed text-muted-foreground">
                    {spec.effect}
                  </p>
                </div>
                <Switch
                  id={spec.name}
                  checked={Boolean(values[spec.name])}
                  onCheckedChange={(checked) =>
                    setValues((current) => ({ ...current, [spec.name]: checked }))
                  }
                  aria-label={spec.label}
                />
              </div>
            ))}
          </div>
        </section>
      ))}

      {changed.length > 0 ? (
        <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-primary/25 bg-card/95 p-4 shadow-elevated backdrop-blur">
          <p className="text-sm text-muted-foreground">
            {changed.length === 1 ? 'Eine Änderung' : `${changed.length} Änderungen`} noch nicht
            gespeichert.
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => setValues(saved.current)}>
              Verwerfen
            </Button>
            <Button type="button" onClick={save} loading={busy}>
              <Save aria-hidden />
              Speichern
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const clamp = (value: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : min;
