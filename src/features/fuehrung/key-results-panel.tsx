'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { formatDateTime } from '@/lib/utils';
import { formatKpiValue, KPI_PERIOD_LABELS, KPI_UNIT_LABELS } from '@/lib/bi/labels';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/primitives';
import { DetailSection } from '@/components/app/page-parts';
import { FormDialog } from './resource-form';

/**
 * Schlüsselergebnisse eines Ziels mit Check-in.
 *
 * Der Check-in ist eine Zeile, kein Dialog: Wert, Kommentar, Häkchen. Wer am
 * Freitag fünf Schlüsselergebnisse nachführt, will nicht fünf Dialoge öffnen.
 * Automatische Schlüsselergebnisse zeigen statt der Eingabe die Kennzahl, aus
 * der sie sich speisen.
 */

export interface KeyResultView {
  id: string;
  title: string;
  unit: string;
  direction: string;
  startValue: number;
  targetValue: number;
  currentValue: number;
  progressPct: number;
  lastCheckinAt: string | null;
  kpiPeriod: string | null;
  definition: { id: string; key: string; label: string } | null;
  checkins: { id: string; value: number; comment: string | null; automatic: boolean; recordedAt: string; author: { firstName: string; lastName: string } | null }[];
}

export function KeyResultsPanel({
  objectiveId,
  keyResults,
  kpis,
  canEdit,
  canCheckin,
}: {
  objectiveId: string;
  keyResults: KeyResultView[];
  kpis: { id: string; label: string; unit: string }[];
  canEdit: boolean;
  canCheckin: boolean;
}) {
  const router = useRouter();
  const [values, setValues] = React.useState<Record<string, { value: string; comment: string }>>({});
  const [busy, setBusy] = React.useState<string | null>(null);

  const checkin = async (kr: KeyResultView) => {
    const entry = values[kr.id];
    if (!entry || entry.value.trim() === '') return;
    setBusy(kr.id);
    try {
      await api.post(`/api/bi/key-results/${kr.id}/checkin`, { value: Number(entry.value.replace(',', '.')), comment: entry.comment.trim() || undefined });
      toast.success('Check-in gespeichert.');
      setValues((v) => ({ ...v, [kr.id]: { value: '', comment: '' } }));
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Check-in fehlgeschlagen.');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (kr: KeyResultView) => {
    if (!window.confirm(`Schlüsselergebnis „${kr.title}" löschen?`)) return;
    try {
      await api.delete(`/api/bi/key-results/${kr.id}`);
      toast.success('Gelöscht.');
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Löschen fehlgeschlagen.');
    }
  };

  return (
    <DetailSection
      title="Schlüsselergebnisse"
      description="Messbar, mit Start-, Ziel- und aktuellem Wert. Automatische Ergebnisse folgen einer Kennzahl."
      body="flush"
      action={
        canEdit ? (
          <FormDialog
            title="Schlüsselergebnis anlegen"
            description="Mit Kennzahl rechnet es sich selbst aus dem Nachtlauf; ohne wird es manuell nachgeführt."
            triggerLabel="Schlüsselergebnis"
            triggerVariant="outline"
            triggerSize="sm"
            endpoint={`/api/bi/objectives/${objectiveId}/key-results`}
            successMessage="Schlüsselergebnis angelegt."
            fields={[
              { name: 'title', label: 'Titel', required: true, placeholder: 'z. B. Annahmequote auf 45 % heben' },
              { name: 'kpiDefinitionId', label: 'Kennzahl (automatisch)', type: 'select', half: true, options: kpis.map((k) => ({ value: k.id, label: k.label })), placeholder: 'Manuell' },
              { name: 'kpiPeriod', label: 'Periode der Kennzahl', type: 'select', half: true, options: Object.entries(KPI_PERIOD_LABELS).map(([value, label]) => ({ value, label })), placeholder: 'Nur bei Kennzahl' },
              { name: 'unit', label: 'Einheit', type: 'select', half: true, options: Object.entries(KPI_UNIT_LABELS).map(([value, label]) => ({ value, label })), required: true },
              { name: 'direction', label: 'Richtung', type: 'select', half: true, options: [{ value: 'UP_IS_GOOD', label: 'Mehr ist besser' }, { value: 'DOWN_IS_GOOD', label: 'Weniger ist besser' }], required: true },
              { name: 'startValue', label: 'Startwert', type: 'number', half: true, required: true },
              { name: 'targetValue', label: 'Zielwert', type: 'number', half: true, required: true },
            ]}
            values={{ unit: 'COUNT', direction: 'UP_IS_GOOD', startValue: 0 }}
          />
        ) : null
      }
    >
      {keyResults.length === 0 ? (
        <p className="px-6 py-8 text-center text-sm text-muted-foreground">Noch keine Schlüsselergebnisse. Ein Ziel ohne Messgrösse bleibt ein Wunsch.</p>
      ) : (
        <ul className="divide-y divide-border">
          {keyResults.map((kr) => {
            const automatic = Boolean(kr.definition);
            const entry = values[kr.id] ?? { value: '', comment: '' };
            const stale = !automatic && (!kr.lastCheckinAt || Date.now() - new Date(kr.lastCheckinAt).getTime() > 30 * 86_400_000);
            return (
              <li key={kr.id} className="space-y-3 px-6 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <p className="font-medium">{kr.title}</p>
                    <p className="text-sm text-muted-foreground">
                      {formatKpiValue(kr.startValue, kr.unit)} → <span className="font-medium text-foreground">{formatKpiValue(kr.currentValue, kr.unit)}</span> → Ziel {formatKpiValue(kr.targetValue, kr.unit)}
                      {kr.lastCheckinAt ? ` · zuletzt ${formatDateTime(kr.lastCheckinAt)}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {automatic ? <Badge variant="info" size="sm">Kennzahl: {kr.definition!.label}</Badge> : <Badge variant="neutral" size="sm">Manuell</Badge>}
                    {stale ? <Badge variant="warning" size="sm">Check-in überfällig</Badge> : null}
                    <span className="text-sm font-semibold tabular-nums">{kr.progressPct} %</span>
                    {canEdit ? (
                      <Button variant="ghost" size="icon-sm" aria-label="Löschen" onClick={() => remove(kr)}>
                        <Trash2 aria-hidden />
                      </Button>
                    ) : null}
                  </div>
                </div>
                <Progress value={kr.progressPct} aria-label={`Fortschritt ${kr.progressPct} %`} />
                {!automatic && canCheckin ? (
                  <form
                    className="flex flex-wrap items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      checkin(kr);
                    }}
                  >
                    <Input className="h-9 w-32" inputMode="decimal" placeholder="Neuer Wert" value={entry.value} onChange={(e) => setValues((v) => ({ ...v, [kr.id]: { ...entry, value: e.target.value } }))} aria-label={`Neuer Wert für ${kr.title}`} />
                    <Input className="h-9 min-w-48 flex-1" placeholder="Kommentar (optional)" value={entry.comment} onChange={(e) => setValues((v) => ({ ...v, [kr.id]: { ...entry, comment: e.target.value } }))} aria-label="Kommentar" />
                    <Button type="submit" size="sm" variant="outline" loading={busy === kr.id} disabled={entry.value.trim() === ''}>
                      <Check aria-hidden />
                      Check-in
                    </Button>
                  </form>
                ) : null}
                {kr.checkins.length > 0 ? (
                  <details className="text-sm">
                    <summary className="cursor-pointer text-muted-foreground">Verlauf ({kr.checkins.length})</summary>
                    <ul className="mt-2 space-y-1 text-muted-foreground">
                      {kr.checkins.map((c) => (
                        <li key={c.id} className="flex flex-wrap gap-x-3">
                          <span className="tabular-nums text-foreground">{formatKpiValue(c.value, kr.unit)}</span>
                          <span>{formatDateTime(c.recordedAt)}</span>
                          <span>{c.automatic ? 'Nachtlauf' : c.author ? `${c.author.firstName} ${c.author.lastName}` : ''}</span>
                          {c.comment ? <span className="italic">{`„${c.comment}"`}</span> : null}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </DetailSection>
  );
}
