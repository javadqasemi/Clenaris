'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Download, PenLine, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/form';
import { Alert } from '@/components/ui/primitives';
import { Checkbox } from '@/components/ui/controls';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/overlays';
import { ActionButton } from '@/components/app/action-button';
import { FormDialog, type FieldSpec } from '@/components/app/resource-form';

/**
 * Einsatzgebiet pflegen.
 *
 * Die Endpunkte (anlegen, ändern, entfernen, Massenimport) bestanden; die
 * Seite zeigte die Postleitzahlen aber nur an. Eine Anfahrtspauschale zu
 * ändern hiess, den Endpunkt von Hand anzusprechen.
 *
 * Der Import nimmt eine Liste im Klartext, wie sie aus einer Tabelle kopiert
 * kommt: eine Zeile je Postleitzahl, Felder mit Strichpunkt, Tabulator oder
 * Komma getrennt. Das ist absichtlich kein Datei-Upload — vierzig
 * Postleitzahlen aus einem Tabellenblatt kopiert man, man exportiert sie
 * nicht erst.
 */
export interface ServiceAreaRow {
  id: string;
  postalCode: string;
  city: string;
  canton: string;
  travelFee: number;
  travelMinutes: number;
  active: boolean;
}

const FIELDS: FieldSpec[] = [
  { name: 'postalCode', label: 'Postleitzahl', required: true, half: true, placeholder: '3011' },
  { name: 'city', label: 'Ort', required: true, half: true, placeholder: 'Bern' },
  { name: 'canton', label: 'Kanton', half: true, placeholder: 'BE' },
  { name: 'travelFee', label: 'Anfahrtspauschale', type: 'number', suffix: 'CHF', half: true, min: 0, step: 0.05 },
  { name: 'travelMinutes', label: 'Fahrzeit', type: 'number', suffix: 'Min.', half: true, min: 0, max: 240 },
  { name: 'active', label: 'Im Buchungsassistenten anbieten', type: 'checkbox' },
];

export function ServiceAreaCreateButton() {
  return (
    <FormDialog
      title="Postleitzahl aufnehmen"
      description="Die Anfahrtspauschale fliesst in jeden künftigen Preis dieser Postleitzahl ein."
      triggerLabel="Postleitzahl aufnehmen"
      size="md"
      endpoint="/api/service-areas"
      fields={FIELDS}
      values={{ canton: 'BE', travelFee: 0, travelMinutes: 0, active: true }}
      successMessage="Postleitzahl aufgenommen."
    />
  );
}

export function ServiceAreaRowActions({ area }: { area: ServiceAreaRow }) {
  return (
    <div className="flex items-center justify-end gap-1">
      <ActionButton
        endpoint={`/api/service-areas/${area.id}`}
        method="PATCH"
        body={{ active: !area.active }}
        label={area.active ? 'Deaktivieren' : 'Aktivieren'}
        variant="ghost"
        size="sm"
        successMessage={area.active ? 'Postleitzahl deaktiviert.' : 'Postleitzahl aktiviert.'}
      />
      <FormDialog
        title={`${area.postalCode} ${area.city} bearbeiten`}
        triggerLabel="Bearbeiten"
        triggerVariant="ghost"
        triggerSize="icon"
        triggerIcon={<PenLine aria-hidden />}
        size="md"
        endpoint={`/api/service-areas/${area.id}`}
        method="PATCH"
        fields={FIELDS}
        values={{
          postalCode: area.postalCode,
          city: area.city,
          canton: area.canton,
          travelFee: area.travelFee,
          travelMinutes: area.travelMinutes,
          active: area.active,
        }}
        successMessage="Postleitzahl geändert."
      />
      <ActionButton
        endpoint={`/api/service-areas/${area.id}`}
        method="DELETE"
        label="Entfernen"
        aria-label={`${area.postalCode} ${area.city} entfernen`}
        variant="ghost"
        size="icon"
        confirmTitle="Postleitzahl entfernen?"
        confirm={`${area.postalCode} ${area.city} wird aus dem Einsatzgebiet genommen. Liegen dort noch Termine, verweigert der Server das Entfernen — dann bleibt Deaktivieren.`}
        successMessage="Postleitzahl entfernt."
      >
        <Trash2 aria-hidden />
      </ActionButton>
    </div>
  );
}

/** Eine Zeile der Importliste lesen; `null`, wenn sie nichts Brauchbares enthält. */
function parseLine(line: string) {
  const parts = line
    .split(/[;\t,]/)
    .map((part) => part.trim())
    .filter((part, index) => part !== '' || index < 2);
  if (parts.length < 2) return null;
  const [postalCode, city, canton, fee, minutes] = parts;
  if (!/^\d{4}$/.test(postalCode ?? '')) return null;
  return {
    postalCode,
    city,
    canton: (canton && /^[A-Za-z]{2}$/.test(canton) ? canton.toUpperCase() : 'BE'),
    travelFee: fee ? Number(fee.replace(',', '.')) || 0 : 0,
    travelMinutes: minutes ? Number(minutes) || 0 : 0,
    active: true,
  };
}

export function ServiceAreaImportDialog() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState('');
  const [overwrite, setOverwrite] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const parsed = React.useMemo(
    () => text.split(/\r?\n/).map(parseLine).filter((row): row is NonNullable<typeof row> => row !== null),
    [text],
  );

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const result = await api.post<{ created: number; updated: number; skipped: number }>(
        '/api/service-areas/bulk',
        { areas: parsed, overwrite },
      );
      toast.success(
        `${result.created ?? 0} aufgenommen, ${result.updated ?? 0} aktualisiert, ${result.skipped ?? 0} übersprungen.`,
      );
      setOpen(false);
      setText('');
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Der Import ist fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Upload aria-hidden />
          Liste importieren
        </Button>
      </DialogTrigger>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Postleitzahlen importieren</DialogTitle>
          <DialogDescription>
            Eine Zeile je Postleitzahl: <code>PLZ; Ort; Kanton; Pauschale; Minuten</code>. Kanton,
            Pauschale und Minuten sind freiwillig.
          </DialogDescription>
        </DialogHeader>

        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <div className="space-y-2">
          <Label htmlFor="area-import">Liste</Label>
          <Textarea
            id="area-import"
            rows={8}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={'3011; Bern; BE; 0; 10\n3400; Burgdorf; BE; 25; 35'}
          />
          <p className="text-meta text-muted-foreground">
            {parsed.length} {parsed.length === 1 ? 'Zeile erkannt' : 'Zeilen erkannt'}.
          </p>
        </div>

        <label className="flex cursor-pointer items-center gap-2.5 text-sm">
          <Checkbox checked={overwrite} onCheckedChange={(c) => setOverwrite(c === true)} />
          Bestehende Postleitzahlen überschreiben
        </label>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Abbrechen
          </Button>
          <Button loading={busy} disabled={parsed.length === 0} onClick={submit}>
            {parsed.length} importieren
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Export als CSV — im Browser erzeugt, aus den Zeilen, die die Seite ohnehin
 * schon geladen hat. Ein Endpunkt dafür wäre eine zweite Abfrage für dieselben
 * Daten.
 */
export function ServiceAreaExportButton({ areas }: { areas: ServiceAreaRow[] }) {
  const download = () => {
    const lines = [
      'PLZ;Ort;Kanton;Anfahrtspauschale;Fahrzeit;Aktiv',
      ...areas.map((area) =>
        [
          area.postalCode,
          area.city,
          area.canton,
          area.travelFee.toFixed(2),
          String(area.travelMinutes),
          area.active ? 'ja' : 'nein',
        ].join(';'),
      ),
    ];
    const blob = new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `einsatzgebiet-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Button variant="outline" onClick={download} disabled={areas.length === 0}>
      <Download aria-hidden />
      CSV exportieren
    </Button>
  );
}
