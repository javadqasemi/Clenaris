'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
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
  DialogTrigger,
} from '@/components/ui/overlays';

/**
 * Abwesenheit beantragen.
 *
 * Die Vorschau zeigt die gezählten Arbeitstage vor dem Absenden — Wochenenden
 * und Feiertage zählt der Server ohnehin heraus, aber die Zahl vorher zu sehen
 * verhindert Missverständnisse beim Feriensaldo.
 */
const TYPES = [
  { value: 'VACATION', label: 'Ferien' },
  { value: 'SICK', label: 'Krankheit' },
  { value: 'ACCIDENT', label: 'Unfall' },
  { value: 'MILITARY', label: 'Militär / Zivildienst' },
  { value: 'MATERNITY', label: 'Mutterschaft' },
  { value: 'PATERNITY', label: 'Vaterschaft' },
  { value: 'TRAINING', label: 'Weiterbildung' },
  { value: 'UNPAID', label: 'Unbezahlter Urlaub' },
  { value: 'OTHER', label: 'Anderes' },
];

export function AbsenceRequestDialog({ remainingDays }: { remainingDays: number }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [type, setType] = React.useState('VACATION');
  const [startDate, setStartDate] = React.useState('');
  const [endDate, setEndDate] = React.useState('');
  const [halfDay, setHalfDay] = React.useState(false);
  const [reason, setReason] = React.useState('');

  // Werktage grob zählen — der Server rechnet inklusive Feiertagen exakt nach.
  const estimatedDays = React.useMemo(() => {
    if (halfDay) return 0.5;
    if (!startDate || !endDate) return 0;

    const start = new Date(startDate);
    const end = new Date(endDate);
    if (end < start) return 0;

    let count = 0;
    const cursor = new Date(start);
    while (cursor <= end) {
      const day = cursor.getDay();
      if (day !== 0 && day !== 6) count++;
      cursor.setDate(cursor.getDate() + 1);
    }
    return count;
  }, [startDate, endDate, halfDay]);

  const exceedsBalance = type === 'VACATION' && estimatedDays > remainingDays;

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.post('/api/absences', {
        type,
        startDate,
        endDate: halfDay ? startDate : endDate,
        halfDay,
        reason: reason || undefined,
      });

      toast.success('Antrag eingereicht. Die Betriebsleitung entscheidet in den nächsten Tagen.');
      setOpen(false);
      setStartDate('');
      setEndDate('');
      setReason('');
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Der Antrag konnte nicht eingereicht werden.';
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus aria-hidden />
          Abwesenheit beantragen
        </Button>
      </DialogTrigger>

      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Abwesenheit beantragen</DialogTitle>
          <DialogDescription>
            Wochenenden und Feiertage zählen nicht als Abwesenheitstage. Du hast noch{' '}
            {remainingDays} Ferientage zugut.
          </DialogDescription>
        </DialogHeader>

        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="absence-type" required>
              Art
            </Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger id="absence-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPES.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <label className="flex cursor-pointer items-center gap-2.5 text-sm">
            <Checkbox checked={halfDay} onCheckedChange={(checked) => setHalfDay(checked === true)} />
            Nur ein halber Tag
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="absence-start" required>
                Von
              </Label>
              <Input
                id="absence-start"
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
              />
            </div>

            {!halfDay ? (
              <div className="space-y-2">
                <Label htmlFor="absence-end" required>
                  Bis
                </Label>
                <Input
                  id="absence-end"
                  type="date"
                  value={endDate}
                  min={startDate}
                  onChange={(event) => setEndDate(event.target.value)}
                />
              </div>
            ) : null}
          </div>

          {estimatedDays > 0 ? (
            <Alert variant={exceedsBalance ? 'warning' : 'info'}>
              {exceedsBalance
                ? `Der Antrag umfasst ${estimatedDays} Arbeitstage, dein Guthaben beträgt ${remainingDays} Tage. Die Betriebsleitung muss das gesondert prüfen.`
                : `Der Antrag umfasst ${estimatedDays} ${estimatedDays === 1 ? 'Arbeitstag' : 'Arbeitstage'}.`}
            </Alert>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="absence-reason">Bemerkung</Label>
            <Textarea
              id="absence-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={2}
              placeholder="Optional — bei Krankheit bitte ab dem dritten Tag ein Arztzeugnis nachreichen."
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Abbrechen
          </Button>
          <Button
            onClick={submit}
            loading={saving}
            disabled={!startDate || (!halfDay && !endDate)}
          >
            Antrag einreichen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
