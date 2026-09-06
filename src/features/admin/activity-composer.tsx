'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Mail, MessageSquare, Phone, Send, StickyNote, Users } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/form';

/**
 * Verlaufseintrag erfassen.
 *
 * Bewusst direkt über der Zeitachse statt in einem Dialog: was in zwei Klicks
 * erledigt ist, wird auch tatsächlich erfasst. Der Typ bestimmt den
 * vorgeschlagenen Betreff, damit die Zeitachse konsistent lesbar bleibt.
 */
const TYPES = [
  { value: 'NOTE', label: 'Notiz', Icon: StickyNote, subject: 'Notiz' },
  { value: 'CALL', label: 'Telefonat', Icon: Phone, subject: 'Telefonat' },
  { value: 'EMAIL', label: 'E-Mail', Icon: Mail, subject: 'E-Mail' },
  { value: 'MEETING', label: 'Termin', Icon: Users, subject: 'Besprechung' },
  { value: 'SMS', label: 'SMS', Icon: MessageSquare, subject: 'SMS' },
] as const;

export function ActivityComposer({
  customerId,
  leadId,
  jobId,
}: {
  customerId?: string;
  leadId?: string;
  jobId?: string;
}) {
  const router = useRouter();
  const [type, setType] = React.useState<(typeof TYPES)[number]['value']>('NOTE');
  const [subject, setSubject] = React.useState('');
  const [body, setBody] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  const active = TYPES.find((item) => item.value === type)!;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!body.trim()) return;

    setSaving(true);
    try {
      await api.post('/api/activities', {
        type,
        subject: subject.trim() || active.subject,
        body: body.trim(),
        customerId,
        leadId,
        jobId,
      });
      setSubject('');
      setBody('');
      toast.success('Eintrag gespeichert.');
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'Der Eintrag konnte nicht gespeichert werden.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-2xl border border-border bg-card p-5 shadow-soft"
    >
      <fieldset>
        <legend className="sr-only">Art des Eintrags</legend>
        <div className="flex flex-wrap gap-2">
          {TYPES.map(({ value, label, Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => setType(value)}
              aria-pressed={type === value}
              className={cn(
                'inline-flex items-center gap-2 rounded-xl border px-3 py-1.5 text-sm font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                type === value
                  ? 'border-primary bg-primary/[0.06] text-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="space-y-2">
        <Label htmlFor="activity-subject" className="sr-only">
          Betreff
        </Label>
        <Input
          id="activity-subject"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          placeholder={`Betreff (Standard: „${active.subject}")`}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="activity-body" className="sr-only">
          Inhalt
        </Label>
        <Textarea
          id="activity-body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={3}
          placeholder="Was wurde besprochen? Was ist der nächste Schritt?"
        />
      </div>

      <div className="flex justify-end">
        <Button type="submit" loading={saving} disabled={!body.trim()}>
          <Send aria-hidden />
          Eintrag speichern
        </Button>
      </div>
    </form>
  );
}
