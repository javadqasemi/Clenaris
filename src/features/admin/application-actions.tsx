'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { Trash2 } from 'lucide-react';

import { api, ApiError } from '@/lib/api/client';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/controls';
import { ActionButton } from '@/components/app/action-button';

/**
 * Bewerbung löschen.
 *
 * Anders als sonst in dieser Anwendung ist das Löschen ausdrücklich
 * vorgesehen: Bewerbungsunterlagen sind besonders schützenswerte
 * Personendaten und dürfen nach abgeschlossenem Verfahren nur wenige Monate
 * aufbewahrt werden. Der Endpunkt gab es; die Seite bot ihn nicht an.
 */
export function ApplicationDeleteButton({
  applicationId,
  name,
}: {
  applicationId: string;
  name: string;
}) {
  return (
    <ActionButton
      endpoint={`/api/applications/${applicationId}`}
      method="DELETE"
      label="Löschen"
      aria-label={`Bewerbung von ${name} löschen`}
      variant="ghost"
      size="icon"
      confirmTitle="Bewerbung löschen?"
      confirm={`Die Bewerbung von ${name} wird samt Unterlagen endgültig entfernt. Das ist nach Abschluss des Verfahrens der vorgesehene Weg — Bewerbungsunterlagen werden nicht auf Vorrat aufbewahrt.`}
      successMessage="Bewerbung gelöscht."
    >
      <Trash2 aria-hidden />
    </ActionButton>
  );
}

/**
 * Status einer Bewerbung ändern.
 *
 * Ein einzelnes Select statt einer Buttonreihe: das Verfahren hat sieben
 * Stufen, und sieben Buttons pro Zeile machen eine Liste unlesbar. Die
 * Änderung wirkt sofort — kein Speichern-Knopf, dessen Vergessen still den
 * Stand verliert.
 */
const STATUSES = [
  { value: 'RECEIVED', label: 'Eingegangen' },
  { value: 'SCREENING', label: 'In Prüfung' },
  { value: 'INTERVIEW', label: 'Gespräch' },
  { value: 'OFFER', label: 'Angebot' },
  { value: 'HIRED', label: 'Angestellt' },
  { value: 'REJECTED', label: 'Abgesagt' },
  { value: 'WITHDRAWN', label: 'Zurückgezogen' },
] as const;

export function ApplicationStatusSelect({
  applicationId,
  status,
}: {
  applicationId: string;
  status: string;
}) {
  const router = useRouter();
  const [value, setValue] = React.useState(status);
  const [pending, setPending] = React.useState(false);

  const change = async (next: string) => {
    const previous = value;
    setValue(next);
    setPending(true);
    try {
      await api.patch(`/api/applications/${applicationId}`, { status: next });
      toast.success('Status aktualisiert.');
      router.refresh();
    } catch (error) {
      setValue(previous);
      toast.error(
        error instanceof ApiError ? error.message : 'Der Status konnte nicht geändert werden.',
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Select value={value} onValueChange={change} disabled={pending}>
      <SelectTrigger className="w-44" aria-label="Status der Bewerbung">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {STATUSES.map((entry) => (
          <SelectItem key={entry.value} value={entry.value}>
            {entry.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
