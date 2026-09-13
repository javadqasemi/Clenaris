'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';

/**
 * Farbschema als Kontoeinstellung.
 *
 * **Was hier gefehlt hat.** Die Spalte `User.theme` existierte, der Endpunkt
 * nahm sie entgegen — geschrieben hat sie nie jemand. Die Wahl lebte
 * ausschliesslich im `localStorage` des Browsers. Wer sich am Arbeitsplatz für
 * Dunkel entschied, bekam auf dem Telefon wieder Hell, und nach dem Leeren der
 * Browserdaten war die Einstellung ganz weg.
 *
 * **Wie die beiden Ebenen zusammenspielen.**
 *
 *  • Der Umschalter in der Kopfzeile wirkt *sofort und nur auf diesem Gerät*.
 *    Er muss auch ohne Anmeldung funktionieren — die öffentliche Website hat
 *    keine Sitzung — und darf für einen kurzen Blick ins helle Schema nicht
 *    eine Serveranfrage auslösen.
 *
 *  • Diese Einstellung schreibt die Wahl **ins Konto**. Auf einem Gerät, das
 *    noch keine eigene Wahl kennt, gilt sie ab der nächsten Anmeldung
 *    (`ThemeSync`). Ein Gerät, an dem jemand bewusst umgeschaltet hat, behält
 *    seine Wahl — die lokale Geste ist die spätere und die genauere.
 *
 * Vor- und Nachname gehen mit, weil `updateProfileSchema` sie als Pflichtfelder
 * führt; sie kommen aus der bereits geladenen Seite und lösen keine zweite
 * Abfrage aus.
 */
const OPTIONS = [
  { value: 'light', label: 'Hell', description: 'Heller Hintergrund, dunkle Schrift.', Icon: Sun },
  {
    value: 'dark',
    label: 'Dunkel',
    description: 'Schont die Augen bei wenig Umgebungslicht.',
    Icon: Moon,
  },
  {
    value: 'system',
    label: 'System',
    description: 'Folgt der Einstellung Ihres Geräts.',
    Icon: Monitor,
  },
] as const;

export function AppearanceSection({
  preference,
  firstName,
  lastName,
}: {
  preference: string;
  firstName: string;
  lastName: string;
}) {
  const { setTheme } = useTheme();
  const [value, setValue] = React.useState(preference);
  const [saving, setSaving] = React.useState<string | null>(null);

  const choose = async (next: string) => {
    const previous = value;
    setValue(next);
    // Sofort sichtbar — die Serverantwort ändert daran nichts mehr.
    setTheme(next);
    setSaving(next);

    try {
      await api.patch('/api/account/profile', { firstName, lastName, theme: next });
      toast.success('Farbschema gespeichert.');
    } catch (error) {
      /*
        Die Darstellung bleibt beim Gewählten — das Gerät hat die Wahl bereits
        übernommen, und sie zurückzudrehen wäre ein zweiter Sprung im Bild. Nur
        die Markierung geht zurück, weil im Konto tatsächlich noch der alte
        Wert steht; genau das sagt die Meldung.
      */
      setValue(previous);
      toast.error(
        error instanceof ApiError
          ? error.message
          : 'Das Farbschema gilt auf diesem Gerät, konnte aber nicht im Konto gespeichert werden.',
      );
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="space-y-3 py-4">
      <div role="radiogroup" aria-label="Farbschema" className="grid gap-2.5 sm:grid-cols-3">
        {OPTIONS.map(({ value: option, label, description, Icon }) => {
          const active = value === option;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={saving !== null}
              onClick={() => void choose(option)}
              className={cn(
                'flex flex-col items-start gap-1.5 rounded-2xl border p-4 text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                'disabled:opacity-60',
                active
                  ? 'border-primary bg-primary/[0.06]'
                  : 'border-border bg-card hover:bg-muted/50',
              )}
            >
              <span className="flex w-full items-center justify-between gap-2">
                <Icon
                  className={cn('size-5', active ? 'text-primary' : 'text-muted-foreground')}
                  aria-hidden
                />
                {active ? <Check className="size-4 text-primary" aria-hidden /> : null}
              </span>
              <span className="text-sm font-medium">{label}</span>
              <span className="text-xs leading-relaxed text-muted-foreground">{description}</span>
            </button>
          );
        })}
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Die Wahl gilt für dieses Konto und wird auf jedes Gerät übernommen, an dem Sie noch nichts
        eingestellt haben. Der Umschalter in der Kopfzeile wirkt nur auf dem gerade benutzten
        Gerät.
      </p>
    </div>
  );
}

/**
 * Überträgt die Kontoeinstellung auf ein Gerät, das noch keine eigene Wahl hat.
 *
 * Warum direkt im `localStorage` nachgesehen wird und nicht über `theme` aus
 * `next-themes`: Dort ist „nie etwas gewählt" von „ausdrücklich System
 * gewählt" nicht zu unterscheiden — beides ist `'system'`. Der fehlende
 * Schlüssel ist das einzige verlässliche Zeichen für ein unberührtes Gerät.
 * Ohne diese Unterscheidung würde die Kontoeinstellung eine bewusste lokale
 * Wahl bei jedem Seitenaufruf überschreiben.
 */
export function ThemeSync({ preference }: { preference: string }) {
  const { setTheme } = useTheme();

  React.useEffect(() => {
    if (!preference) return;

    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem('clenaris-theme');
    } catch {
      // Privater Modus oder gesperrter Speicher: dann gilt eben nur die
      // Kontoeinstellung, und das ist der bessere der beiden Ausgänge.
    }

    if (!stored) setTheme(preference);
  }, [preference, setTheme]);

  return null;
}
