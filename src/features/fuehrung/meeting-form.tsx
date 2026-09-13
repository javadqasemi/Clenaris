'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/form';
import { Alert } from '@/components/ui/primitives';
import { Checkbox, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/controls';

/**
 * Sitzung anlegen oder bearbeiten.
 *
 * Teilnehmende sind Häkchen in einer Liste, nicht ein Suchfeld: die Firma
 * hat ein Dutzend Konten, und wer die Sitzung protokolliert, kennt sie.
 * Pendenzen werden beim Speichern zu Aufgaben — deshalb stehen sie hier mit
 * Person und Frist, nicht als Freitext.
 */

interface ActionItemDraft {
  title: string;
  assigneeId: string;
  dueAt: string;
}

export function MeetingForm({
  mode,
  meetingId,
  staff,
  objectives,
  initial,
}: {
  mode: 'create' | 'edit';
  meetingId?: string;
  staff: { id: string; name: string }[];
  objectives: { id: string; title: string }[];
  initial?: {
    title: string;
    heldAt: string;
    location: string | null;
    agenda: string | null;
    minutes: string | null;
    decisions: string | null;
    guestNames: string[];
    participantIds: string[];
    objectiveId: string | null;
  };
}) {
  const router = useRouter();
  const [form, setForm] = React.useState({
    title: initial?.title ?? '',
    heldAt: initial?.heldAt ? toLocalInput(new Date(initial.heldAt)) : toLocalInput(new Date(Date.now() + 86_400_000)),
    location: initial?.location ?? '',
    agenda: initial?.agenda ?? '',
    minutes: initial?.minutes ?? '',
    decisions: initial?.decisions ?? '',
    guestNames: initial?.guestNames.join(', ') ?? '',
    objectiveId: initial?.objectiveId ?? '',
  });
  const [participants, setParticipants] = React.useState<Set<string>>(new Set(initial?.participantIds ?? []));
  const [items, setItems] = React.useState<ActionItemDraft[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const payload = {
        title: form.title.trim(),
        heldAt: new Date(form.heldAt).toISOString(),
        location: form.location || null,
        agenda: form.agenda || null,
        minutes: form.minutes || null,
        decisions: form.decisions || null,
        guestNames: form.guestNames.split(',').map((g) => g.trim()).filter(Boolean),
        participantIds: [...participants],
        objectiveId: form.objectiveId || null,
        actionItems: items
          .filter((i) => i.title.trim().length >= 3)
          .map((i) => ({ title: i.title.trim(), assigneeId: i.assigneeId || null, dueAt: i.dueAt ? new Date(i.dueAt).toISOString() : null, priority: 'NORMAL' })),
      };
      if (mode === 'create') {
        const created = await api.post<{ id: string }>('/api/bi/meetings', payload);
        toast.success('Sitzung angelegt.');
        router.push(`/admin/fuehrung/sitzungen/${created.id}`);
      } else {
        await api.patch(`/api/bi/meetings/${meetingId}`, payload);
        toast.success('Sitzung gespeichert.');
        setItems([]);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Speichern fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      {error ? <Alert variant="destructive">{error}</Alert> : null}
      <div className="grid gap-4 rounded-2xl border border-border bg-card p-6 sm:grid-cols-2">
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="m-title" required>Titel</Label>
          <Input id="m-title" value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="z. B. Geschäftsleitung Oktober" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="m-held" required>Datum und Zeit</Label>
          <Input id="m-held" type="datetime-local" value={form.heldAt} onChange={(e) => set('heldAt', e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="m-location">Ort</Label>
          <Input id="m-location" value={form.location} onChange={(e) => set('location', e.target.value)} placeholder="Büro Bern / Videocall" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="m-objective">Bezug zu einem Ziel</Label>
          <Select value={form.objectiveId || '__none__'} onValueChange={(v) => set('objectiveId', v === '__none__' ? '' : v)}>
            <SelectTrigger id="m-objective"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">Kein Bezug</SelectItem>
              {objectives.map((o) => <SelectItem key={o.id} value={o.id}>{o.title}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="m-guests">Gäste</Label>
          <Input id="m-guests" value={form.guestNames} onChange={(e) => set('guestNames', e.target.value)} placeholder="Externe, mit Komma trennen" />
        </div>
        <fieldset className="space-y-2 sm:col-span-2">
          <legend className="text-sm font-medium">Teilnehmende</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {staff.map((person) => (
              <label key={person.id} className="flex cursor-pointer items-center gap-2.5 text-sm">
                <Checkbox
                  checked={participants.has(person.id)}
                  onCheckedChange={(c) =>
                    setParticipants((p) => {
                      const next = new Set(p);
                      if (c === true) next.add(person.id);
                      else next.delete(person.id);
                      return next;
                    })
                  }
                />
                {person.name}
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <div className="grid gap-4 rounded-2xl border border-border bg-card p-6">
        <div className="space-y-2">
          <Label htmlFor="m-agenda">Traktanden</Label>
          <Textarea id="m-agenda" rows={4} value={form.agenda} onChange={(e) => set('agenda', e.target.value)} placeholder="1. Zahlen September&#10;2. Personalplanung Winter&#10;3. …" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="m-minutes">Protokoll</Label>
          <Textarea id="m-minutes" rows={8} value={form.minutes} onChange={(e) => set('minutes', e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="m-decisions">Beschlüsse</Label>
          <Textarea id="m-decisions" rows={4} value={form.decisions} onChange={(e) => set('decisions', e.target.value)} placeholder="Nummeriert, ein Beschluss je Zeile." />
        </div>
      </div>

      <div className="space-y-3 rounded-2xl border border-border bg-card p-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-base font-semibold">Pendenzen</h2>
            <p className="text-meta text-muted-foreground">Werden beim Speichern zu Aufgaben mit Frist und Erinnerung.</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setItems((i) => [...i, { title: '', assigneeId: '', dueAt: '' }])}>
            <Plus aria-hidden />
            Pendenz
          </Button>
        </div>
        {items.map((item, index) => (
          <div key={index} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_12rem_11rem_auto]">
            <Input placeholder="Was ist zu tun?" value={item.title} onChange={(e) => setItems((l) => l.map((x, i) => (i === index ? { ...x, title: e.target.value } : x)))} aria-label="Pendenz" />
            <Select value={item.assigneeId || '__none__'} onValueChange={(v) => setItems((l) => l.map((x, i) => (i === index ? { ...x, assigneeId: v === '__none__' ? '' : v } : x)))}>
              <SelectTrigger aria-label="Zuständig"><SelectValue placeholder="Zuständig" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Noch offen</SelectItem>
                {staff.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input type="date" value={item.dueAt} onChange={(e) => setItems((l) => l.map((x, i) => (i === index ? { ...x, dueAt: e.target.value } : x)))} aria-label="Frist" />
            <Button type="button" variant="ghost" size="icon" aria-label="Entfernen" onClick={() => setItems((l) => l.filter((_, i) => i !== index))}>
              <Trash2 aria-hidden />
            </Button>
          </div>
        ))}
      </div>

      <div className="flex justify-end gap-2">
        <Button type="submit" loading={busy}>{mode === 'create' ? 'Sitzung anlegen' : 'Speichern'}</Button>
      </div>
    </form>
  );
}

function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
