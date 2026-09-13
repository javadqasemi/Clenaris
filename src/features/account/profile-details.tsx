'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { Switch } from '@/components/ui/controls';
import { EditableList, EditableRow } from '@/components/app/editable-row';

/**
 * Die eigenen Stammdaten — jede Angabe für sich änderbar.
 *
 * **Warum keine Maske mit einem Speichern-Knopf mehr.** Die vorherige Fassung
 * war ein Formular über vier Felder und drei Schalter mit einem Knopf darunter.
 * Wer nur die Telefonnummer nachtragen wollte, schickte damit auch Vorname,
 * Nachname, Sprache und alle Einwilligungen erneut — und im Prüfprotokoll stand
 * anschliessend „Profil aktualisiert" ohne Hinweis darauf, was sich tatsächlich
 * geändert hatte.
 *
 * Jetzt trägt jede Zeile ihre eigene Änderung. Das Protokoll wird dadurch
 * genau, und der häufigste Fall — eine einzelne Korrektur — kostet zwei Klicks
 * statt eines Formulardurchlaufs.
 *
 * **Warum Vor- und Nachname trotzdem immer mitgehen.** `updateProfileSchema`
 * führt beide als Pflichtfelder; der Endpunkt schreibt sie zusätzlich in den
 * verknüpften Kundendatensatz, damit Rechnungen den aktuellen Namen tragen.
 * Sie als freiwillig zu erklären wäre die grössere Änderung mit dem grösseren
 * Risiko — sie mitzuschicken kostet nichts.
 */

const LOCALES = [
  { value: 'DE', label: 'Deutsch' },
  { value: 'FR', label: 'Französisch' },
  { value: 'IT', label: 'Italienisch' },
  { value: 'EN', label: 'Englisch' },
];

export interface ProfileContactValues {
  firstName: string;
  lastName: string;
  phone: string;
  locale: string;
}

export function ProfileContactRows({
  values,
  columns = false,
  readOnly = false,
}: {
  values: ProfileContactValues;
  /** Beschriftung links, Wert rechts — die Tabellenform der Profilseite. */
  columns?: boolean;
  /**
   * Ohne Stift je Zeile. Auf der Profilseite gibt es den Knopf „Bearbeiten"
   * in der Kopfzeile; ein zweiter Weg an jeder Zeile war ausdrücklich nicht
   * gewünscht — zwei Bearbeitungswege für dieselben vier Angaben verwirren
   * mehr, als sie sparen.
   */
  readOnly?: boolean;
}) {
  // Der Endpunkt verlangt beide Namen bei jedem Aufruf.
  const identity = { firstName: values.firstName, lastName: values.lastName };
  const canEdit = !readOnly;

  return (
    <EditableList className={columns ? 'protocol-list--columns' : undefined}>
      <EditableRow
        label="Vorname"
        name="firstName"
        value={values.firstName}
        endpoint="/api/account/profile"
        extraPayload={{ lastName: values.lastName }}
        canEdit={canEdit}
        required
      />

      <EditableRow
        label="Nachname"
        name="lastName"
        value={values.lastName}
        endpoint="/api/account/profile"
        extraPayload={{ firstName: values.firstName }}
        canEdit={canEdit}
        required
      />

      <EditableRow
        label="Telefon"
        name="phone"
        type="tel"
        value={values.phone}
        placeholder="079 123 45 67"
        endpoint="/api/account/profile"
        extraPayload={identity}
        canEdit={canEdit}
        hint="Für Terminerinnerungen per SMS und Rückfragen zum Einsatz."
      />

      <EditableRow
        label="Sprache"
        name="locale"
        type="select"
        value={values.locale}
        display={LOCALES.find((l) => l.value === values.locale)?.label ?? values.locale}
        options={LOCALES}
        endpoint="/api/account/profile"
        extraPayload={identity}
        canEdit={canEdit}
        hint="Sprache für E-Mails und Dokumente."
      />
    </EditableList>
  );
}

// ---------------------------------------------------------------------------
//  Benachrichtigungen
// ---------------------------------------------------------------------------

interface NotificationValues {
  firstName: string;
  lastName: string;
  notifyByEmail: boolean;
  notifyBySms: boolean;
  marketingOptIn: boolean;
}

const SWITCHES = [
  {
    name: 'notifyByEmail' as const,
    label: 'E-Mail-Benachrichtigungen',
    description:
      'Terminbestätigungen, Erinnerungen und Rechnungen. Wir empfehlen, das eingeschaltet zu lassen.',
  },
  {
    name: 'notifyBySms' as const,
    label: 'SMS-Erinnerungen',
    description: 'Kurznachricht zwei Stunden vor dem Termin.',
  },
  {
    name: 'marketingOptIn' as const,
    label: 'Newsletter und Aktionen',
    description: 'Rund einmal im Monat, jederzeit abbestellbar.',
  },
];

/**
 * Schalter speichern sofort.
 *
 * Ein Schalter *ist* die Handlung — ihn umzulegen und danach noch einen
 * Speichern-Knopf zu verlangen ist ein Widerspruch, den niemand erwartet und
 * an dem Einstellungen verlorengehen. Schlägt das Speichern fehl, springt der
 * Schalter sichtbar zurück; das ist die ehrlichere Rückmeldung als eine
 * Meldung über einem Schalter, der in der neuen Stellung stehen bleibt.
 */
export function NotificationSwitches({ values }: { values: NotificationValues }) {
  const router = useRouter();
  const [state, setState] = React.useState({
    notifyByEmail: values.notifyByEmail,
    notifyBySms: values.notifyBySms,
    marketingOptIn: values.marketingOptIn,
  });
  const [pending, setPending] = React.useState<string | null>(null);

  const toggle = async (name: keyof typeof state, next: boolean) => {
    const previous = state[name];
    setState((current) => ({ ...current, [name]: next }));
    setPending(name);

    try {
      await api.patch('/api/account/profile', {
        firstName: values.firstName,
        lastName: values.lastName,
        [name]: next,
      });
      toast.success('Einstellung gespeichert.');
      router.refresh();
    } catch (error) {
      setState((current) => ({ ...current, [name]: previous }));
      toast.error(
        error instanceof ApiError
          ? error.message
          : 'Die Einstellung konnte nicht gespeichert werden.',
      );
    } finally {
      setPending(null);
    }
  };

  return (
    <dl className="protocol-list">
      {SWITCHES.map((entry) => (
        <div key={entry.name} className="protocol-row">
          <div className="flex items-start justify-between gap-6">
            <div className="min-w-0 space-y-1">
              <dt className="text-sm font-medium text-foreground">{entry.label}</dt>
              <dd className="text-meta leading-relaxed text-muted-foreground">
                {entry.description}
              </dd>
            </div>
            <Switch
              checked={state[entry.name]}
              disabled={pending !== null}
              onCheckedChange={(checked) => void toggle(entry.name, checked)}
              aria-label={entry.label}
              className="mt-0.5 shrink-0"
            />
          </div>
        </div>
      ))}
    </dl>
  );
}
