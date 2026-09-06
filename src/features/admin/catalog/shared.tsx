'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronUp, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/overlays';

/**
 * Wiederkehrende Bausteine der Katalogpflege.
 *
 * Sie liegen zusammen, weil sechs Tabellen dieselben drei Bedienelemente
 * brauchen — bearbeiten, löschen, verschieben — und diese sich sonst
 * sechsmal leicht unterschiedlich einschleichen.
 */

export const PRICING_LABELS: Record<string, string> = {
  PER_HOUR: 'Nach Stunden',
  PER_SQM: 'Nach Fläche',
  PER_UNIT: 'Nach Stück',
  FLAT: 'Pauschal',
  ON_REQUEST: 'Auf Anfrage',
};

export const SERVICE_KIND_LABELS: Record<string, string> = {
  OFFICE_CLEANING: 'Büroreinigung',
  MOVE_OUT_CLEANING: 'Umzugsreinigung',
  RESIDENTIAL_CLEANING: 'Wohnungsreinigung',
  WINDOW_CLEANING: 'Fensterreinigung',
  CONSTRUCTION_CLEANING: 'Baureinigung',
  BUILDING_MAINTENANCE: 'Hauswartung',
  SPECIAL: 'Spezialreinigung',
};

export const PROPERTY_KIND_LABELS: Record<string, string> = {
  APARTMENT: 'Wohnung',
  HOUSE: 'Haus',
  OFFICE: 'Büro',
  COMMERCIAL: 'Gewerbe',
  INDUSTRIAL: 'Industrie',
  CONSTRUCTION_SITE: 'Baustelle',
  PRACTICE: 'Praxis',
  RESTAURANT: 'Gastronomie',
  SCHOOL: 'Schule',
  OTHER: 'Anderes',
};

export const FREQUENCY_LABELS: Record<string, string> = {
  ONCE: 'Einmalig',
  WEEKLY: 'Wöchentlich',
  BIWEEKLY: 'Alle zwei Wochen',
  MONTHLY: 'Monatlich',
  QUARTERLY: 'Vierteljährlich',
  SEMIANNUAL: 'Halbjährlich',
  ANNUAL: 'Jährlich',
  CUSTOM: 'Individuell',
};

export const WEEKDAY_LABELS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

export function ActiveBadge({ active }: { active: boolean }) {
  return active ? (
    <Badge variant="success" size="sm">
      Aktiv
    </Badge>
  ) : (
    <Badge variant="neutral" size="sm">
      Inaktiv
    </Badge>
  );
}

/**
 * Zeilenaktionen: bearbeiten, löschen, verschieben.
 *
 * Bewusst als sichtbare Schaltflächen und nicht in einem Kebab-Menü: bei
 * höchstens vier Aktionen kostet ein Menü einen zusätzlichen Klick und
 * verbirgt genau die Möglichkeit, die jemand sucht. Die Symbole tragen
 * `aria-label`, weil sie ohne Beschriftung stehen.
 */
export function RowActions({
  onEdit,
  onDelete,
  onMoveUp,
  onMoveDown,
  label,
}: {
  onEdit: () => void;
  onDelete?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  /** Name des Eintrags — landet in den Beschriftungen für Screenreader. */
  label: string;
}) {
  return (
    <div className="flex items-center justify-end gap-0.5">
      {onMoveUp || onMoveDown ? (
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onMoveUp}
            disabled={!onMoveUp}
            aria-label={`${label} nach oben`}
          >
            <ChevronUp aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onMoveDown}
            disabled={!onMoveDown}
            aria-label={`${label} nach unten`}
          >
            <ChevronDown aria-hidden />
          </Button>
        </>
      ) : null}

      <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label={`${label} bearbeiten`}>
        <Pencil aria-hidden />
      </Button>

      {onDelete ? (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDelete}
          aria-label={`${label} löschen`}
          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 aria-hidden />
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Löschbestätigung.
 *
 * Der Server entscheidet, *ob* gelöscht werden darf — hängt der Eintrag in
 * Buchungen, antwortet er mit 422 und einer Erklärung. Dieser Dialog fragt
 * deshalb nicht „sind Sie sicher", sondern zeigt die Antwort des Servers,
 * wenn sie ablehnend ausfällt: das ist die Information, die tatsächlich
 * weiterhilft.
 */
export function DeleteDialog({
  open,
  onOpenChange,
  title,
  description,
  endpoint,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  endpoint: string;
  onDeleted?: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.delete(endpoint);
      toast.success(`${title} gelöscht.`);
      onOpenChange(false);
      onDeleted?.();
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Löschen fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{title} löschen?</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {error ? (
          <p
            role="alert"
            className="rounded-xl border border-destructive/25 bg-destructive/5 p-4 text-sm leading-relaxed text-destructive"
          >
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button variant="destructive" onClick={confirm} loading={busy}>
            Endgültig löschen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Zahleneingabe, die das Schweizer Dezimalkomma akzeptiert.
 *
 * `<input type="number">` verwirft ein Komma stillschweigend — der Wert wird
 * dann zu `NaN` und das Formular meldet ein leeres Pflichtfeld, obwohl etwas
 * dasteht. Deshalb `inputMode="decimal"` auf einem Textfeld und die
 * Umwandlung hier.
 */
export function toNumberInput(value: string): number | undefined {
  const normalized = value.replace(',', '.').trim();
  if (normalized === '') return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Mehrzeilige Eingabe in eine Liste — eine Zeile je Eintrag. */
export function linesToList(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function listToLines(value: string[] | undefined): string {
  return (value ?? []).join('\n');
}

/** Einheitliche Fehlerbehandlung für alle Katalogformulare. */
export function describeError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return fallback;
}
