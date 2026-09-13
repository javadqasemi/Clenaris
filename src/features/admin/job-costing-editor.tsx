'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { BadgeCheck, RefreshCw, Save } from 'lucide-react';
import { toast } from 'sonner';

import { cn, formatCurrency, round2 } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/form';
import { Alert } from '@/components/ui/primitives';

/**
 * Nachkalkulation eines Einsatzes.
 *
 * Gestaltungsentscheide:
 *
 *  • **Der Deckungsbeitrag steht gross und rechnet mit.** Er ist die einzige
 *    Zahl, wegen der jemand diese Karte öffnet; Umsatz, Lohn und Material sind
 *    die Stellschrauben dazu.
 *
 *  • **„Neu berechnen" und „Speichern" sind zwei Knöpfe, keiner davon
 *    automatisch.** Neu berechnen verwirft die Werte von Hand — das darf nie
 *    als Nebenwirkung des Speicherns passieren. Deshalb fragt es nach.
 *
 *  • **Abnehmen ist ein eigener, letzter Schritt.** Er setzt den Einsatz auf
 *    „kontrolliert" und macht ihn abrechnungsreif. Solange die Zahlen offen
 *    sind, wird nicht abgenommen.
 */
export function JobCostingEditor({
  jobId,
  revenue: initialRevenue,
  laborCost: initialLabor,
  materialCost: initialMaterial,
  status,
  trackedMinutes,
}: {
  jobId: string;
  revenue: number;
  laborCost: number;
  materialCost: number;
  status: string;
  /** Erfasste Arbeitszeit — als Plausibilitätsanker neben den Lohnkosten. */
  trackedMinutes: number;
}) {
  const router = useRouter();
  const [revenue, setRevenue] = React.useState(String(initialRevenue));
  const [laborCost, setLaborCost] = React.useState(String(initialLabor));
  const [materialCost, setMaterialCost] = React.useState(String(initialMaterial));
  const [pending, setPending] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmRecalc, setConfirmRecalc] = React.useState(false);

  const numbers = {
    revenue: Number(revenue.replace(',', '.')) || 0,
    laborCost: Number(laborCost.replace(',', '.')) || 0,
    materialCost: Number(materialCost.replace(',', '.')) || 0,
  };
  const margin = round2(numbers.revenue - numbers.laborCost - numbers.materialCost);
  const marginPct = numbers.revenue > 0 ? (margin / numbers.revenue) * 100 : 0;

  const dirty =
    numbers.revenue !== initialRevenue ||
    numbers.laborCost !== initialLabor ||
    numbers.materialCost !== initialMaterial;

  const completed = ['COMPLETED', 'VERIFIED'].includes(status);
  const approved = status === 'VERIFIED';

  const run = async (action: string, body: Record<string, unknown>, message: string) => {
    setPending(action);
    setError(null);
    try {
      const result = await api.patch<{
        revenue: number;
        laborCost: number;
        materialCost: number;
      }>(`/api/jobs/${jobId}/costing`, body);

      setRevenue(String(result.revenue));
      setLaborCost(String(result.laborCost));
      setMaterialCost(String(result.materialCost));
      setConfirmRecalc(false);
      toast.success(message);
      router.refresh();
    } catch (err) {
      const text =
        err instanceof ApiError ? err.message : 'Die Nachkalkulation konnte nicht gespeichert werden.';
      setError(text);
      toast.error(text);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="space-y-4 py-4">
      {error ? <Alert variant="destructive">{error}</Alert> : null}

      {approved ? (
        <Alert variant="success" title="Abgenommen">
          Dieser Einsatz ist kontrolliert und abrechnungsreif. Änderungen an den Zahlen bleiben
          möglich, sind aber im Prüfprotokoll festgehalten.
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="costing-revenue">Umsatz</Label>
          <Input
            id="costing-revenue"
            inputMode="decimal"
            suffix="CHF"
            value={revenue}
            onChange={(event) => setRevenue(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="costing-labor">Lohnkosten</Label>
          <Input
            id="costing-labor"
            inputMode="decimal"
            suffix="CHF"
            value={laborCost}
            onChange={(event) => setLaborCost(event.target.value)}
          />
          {trackedMinutes > 0 ? (
            <p className="text-xs text-muted-foreground">
              {(trackedMinutes / 60).toFixed(2)} Stunden erfasst
            </p>
          ) : (
            <p className="text-xs text-warning">Keine Zeit erfasst</p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="costing-material">Material</Label>
          <Input
            id="costing-material"
            inputMode="decimal"
            suffix="CHF"
            value={materialCost}
            onChange={(event) => setMaterialCost(event.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-baseline justify-between gap-3 rounded-xl border border-border bg-muted/40 p-4">
        <span className="text-sm text-muted-foreground">Deckungsbeitrag</span>
        <span
          className={cn(
            'font-display text-2xl font-bold tabular-nums',
            margin >= 0 ? 'text-success' : 'text-destructive',
          )}
        >
          {formatCurrency(margin)}
          {numbers.revenue > 0 ? (
            <span className="ml-2 text-sm font-medium">({marginPct.toFixed(1)} %)</span>
          ) : null}
        </span>
      </div>

      {confirmRecalc ? (
        <Alert variant="warning" title="Werte neu herleiten?">
          <span className="space-y-3">
            <span className="block">
              Lohnkosten aus der erfassten Zeit, Material aus dem erfassten Verbrauch, Umsatz aus
              dem Auftrag. Von Hand gesetzte Werte gehen dabei verloren.
            </span>
            <span className="flex flex-wrap gap-2">
              <Button
                size="sm"
                loading={pending === 'recalculate'}
                onClick={() =>
                  run('recalculate', { recalculate: true }, 'Nachkalkulation neu berechnet.')
                }
              >
                Neu berechnen
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmRecalc(false)}>
                Abbrechen
              </Button>
            </span>
          </span>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setConfirmRecalc(true)}
          disabled={confirmRecalc}
        >
          <RefreshCw aria-hidden />
          Neu berechnen
        </Button>

        <Button
          type="button"
          size="sm"
          disabled={!dirty}
          loading={pending === 'save'}
          onClick={() => run('save', numbers, 'Nachkalkulation gespeichert.')}
        >
          <Save aria-hidden />
          Speichern
        </Button>

        {completed && !approved ? (
          <Button
            type="button"
            variant="success"
            size="sm"
            className="ml-auto"
            loading={pending === 'approve'}
            onClick={() =>
              run(
                'approve',
                { ...numbers, approve: true },
                'Nachkalkulation abgenommen — der Einsatz ist abrechnungsreif.',
              )
            }
          >
            <BadgeCheck aria-hidden />
            Abnehmen
          </Button>
        ) : null}
      </div>

      {!completed ? (
        <p className="text-xs text-muted-foreground">
          Abnehmen ist erst möglich, wenn der Einsatz abgeschlossen ist — vorher wäre die
          Nachkalkulation eine Momentaufnahme.
        </p>
      ) : null}
    </div>
  );
}
