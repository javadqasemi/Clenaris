'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import { ANALYSIS_BUCKET_LABELS } from '@/lib/bi/labels';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/form';

/**
 * SWOT- und PESTEL-Tafel als Raster.
 *
 * Vier bzw. sechs Felder, je eine Liste mit Titel, Begründung und Gewicht.
 * Gespeichert wird die Tafel als Ganzes — so bearbeitet man sie auch: in der
 * Sitzung, alle Felder nebeneinander. Eine abgelöste Fassung ist nur lesbar.
 */

export interface BoardEntry {
  bucket: string;
  title: string;
  detail: string | null;
  weight: number;
  sortOrder: number;
}

const SWOT = ['STRENGTH', 'WEAKNESS', 'OPPORTUNITY', 'THREAT'];
const PESTEL = ['POLITICAL', 'ECONOMIC', 'SOCIAL', 'TECHNOLOGICAL', 'ENVIRONMENTAL', 'LEGAL'];

const BUCKET_TONE: Record<string, string> = {
  STRENGTH: 'border-success/40 bg-success/5',
  WEAKNESS: 'border-destructive/40 bg-destructive/5',
  OPPORTUNITY: 'border-primary/40 bg-primary/5',
  THREAT: 'border-warning/40 bg-warning/5',
};

export function AnalysisBoardEditor({
  mode,
  kind,
  boardId,
  title: initialTitle,
  summary: initialSummary,
  preparedOn,
  entries: initialEntries,
  readOnly,
  supersedesId,
}: {
  mode: 'create' | 'edit';
  kind: 'SWOT' | 'PESTEL';
  boardId?: string;
  title?: string;
  summary?: string | null;
  preparedOn?: string;
  entries?: BoardEntry[];
  readOnly?: boolean;
  /** Beim Anlegen: die Tafel, die abgelöst wird. */
  supersedesId?: string;
}) {
  const router = useRouter();
  const buckets = kind === 'SWOT' ? SWOT : PESTEL;
  const [title, setTitle] = React.useState(initialTitle ?? `${kind}-Analyse ${new Date().getFullYear()}`);
  const [summary, setSummary] = React.useState(initialSummary ?? '');
  const [date, setDate] = React.useState(preparedOn ?? new Date().toISOString().slice(0, 10));
  const [entries, setEntries] = React.useState<BoardEntry[]>(initialEntries ?? []);
  const [saving, setSaving] = React.useState(false);

  const ofBucket = (bucket: string) => entries.map((e, i) => ({ e, i })).filter((x) => x.e.bucket === bucket);
  const add = (bucket: string) => setEntries((list) => [...list, { bucket, title: '', detail: '', weight: 3, sortOrder: list.length }]);
  const update = (index: number, patch: Partial<BoardEntry>) => setEntries((list) => list.map((e, i) => (i === index ? { ...e, ...patch } : e)));
  const remove = (index: number) => setEntries((list) => list.filter((_, i) => i !== index));

  const save = async () => {
    const clean = entries.filter((e) => e.title.trim().length >= 2).map((e, i) => ({ bucket: e.bucket, title: e.title.trim(), detail: e.detail?.trim() || undefined, weight: e.weight, sortOrder: i }));
    setSaving(true);
    try {
      if (mode === 'create') {
        const created = await api.post<{ id: string }>('/api/bi/analysis', { kind, title, preparedOn: date, summary: summary || undefined, entries: clean, supersedesId });
        toast.success('Tafel angelegt.');
        router.push(`/admin/fuehrung/markt/analyse/${created.id}`);
      } else {
        await api.patch(`/api/bi/analysis/${boardId}`, { title, preparedOn: date, summary: summary || null, entries: clean });
        toast.success('Tafel gespeichert.');
      }
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Speichern fehlgeschlagen.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {!readOnly ? (
        <div className="grid gap-4 rounded-2xl border border-border bg-card p-5 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <div className="space-y-2">
            <Label htmlFor="board-title" required>Titel</Label>
            <Input id="board-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="board-date">Stichtag</Label>
            <Input id="board-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="board-summary">Fazit</Label>
            <Textarea id="board-summary" rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Was folgt aus der Analyse?" />
          </div>
        </div>
      ) : null}

      <div className={cn('grid gap-4', kind === 'SWOT' ? 'md:grid-cols-2' : 'md:grid-cols-2 xl:grid-cols-3')}>
        {buckets.map((bucket) => (
          <section key={bucket} className={cn('rounded-2xl border p-4', BUCKET_TONE[bucket] ?? 'border-border bg-card')} aria-label={ANALYSIS_BUCKET_LABELS[bucket]}>
            <header className="mb-3 flex items-center justify-between gap-2">
              <h3 className="font-display text-base font-semibold">{ANALYSIS_BUCKET_LABELS[bucket]}</h3>
              {!readOnly ? (
                <Button variant="ghost" size="sm" onClick={() => add(bucket)}>
                  <Plus aria-hidden />
                  Punkt
                </Button>
              ) : null}
            </header>
            <ul className="space-y-3">
              {ofBucket(bucket).map(({ e, i }) => (
                <li key={i} className="rounded-xl bg-card/80 p-3">
                  {readOnly ? (
                    <>
                      <p className="text-sm font-medium">
                        {e.title} <span className="ml-1 text-xs text-muted-foreground">Gewicht {e.weight}</span>
                      </p>
                      {e.detail ? <p className="mt-1 text-sm text-muted-foreground">{e.detail}</p> : null}
                    </>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Input className="h-9" placeholder="Stichwort" value={e.title} onChange={(ev) => update(i, { title: ev.target.value })} aria-label="Stichwort" />
                        <Input className="h-9 w-16 text-center" inputMode="numeric" value={String(e.weight)} onChange={(ev) => update(i, { weight: Math.max(1, Math.min(5, Number(ev.target.value) || 3)) })} aria-label="Gewicht 1 bis 5" />
                        <Button variant="ghost" size="icon-sm" aria-label="Entfernen" onClick={() => remove(i)}>
                          <Trash2 aria-hidden />
                        </Button>
                      </div>
                      <Textarea rows={2} placeholder="Begründung in einem Satz" value={e.detail ?? ''} onChange={(ev) => update(i, { detail: ev.target.value })} aria-label="Begründung" />
                    </div>
                  )}
                </li>
              ))}
              {ofBucket(bucket).length === 0 ? <li className="text-sm text-muted-foreground">Keine Einträge.</li> : null}
            </ul>
          </section>
        ))}
      </div>

      {!readOnly ? (
        <div className="flex justify-end">
          <Button loading={saving} onClick={save}>
            <Save aria-hidden />
            {mode === 'create' ? 'Tafel anlegen' : 'Tafel speichern'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
