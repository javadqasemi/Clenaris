'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
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
 * Aufgabe abhaken.
 *
 * Optimistisch: das Häkchen sitzt sofort, der Server bestätigt danach. Bei
 * einem Fehler springt es zurück. Aufgaben werden in Serie abgearbeitet — jede
 * Wartezeit summiert sich.
 */
export function TaskToggle({ taskId, done }: { taskId: string; done: boolean }) {
  const router = useRouter();
  const [checked, setChecked] = React.useState(done);

  const toggle = async (next: boolean) => {
    setChecked(next);
    try {
      await api.patch(`/api/tasks/${taskId}`, { status: next ? 'DONE' : 'OPEN' });
      if (next) toast.success('Aufgabe erledigt.');
      router.refresh();
    } catch (error) {
      setChecked(!next);
      toast.error(
        error instanceof ApiError ? error.message : 'Die Aufgabe konnte nicht geändert werden.',
      );
    }
  };

  return (
    <Checkbox
      checked={checked}
      onCheckedChange={(value) => toggle(value === true)}
      aria-label="Aufgabe als erledigt markieren"
      className="mt-0.5"
    />
  );
}

const PRIORITIES = [
  { value: 'LOW', label: 'Tief' },
  { value: 'NORMAL', label: 'Normal' },
  { value: 'HIGH', label: 'Hoch' },
  { value: 'URGENT', label: 'Dringend' },
];

/** Neue Aufgabe erfassen — direkt über der Liste, ohne Dialog. */
export function TaskComposer({ staff }: { staff: { id: string; name: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [priority, setPriority] = React.useState('NORMAL');
  const [assigneeId, setAssigneeId] = React.useState<string>('none');
  const [dueAt, setDueAt] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (title.trim().length < 3) return;

    setSaving(true);
    try {
      await api.post('/api/tasks', {
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        assigneeId: assigneeId === 'none' ? undefined : assigneeId,
        dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
      });

      toast.success('Aufgabe erstellt.');
      setTitle('');
      setDescription('');
      setDueAt('');
      setOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'Die Aufgabe konnte nicht erstellt werden.',
      );
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Plus aria-hidden />
        Aufgabe erfassen
      </Button>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-2xl border border-border bg-card p-5 shadow-soft"
    >
      <div className="space-y-2">
        <Label htmlFor="task-title" required>
          Was ist zu tun?
        </Label>
        <Input
          id="task-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="z. B. Frau Wyss wegen Terminverschiebung anrufen"
          autoFocus
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="task-description">Details</Label>
        <Textarea
          id="task-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={2}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="task-assignee">Zuständig</Label>
          <Select value={assigneeId} onValueChange={setAssigneeId}>
            <SelectTrigger id="task-assignee">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Niemand</SelectItem>
              {staff.map((person) => (
                <SelectItem key={person.id} value={person.id}>
                  {person.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="task-priority">Priorität</Label>
          <Select value={priority} onValueChange={setPriority}>
            <SelectTrigger id="task-priority">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRIORITIES.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="task-due">Fällig am</Label>
          <Input
            id="task-due"
            type="date"
            value={dueAt}
            onChange={(event) => setDueAt(event.target.value)}
          />
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Abbrechen
        </Button>
        <Button type="submit" loading={saving} disabled={title.trim().length < 3}>
          Aufgabe erstellen
        </Button>
      </div>
    </form>
  );
}
