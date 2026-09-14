'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2, ScrollText, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { PURGE_CONFIRMATION, type PurgeAreaKey } from '@/lib/validation/system';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/controls';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/form';
import { Alert } from '@/components/ui/primitives';

/**
 * Formular der Datenbereinigung.
 *
 * Drei Hürden, bewusst in dieser Reihenfolge: Bereiche ankreuzen (mit den
 * Mengen daneben, damit man sieht, was man tut), die Nummernkreise als
 * eigene Entscheidung, und zuletzt der Bestätigungssatz — getippt, nicht
 * angeklickt. Die Schaltfläche wird erst mit dem richtigen Satz aktiv.
 *
 * Kein Bestätigungsdialog obendrauf: Ein Dialog nach einem getippten Satz
 * wäre die Hürde, die man aus Gewohnheit wegklickt.
 */

interface AreaPreview {
  key: PurgeAreaKey;
  label: string;
  description: string;
  warning?: string;
  sequences: string[];
  counts: { model: string; label: string; count: number }[];
  total: number;
}

interface AreaResult {
  key: PurgeAreaKey;
  label: string;
  deleted: { model: string; label: string; count: number }[];
  total: number;
  sequencesReset: string[];
}

const SEQUENCE_LABELS: Record<string, string> = {
  invoice: 'Rechnungen',
  credit_note: 'Gutschriften',
  quote: 'Offerten',
  booking: 'Buchungen',
  job: 'Einsätze',
  customer: 'Kundennummern',
  lead: 'Anfragen',
  employee: 'Personalnummern',
};

export function PurgeWorkspace({ initialAreas }: { initialAreas: AreaPreview[] }) {
  const router = useRouter();
  const [areas, setAreas] = React.useState(initialAreas);
  const [selected, setSelected] = React.useState<Set<PurgeAreaKey>>(new Set());
  const [resetSequences, setResetSequences] = React.useState(false);
  const [confirmation, setConfirmation] = React.useState('');
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<AreaResult[] | null>(null);

  React.useEffect(() => setAreas(initialAreas), [initialAreas]);

  const confirmed = confirmation.trim() === PURGE_CONFIRMATION;
  const selectedAreas = areas.filter((area) => selected.has(area.key));
  const selectedTotal = selectedAreas.reduce((sum, area) => sum + area.total, 0);
  const sequencesAffected = [...new Set(selectedAreas.flatMap((area) => area.sequences))];
  // Die eine Abhängigkeit, die das Formular schon kennt — der Endpunkt prüft
  // sie noch einmal, aber die Erklärung soll vor dem Klick stehen.
  const crmWithoutFinance =
    selected.has('crm') &&
    !selected.has('finanzen') &&
    (areas.find((area) => area.key === 'finanzen')?.total ?? 0) > 0;

  const toggle = (key: PurgeAreaKey, checked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const result = await api.post<AreaResult[]>('/api/system/purge', {
        bereiche: [...selected],
        bestaetigung: confirmation.trim(),
        nummernkreiseZuruecksetzen: resetSequences,
      });
      setResults(result);
      setSelected(new Set());
      setConfirmation('');
      setResetSequences(false);
      toast.success(
        `${result.reduce((sum, area) => sum + area.total, 0)} Datensätze gelöscht — im Prüfprotokoll festgehalten.`,
      );
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Die Datenbereinigung konnte nicht ausgeführt werden.';
      setError(message);
      toast.error(message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
      {/* Bereiche */}
      <section aria-labelledby="bereiche-titel" className="space-y-3">
        <h2 id="bereiche-titel" className="text-meta uppercase tracking-wide text-muted-foreground">
          Bereiche
        </h2>
        <ul className="space-y-3">
          {areas.map((area) => {
            const checked = selected.has(area.key);
            const empty = area.total === 0;
            return (
              <li key={area.key}>
                <label
                  className={cn(
                    'flex cursor-pointer gap-4 rounded-2xl border bg-card p-5 transition-colors',
                    checked ? 'border-destructive/60 bg-destructive/5' : 'border-border hover:border-primary/40',
                    empty && 'opacity-70',
                  )}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(value) => toggle(area.key, value === true)}
                    disabled={running}
                    aria-label={area.label}
                    className="mt-0.5"
                  />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-display text-base font-semibold">{area.label}</span>
                      <Badge variant={empty ? 'neutral' : checked ? 'destructive' : 'outline'}>
                        {empty ? 'leer' : `${area.total.toLocaleString('de-CH')} Datensätze`}
                      </Badge>
                    </div>
                    <p className="text-sm leading-relaxed text-muted-foreground">{area.description}</p>
                    {area.counts.some((entry) => entry.count > 0) ? (
                      <p className="text-meta tabular-nums text-muted-foreground">
                        {area.counts
                          .filter((entry) => entry.count > 0)
                          .map((entry) => `${entry.count} ${entry.label}`)
                          .join(' · ')}
                      </p>
                    ) : null}
                    {area.warning ? (
                      <p className="flex items-start gap-2 text-meta leading-relaxed text-warning">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                        {area.warning}
                      </p>
                    ) : null}
                  </div>
                </label>
              </li>
            );
          })}
        </ul>
      </section>

      {/* Ausführen */}
      <aside className="space-y-5 rounded-2xl border border-border bg-card p-6 shadow-card lg:sticky lg:top-24">
        <div className="space-y-1">
          <h2 className="font-display text-base font-semibold">Ausführen</h2>
          <p className="text-sm text-muted-foreground">
            {selectedAreas.length === 0
              ? 'Kein Bereich gewählt.'
              : `${selectedAreas.length} ${selectedAreas.length === 1 ? 'Bereich' : 'Bereiche'} · ${selectedTotal.toLocaleString('de-CH')} Datensätze`}
          </p>
        </div>

        {crmWithoutFinance ? (
          <Alert variant="warning" title="Finanzen mitwählen">
            Rechnungen und Gutschriften halten ihre Kundschaft fest. Wählen Sie den Bereich
            «Finanzen» mit, sonst weist der Server den Lauf zurück.
          </Alert>
        ) : null}

        <label
          className={cn(
            'flex items-start gap-3 rounded-xl border border-border p-3 text-sm',
            sequencesAffected.length === 0 && 'opacity-60',
          )}
        >
          <Checkbox
            checked={resetSequences}
            onCheckedChange={(value) => setResetSequences(value === true)}
            disabled={running || sequencesAffected.length === 0}
            className="mt-0.5"
          />
          <span className="space-y-1">
            <span className="block font-medium">Nummernkreise neu beginnen</span>
            <span className="block text-meta leading-relaxed text-muted-foreground">
              {sequencesAffected.length === 0
                ? 'Die gewählten Bereiche verbrauchen keine Belegnummern.'
                : `Betrifft: ${sequencesAffected.map((scope) => SEQUENCE_LABELS[scope] ?? scope).join(', ')}. Vor dem Livegang sinnvoll — im laufenden Betrieb nicht, die Rechnungsfolge muss lückenlos bleiben.`}
            </span>
          </span>
        </label>

        <div className="space-y-2">
          <Label htmlFor="purge-confirmation">
            Zur Bestätigung <span className="font-semibold">{PURGE_CONFIRMATION}</span> eingeben
          </Label>
          <Input
            id="purge-confirmation"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder={PURGE_CONFIRMATION}
            autoComplete="off"
            spellCheck={false}
            disabled={running}
            aria-invalid={confirmation.length > 0 && !confirmed ? true : undefined}
          />
        </div>

        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <Button
          variant="destructive"
          width="full"
          size="lg"
          onClick={run}
          disabled={running || selectedAreas.length === 0 || !confirmed || crmWithoutFinance}
        >
          {running ? <Loader2 className="animate-spin" aria-hidden /> : <Trash2 aria-hidden />}
          {running ? 'Wird gelöscht …' : 'Endgültig löschen'}
        </Button>

        {results ? (
          <div className="space-y-3 border-t border-border pt-4">
            <p className="flex items-center gap-2 text-sm font-medium">
              <ScrollText className="size-4 text-primary" aria-hidden />
              Letzter Lauf — im Prüfprotokoll festgehalten
            </p>
            <ul className="space-y-2 text-sm">
              {results.map((area) => (
                <li key={area.key} className="rounded-xl bg-muted/60 px-3 py-2">
                  <span className="font-medium">{area.label}</span>
                  <span className="block text-meta tabular-nums text-muted-foreground">
                    {area.total === 0
                      ? 'nichts zu löschen'
                      : area.deleted
                          .filter((entry) => entry.count > 0)
                          .map((entry) => `${entry.count} ${entry.label}`)
                          .join(' · ')}
                    {area.sequencesReset.length > 0
                      ? ` · Nummernkreise zurückgesetzt: ${area.sequencesReset.map((scope) => SEQUENCE_LABELS[scope] ?? scope).join(', ')}`
                      : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </aside>
    </div>
  );
}
