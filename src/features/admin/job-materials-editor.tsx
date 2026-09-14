'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Package, Plus, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { formatCurrency, round2 } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/controls';
import { Alert } from '@/components/ui/primitives';

/**
 * Materialverbrauch eines Einsatzes erfassen.
 *
 * **Warum eine Tabelle zum Tippen und kein Dialog je Position.** Material
 * wird nach dem Einsatz in einem Zug nachgetragen: drei, vier Zeilen vom
 * Lieferschein. Ein Dialog je Zeile wäre viermal öffnen, tippen, speichern —
 * die Tabelle ist einmal tippen, einmal speichern. Der Endpunkt setzt den
 * Verbrauch ohnehin *vollständig* (PUT), also gibt es genau einen Zustand,
 * der gespeichert wird: die Tabelle, wie sie dasteht.
 *
 * Der Betrag je Zeile rechnet mit (Menge mal Stückpreis) und die Summe unten
 * ist exakt das, was der Server als Materialaufwand in die Nachkalkulation
 * schreibt — die Rechnung steht in `replaceJobMaterials`, hier wird sie nur
 * vorweggenommen, damit niemand nach dem Speichern überrascht ist.
 */
export interface MaterialRow {
  name: string;
  sku: string | null;
  quantity: number;
  unit: string;
  unitCost: number;
  billable: boolean;
}

interface DraftRow {
  key: number;
  name: string;
  sku: string;
  quantity: string;
  unit: string;
  unitCost: string;
  billable: boolean;
}

const toNumber = (text: string) => Number(text.replace(',', '.')) || 0;

function toDraft(rows: MaterialRow[]): DraftRow[] {
  return rows.map((row, index) => ({
    key: index,
    name: row.name,
    sku: row.sku ?? '',
    quantity: String(row.quantity),
    unit: row.unit,
    unitCost: String(row.unitCost),
    billable: row.billable,
  }));
}

function toPayload(rows: DraftRow[]) {
  return rows.map((row) => ({
    name: row.name.trim(),
    sku: row.sku.trim() || null,
    quantity: toNumber(row.quantity),
    unit: row.unit.trim() || 'Stk.',
    unitCost: toNumber(row.unitCost),
    billable: row.billable,
  }));
}

export function JobMaterialsEditor({
  jobId,
  materials: initial,
  readOnly = false,
}: {
  jobId: string;
  materials: MaterialRow[];
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = React.useState<DraftRow[]>(() => toDraft(initial));
  const [nextKey, setNextKey] = React.useState(initial.length);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const total = round2(
    rows.reduce((sum, row) => sum + toNumber(row.quantity) * toNumber(row.unitCost), 0),
  );

  const dirty = React.useMemo(
    () => JSON.stringify(toPayload(rows)) !== JSON.stringify(toPayload(toDraft(initial))),
    [rows, initial],
  );

  const update = (key: number, patch: Partial<DraftRow>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const add = () => {
    setRows((current) => [
      ...current,
      { key: nextKey, name: '', sku: '', quantity: '1', unit: 'Stk.', unitCost: '', billable: false },
    ]);
    setNextKey((key) => key + 1);
  };

  const save = async () => {
    setError(null);
    const payload = toPayload(rows);
    const incomplete = payload.find((row) => row.name.length < 2 || row.quantity <= 0);
    if (incomplete) {
      setError('Jede Position braucht eine Bezeichnung und eine Menge grösser als null.');
      return;
    }

    setSaving(true);
    try {
      const result = await api.put<{ materialCost: number }>(`/api/jobs/${jobId}/costing`, {
        materials: payload,
      });
      toast.success(
        payload.length === 0
          ? 'Material entfernt.'
          : `Material gespeichert — ${formatCurrency(result.materialCost)} in der Nachkalkulation.`,
      );
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Das Material konnte nicht gespeichert werden.';
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  if (readOnly) {
    return initial.length === 0 ? (
      <p className="py-6 text-sm text-muted-foreground">Kein Material erfasst.</p>
    ) : (
      <ul className="protocol-list">
        {initial.map((material, index) => (
          <li key={index} className="flex items-center justify-between gap-4 py-3">
            <span className="flex items-center gap-2 text-sm">
              <Package className="size-4 text-muted-foreground" aria-hidden />
              {material.name}
              {material.billable ? <span className="text-xs text-primary">verrechenbar</span> : null}
            </span>
            <span className="text-sm tabular-nums">
              {material.quantity} {material.unit} ·{' '}
              {formatCurrency(round2(material.quantity * material.unitCost))}
            </span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="space-y-4 py-4">
      {error ? <Alert variant="destructive">{error}</Alert> : null}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Noch kein Material erfasst. Positionen mit Stückpreis fliessen als Materialaufwand in
          die Nachkalkulation.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="text-left text-2xs uppercase tracking-wide text-muted-foreground">
                <th className="pb-2 pr-3 font-medium">Bezeichnung</th>
                <th className="pb-2 pr-3 font-medium">Menge</th>
                <th className="pb-2 pr-3 font-medium">Einheit</th>
                <th className="pb-2 pr-3 font-medium">Stückpreis</th>
                <th className="pb-2 pr-3 text-right font-medium">Betrag</th>
                <th className="pb-2 pr-3 font-medium">Verrechenbar</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-t border-border align-middle">
                  <td className="py-2 pr-3">
                    <Input
                      value={row.name}
                      onChange={(event) => update(row.key, { name: event.target.value })}
                      placeholder="z. B. Allzweckreiniger 5 l"
                      aria-label="Bezeichnung"
                      className="h-9"
                    />
                  </td>
                  <td className="py-2 pr-3">
                    <Input
                      inputMode="decimal"
                      value={row.quantity}
                      onChange={(event) => update(row.key, { quantity: event.target.value })}
                      aria-label="Menge"
                      className="h-9 w-20 tabular-nums"
                    />
                  </td>
                  <td className="py-2 pr-3">
                    <Input
                      value={row.unit}
                      onChange={(event) => update(row.key, { unit: event.target.value })}
                      aria-label="Einheit"
                      className="h-9 w-20"
                    />
                  </td>
                  <td className="py-2 pr-3">
                    <Input
                      inputMode="decimal"
                      value={row.unitCost}
                      onChange={(event) => update(row.key, { unitCost: event.target.value })}
                      placeholder="0.00"
                      suffix="CHF"
                      aria-label="Stückpreis"
                      className="h-9 w-32 tabular-nums"
                    />
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatCurrency(round2(toNumber(row.quantity) * toNumber(row.unitCost)))}
                  </td>
                  <td className="py-2 pr-3">
                    <Checkbox
                      checked={row.billable}
                      onCheckedChange={(checked) => update(row.key, { billable: checked === true })}
                      aria-label="Der Kundschaft verrechenbar"
                    />
                  </td>
                  <td className="py-2 text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                      aria-label={`${row.name || 'Position'} entfernen`}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border">
                <td colSpan={4} className="pt-3 text-sm text-muted-foreground">
                  Materialaufwand
                </td>
                <td className="pt-3 text-right font-medium tabular-nums">{formatCurrency(total)}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={add}>
          <Plus aria-hidden />
          Position hinzufügen
        </Button>
        <Button
          type="button"
          size="sm"
          className="ml-auto"
          onClick={save}
          loading={saving}
          disabled={!dirty}
        >
          <Save aria-hidden />
          Material speichern
        </Button>
      </div>
    </div>
  );
}
