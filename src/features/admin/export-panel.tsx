'use client';

import * as React from 'react';
import { Download, FileSpreadsheet, Table2 } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/form';
import { Checkbox } from '@/components/ui/controls';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/controls';

/**
 * Exporte für Buchhaltung und Auswertung.
 *
 * Die Buchhaltungsformate erzeugen fertige Buchungssätze mit Konten aus dem
 * Schweizer KMU-Kontenrahmen. Damit kann die Treuhandstelle direkt einlesen,
 * statt Belege abzutippen — das ist der grösste einzelne Zeitgewinn im
 * Monatsabschluss.
 */
const ACCOUNTING_FORMATS = [
  { value: 'csv', label: 'CSV (generisch)' },
  { value: 'bexio', label: 'bexio' },
  { value: 'abacus', label: 'Abacus' },
  { value: 'banana', label: 'Banana Buchhaltung' },
  { value: 'datev', label: 'DATEV' },
];

const INCLUDE_OPTIONS = [
  { value: 'invoices', label: 'Rechnungen' },
  { value: 'payments', label: 'Zahlungen' },
  { value: 'expenses', label: 'Ausgaben' },
  { value: 'credit_notes', label: 'Gutschriften' },
] as const;

export function ExportPanel({
  defaultFrom,
  defaultTo,
}: {
  defaultFrom: string;
  defaultTo: string;
}) {
  const [from, setFrom] = React.useState(defaultFrom);
  const [to, setTo] = React.useState(defaultTo);
  const [format, setFormat] = React.useState('csv');
  const [include, setInclude] = React.useState<string[]>(['invoices', 'payments', 'expenses']);
  const [pending, setPending] = React.useState<string | null>(null);

  const downloadExcel = async (kind: 'rechnungen' | 'kunden' | 'zeiterfassung') => {
    setPending(kind);
    try {
      await api.download(`/api/exports/${kind}`, undefined, { from, to });
      toast.success('Export heruntergeladen.');
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'Der Export konnte nicht erstellt werden.',
      );
    } finally {
      setPending(null);
    }
  };

  const downloadAccounting = async () => {
    setPending('accounting');
    try {
      const response = await fetch('/api/exports/buchhaltung', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format, periodFrom: from, periodTo: to, include }),
      });

      if (!response.ok) {
        const payload = (await response.json()) as { error?: { message?: string } };
        throw new Error(payload.error?.message ?? 'Export fehlgeschlagen');
      }

      const blob = await response.blob();
      const disposition = response.headers.get('content-disposition');
      const filename =
        disposition?.match(/filename="?([^";]+)"?/i)?.[1] ?? `buchhaltung-${format}.csv`;

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);

      toast.success('Buchhaltungsexport heruntergeladen.');
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Der Export konnte nicht erstellt werden.',
      );
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="space-y-8 py-4">
      {/* Zeitraum */}
      <div className="grid gap-4 sm:grid-cols-2 lg:max-w-md">
        <div className="space-y-2">
          <Label htmlFor="export-from">Von</Label>
          <Input
            id="export-from"
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="export-to">Bis</Label>
          <Input
            id="export-to"
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </div>
      </div>

      {/* Excel */}
      <div className="space-y-3">
        <h3 className="flex items-center gap-2 font-display text-sm font-semibold">
          <Table2 className="size-4 text-primary" aria-hidden />
          Excel-Exporte
        </h3>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => downloadExcel('rechnungen')}
            loading={pending === 'rechnungen'}
          >
            <Download aria-hidden />
            Rechnungen
          </Button>
          <Button
            variant="outline"
            onClick={() => downloadExcel('kunden')}
            loading={pending === 'kunden'}
          >
            <Download aria-hidden />
            Kundenliste
          </Button>
          <Button
            variant="outline"
            onClick={() => downloadExcel('zeiterfassung')}
            loading={pending === 'zeiterfassung'}
          >
            <Download aria-hidden />
            Zeiterfassung
          </Button>
        </div>
      </div>

      {/* Buchhaltung */}
      <div className="space-y-4 border-t border-border pt-6">
        <h3 className="flex items-center gap-2 font-display text-sm font-semibold">
          <FileSpreadsheet className="size-4 text-primary" aria-hidden />
          Buchhaltungsexport
        </h3>
        <p className="prose-measure text-sm leading-relaxed text-muted-foreground">
          Erzeugt fertige Buchungssätze mit Konten aus dem Schweizer KMU-Kontenrahmen. Ihre
          Treuhandstelle kann die Datei direkt einlesen.
        </p>

        <div className="grid gap-4 sm:grid-cols-2 lg:max-w-md">
          <div className="space-y-2">
            <Label htmlFor="export-format">Format</Label>
            <Select value={format} onValueChange={setFormat}>
              <SelectTrigger id="export-format">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACCOUNTING_FORMATS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">Enthaltene Belege</legend>
          <div className="flex flex-wrap gap-4">
            {INCLUDE_OPTIONS.map((option) => (
              <label key={option.value} className="flex cursor-pointer items-center gap-2.5 text-sm">
                <Checkbox
                  checked={include.includes(option.value)}
                  onCheckedChange={(checked) =>
                    setInclude((current) =>
                      checked === true
                        ? [...current, option.value]
                        : current.filter((item) => item !== option.value),
                    )
                  }
                />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>

        <Button
          onClick={downloadAccounting}
          loading={pending === 'accounting'}
          disabled={include.length === 0}
        >
          <Download aria-hidden />
          Buchhaltungsdatei erstellen
        </Button>
      </div>
    </div>
  );
}
