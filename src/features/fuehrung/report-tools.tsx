'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { FileDown } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { optionsOf, REPORT_CADENCE_LABELS, REPORT_FORMAT_LABELS, REPORT_KIND_LABELS } from '@/lib/bi/labels';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/controls';
import { DetailSection } from '@/components/app/page-parts';
import { FormDialog } from './resource-form';

/** Bericht sofort erzeugen. */
export function GenerateReportForm() {
  const router = useRouter();
  const now = new Date();
  const [kind, setKind] = React.useState('BUSINESS_PERFORMANCE');
  const [format, setFormat] = React.useState('PDF');
  const [from, setFrom] = React.useState(new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10));
  const [to, setTo] = React.useState(new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10));
  const [busy, setBusy] = React.useState(false);

  const generate = async () => {
    setBusy(true);
    try {
      await api.post('/api/bi/reports/generate', { kind, format, periodStart: from, periodEnd: to });
      toast.success('Bericht erzeugt.');
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Der Bericht konnte nicht erzeugt werden.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <DetailSection title="Bericht erzeugen" description="Aus den festgeschriebenen Kennzahlen des Zeitraums; die Datei bleibt liegen." body="form">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="rep-kind">Art</Label>
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger id="rep-kind"><SelectValue /></SelectTrigger>
            <SelectContent>{optionsOf(REPORT_KIND_LABELS).map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="rep-format">Format</Label>
          <Select value={format} onValueChange={setFormat}>
            <SelectTrigger id="rep-format"><SelectValue /></SelectTrigger>
            <SelectContent>{optionsOf(REPORT_FORMAT_LABELS).map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="rep-from">Von</Label>
          <Input id="rep-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="rep-to">Bis</Label>
          <Input id="rep-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>
      <div className="flex justify-end">
        <Button onClick={generate} loading={busy}>
          <FileDown aria-hidden />
          Erzeugen
        </Button>
      </div>
    </DetailSection>
  );
}

/** Zeitplan anlegen — als Dialog aus der Berichtsseite. */
export function ScheduleDialog() {
  return (
    <FormDialog
      title="Berichtszeitplan"
      description="Der Nachtlauf erzeugt den Bericht am genannten Tag und verschickt ihn an die Empfänger."
      triggerLabel="Zeitplan"
      triggerVariant="outline"
      endpoint="/api/bi/report-schedules"
      successMessage="Zeitplan angelegt."
      fields={[
        { name: 'name', label: 'Bezeichnung', required: true, placeholder: 'z. B. Monatsbericht Geschäftsleitung' },
        { name: 'kind', label: 'Art', type: 'select', options: optionsOf(REPORT_KIND_LABELS), required: true, half: true },
        { name: 'format', label: 'Format', type: 'select', options: optionsOf(REPORT_FORMAT_LABELS), required: true, half: true },
        { name: 'cadence', label: 'Takt', type: 'select', options: optionsOf(REPORT_CADENCE_LABELS), required: true, half: true },
        { name: 'runOnDay', label: 'Tag', type: 'number', required: true, half: true, hint: 'Wöchentlich: 1 = Montag … 7 = Sonntag. Sonst Tag im Monat (1–28).' },
        { name: 'recipients', label: 'Empfänger', type: 'tags', placeholder: 'E-Mail-Adressen, mit Komma trennen' },
        { name: 'active', label: 'Aktiv', type: 'checkbox' },
      ]}
      values={{ kind: 'BUSINESS_PERFORMANCE', format: 'PDF', cadence: 'MONTHLY', runOnDay: 1, active: true }}
    />
  );
}
