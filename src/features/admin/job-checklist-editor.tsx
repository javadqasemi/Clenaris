'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowDown, ArrowUp, ListChecks, Plus, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/form';
import { Alert } from '@/components/ui/primitives';
import { Checkbox } from '@/components/ui/controls';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/controls';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/overlays';

/**
 * Checkliste eines Einsatzes bearbeiten (Verwaltung).
 *
 * Gestaltungsentscheide:
 *
 *  • **Die Liste wird als Ganzes gespeichert, nicht Punkt für Punkt.** Wer eine
 *    Checkliste überarbeitet, verschiebt und formuliert um — ein Speichern je
 *    Zeile hiesse, dass zwischendurch immer eine halb fertige Liste gilt, und
 *    genau die könnte ein Team gerade auf dem Telefon offen haben.
 *
 *  • **Der Erledigt-Zustand bleibt sichtbar und wird nicht angetastet.** Ein
 *    abgehakter Punkt ist ein Nachweis; ihn beim Umbenennen zurückzusetzen
 *    würde geleistete Arbeit unsichtbar machen. Wer *will*, dass alles wieder
 *    offen ist, sagt das ausdrücklich über den Schalter.
 *
 *  • **Standardchecklisten fügen an, statt zu ersetzen.** Der häufige Fall ist
 *    „Grundreinigung plus die zwei Sonderpunkte dieses Objekts", nicht „alles
 *    weg und neu".
 */

export interface ChecklistRow {
  id?: string;
  label: string;
  room: string | null;
  required: boolean;
  done: boolean;
}

const TEMPLATES = [
  { value: 'RESIDENTIAL_CLEANING', label: 'Unterhaltsreinigung Wohnung' },
  { value: 'MOVE_OUT_CLEANING', label: 'Umzugsreinigung' },
  { value: 'OFFICE_CLEANING', label: 'Büroreinigung' },
  { value: 'WINDOW_CLEANING', label: 'Fensterreinigung' },
  { value: 'CONSTRUCTION_CLEANING', label: 'Bauendreinigung' },
  { value: 'BUILDING_MAINTENANCE', label: 'Liegenschaftsunterhalt' },
  { value: 'SPECIAL', label: 'Sonderauftrag' },
] as const;

export function JobChecklistEditor({
  jobId,
  items: initial,
  readOnly = false,
}: {
  jobId: string;
  items: ChecklistRow[];
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = React.useState<ChecklistRow[]>(initial);
  const [keepProgress, setKeepProgress] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [templateOpen, setTemplateOpen] = React.useState(false);
  const [template, setTemplate] = React.useState<string>('RESIDENTIAL_CLEANING');
  const [replace, setReplace] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const dirty = React.useMemo(() => JSON.stringify(rows) !== JSON.stringify(initial), [rows, initial]);

  const update = (index: number, patch: Partial<ChecklistRow>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const move = (index: number, direction: -1 | 1) =>
    setRows((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });

  const save = async () => {
    const invalid = rows.findIndex((row) => row.label.trim().length < 2);
    if (invalid >= 0) {
      setError(`Punkt ${invalid + 1} braucht eine Bezeichnung mit mindestens zwei Zeichen.`);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await api.put(`/api/jobs/${jobId}/checklist`, {
        keepProgress,
        items: rows.map((row) => ({
          id: row.id,
          label: row.label.trim(),
          room: row.room?.trim() || null,
          required: row.required,
        })),
      });
      toast.success('Checkliste gespeichert.');
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Die Checkliste konnte nicht gespeichert werden.';
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const applyTemplate = async () => {
    setSaving(true);
    try {
      await api.post(`/api/jobs/${jobId}/checklist`, { kind: template, replace });
      toast.success('Standardcheckliste übernommen.');
      setTemplateOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Die Vorlage konnte nicht übernommen werden.',
      );
    } finally {
      setSaving(false);
    }
  };

  if (readOnly) {
    return (
      <p className="py-6 text-sm text-muted-foreground">
        Die Checkliste eines abgeschlossenen Einsatzes ist der Nachweis der geleisteten Arbeit und
        wird nicht mehr verändert.
      </p>
    );
  }

  return (
    <div className="space-y-4 py-4">
      {error ? <Alert variant="destructive">{error}</Alert> : null}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Noch keine Punkte. Übernehmen Sie eine Standardcheckliste oder legen Sie einzelne Punkte
          an — ohne Checkliste kann das Team den Einsatz nicht abschliessen.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row, index) => (
            <li
              key={row.id ?? `neu-${index}`}
              className={cn(
                'grid gap-2 rounded-xl border border-border bg-card p-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto_auto]',
                row.done && 'border-success/30 bg-success/[0.04]',
              )}
            >
              <div>
                <Label htmlFor={`cl-label-${index}`} className="sr-only">
                  Punkt {index + 1}
                </Label>
                <Input
                  id={`cl-label-${index}`}
                  value={row.label}
                  onChange={(event) => update(index, { label: event.target.value })}
                  placeholder="Was ist zu tun?"
                />
              </div>

              <div>
                <Label htmlFor={`cl-room-${index}`} className="sr-only">
                  Raum
                </Label>
                <Input
                  id={`cl-room-${index}`}
                  value={row.room ?? ''}
                  onChange={(event) => update(index, { room: event.target.value })}
                  placeholder="Raum (optional)"
                />
              </div>

              <label className="flex items-center gap-2 whitespace-nowrap px-1 text-sm">
                <Checkbox
                  checked={row.required}
                  onCheckedChange={(checked) => update(index, { required: checked === true })}
                />
                Pflicht
              </label>

              <div className="flex items-center gap-0.5">
                {row.done ? (
                  <span className="mr-1 whitespace-nowrap text-xs font-medium text-success">
                    erledigt
                  </span>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  aria-label={`Punkt ${index + 1} nach oben`}
                >
                  <ArrowUp aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => move(index, 1)}
                  disabled={index === rows.length - 1}
                  aria-label={`Punkt ${index + 1} nach unten`}
                >
                  <ArrowDown aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                  aria-label={`Punkt ${index + 1} entfernen`}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 aria-hidden />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            setRows((current) => [...current, { label: '', room: null, required: true, done: false }])
          }
        >
          <Plus aria-hidden />
          Punkt
        </Button>

        <Button type="button" variant="outline" size="sm" onClick={() => setTemplateOpen(true)}>
          <ListChecks aria-hidden />
          Vorlage übernehmen
        </Button>

        <label className="ml-auto flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <Checkbox
            checked={!keepProgress}
            onCheckedChange={(checked) => setKeepProgress(checked !== true)}
          />
          Beim Speichern alle Haken zurücksetzen
        </label>

        <Button type="button" size="sm" onClick={save} loading={saving} disabled={!dirty}>
          <Save aria-hidden />
          Checkliste speichern
        </Button>
      </div>

      <Dialog open={templateOpen} onOpenChange={setTemplateOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Standardcheckliste übernehmen</DialogTitle>
            <DialogDescription>
              Die hinterlegten Punkte je Leistungsart als Ausgangspunkt. Sie lassen sich danach
              beliebig anpassen.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="template-kind">Leistungsart</Label>
              <Select value={template} onValueChange={setTemplate}>
                <SelectTrigger id="template-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TEMPLATES.map((entry) => (
                    <SelectItem key={entry.value} value={entry.value}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <label className="flex cursor-pointer items-start gap-2.5 text-sm">
              <Checkbox
                checked={replace}
                onCheckedChange={(checked) => setReplace(checked === true)}
                className="mt-0.5"
              />
              <span>
                Bestehende Punkte ersetzen
                <span className="block text-xs text-muted-foreground">
                  Ohne Haken werden die Vorlagenpunkte angehängt. Ersetzen verwirft auch bereits
                  gesetzte Haken.
                </span>
              </span>
            </label>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setTemplateOpen(false)}>
              Abbrechen
            </Button>
            <Button onClick={applyTemplate} loading={saving}>
              Übernehmen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
