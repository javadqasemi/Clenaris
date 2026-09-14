'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Calculator } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { SCENARIO_DRIVER_LABELS } from '@/lib/bi/labels';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DetailSection } from '@/components/app/page-parts';

/**
 * Annahmen eines Szenarios bearbeiten.
 *
 * Zwei Spalten je Treiber: Wert und monatliche Veränderung. Speichern
 * ersetzt die Annahmen als Ganzes und rechnet neu — das Ergebnis erscheint
 * nach dem Neuladen der Seite, weil es dort aus der Datenbank kommt und
 * nicht aus dem Formular.
 */

export interface AssumptionView {
  key: string;
  label: string;
  value: number;
  unit: string;
  monthlyChangePct: number;
  sortOrder: number;
}

const UNIT_SUFFIX: Record<string, string> = { CURRENCY: 'CHF', PERCENT: '%', DAYS: 'Tage', HOURS: 'h', COUNT: '', RATIO: '' };

export function ScenarioEditor({ scenarioId, assumptions, canEdit }: { scenarioId: string; assumptions: AssumptionView[]; canEdit: boolean }) {
  const router = useRouter();
  const [rows, setRows] = React.useState(() =>
    assumptions.map((a) => ({ ...a, valueText: String(a.value), changeText: String(a.monthlyChangePct) })),
  );
  const [saving, setSaving] = React.useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/api/bi/scenarios/${scenarioId}`, {
        assumptions: rows.map((r, i) => ({
          key: r.key,
          label: r.label,
          value: Number(r.valueText.replace(',', '.')) || 0,
          unit: r.unit,
          monthlyChangePct: Number(r.changeText.replace(',', '.')) || 0,
          sortOrder: i,
        })),
      });
      toast.success('Annahmen gespeichert und neu gerechnet.');
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Speichern fehlgeschlagen.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <DetailSection
      title="Annahmen"
      description="Treiber, nicht Ergebnisse. Die Veränderung je Monat bildet Wachstum ab, ohne zwölf Einzelwerte."
      body="flush"
      action={
        canEdit ? (
          <Button size="sm" loading={saving} onClick={save}>
            <Calculator aria-hidden />
            Speichern und rechnen
          </Button>
        ) : null
      }
    >
      <ul className="divide-y divide-border">
        {rows.map((row, index) => {
          const meta = SCENARIO_DRIVER_LABELS[row.key];
          return (
            <li key={row.key} className="grid gap-3 px-6 py-3.5 sm:grid-cols-[minmax(0,1fr)_9rem_8rem] sm:items-center">
              <div className="min-w-0">
                <p className="text-sm font-medium">{meta?.label ?? row.label}</p>
                {meta?.hint ? <p className="text-xs text-muted-foreground">{meta.hint}</p> : null}
              </div>
              <Input
                className="h-9"
                inputMode="decimal"
                suffix={UNIT_SUFFIX[row.unit] || undefined}
                value={row.valueText}
                disabled={!canEdit}
                aria-label={`${meta?.label ?? row.label}: Wert`}
                onChange={(e) => setRows((r) => r.map((x, i) => (i === index ? { ...x, valueText: e.target.value } : x)))}
              />
              <Input
                className="h-9"
                inputMode="decimal"
                suffix="% / Mt."
                value={row.changeText}
                disabled={!canEdit}
                aria-label={`${meta?.label ?? row.label}: Veränderung je Monat`}
                onChange={(e) => setRows((r) => r.map((x, i) => (i === index ? { ...x, changeText: e.target.value } : x)))}
              />
            </li>
          );
        })}
      </ul>
    </DetailSection>
  );
}
