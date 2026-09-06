'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, MessageSquarePlus } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/form';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/overlays';
import { NoThreadsForCustomer, ThreadList } from '@/features/messaging/thread-list';

/**
 * Nachrichten im Kundenkonto.
 *
 * Liste und Verlauf teilen sich die Bausteine mit der Büroansicht; hier kommt
 * nur das Eröffnen eines neuen Verlaufs dazu. Das Büro eröffnet keine Threads
 * aus dem Nichts — es antwortet auf bestehende oder greift zum Telefon.
 */
export function AccountMessages({ initialThreadId }: { initialThreadId?: string }) {
  const [composeOpen, setComposeOpen] = React.useState(false);
  const [createdId, setCreatedId] = React.useState<string | undefined>(initialThreadId);

  return (
    <>
      <ThreadList
        perspective="CUSTOMER"
        initialThreadId={createdId}
        emptyState={<NoThreadsForCustomer />}
        toolbar={
          <Button onClick={() => setComposeOpen(true)}>
            <MessageSquarePlus aria-hidden />
            Neue Nachricht
          </Button>
        }
      />

      <ComposeDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
        onCreated={setCreatedId}
      />
    </>
  );
}

function ComposeDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [subject, setSubject] = React.useState('');
  const [body, setBody] = React.useState('');

  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>('/api/messages', { subject, body }),
    onSuccess: (result) => {
      toast.success('Nachricht gesendet. Wir melden uns.');
      setSubject('');
      setBody('');
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: ['messages'] });
      onCreated(result.id);
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : 'Senden fehlgeschlagen.');
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Neue Nachricht</DialogTitle>
          <DialogDescription>
            An Werktagen antworten wir innerhalb von vier Stunden. Bei dringenden Anliegen rufen
            Sie uns besser an.
          </DialogDescription>
        </DialogHeader>

        <form
          id="compose-form"
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="subject">Betreff</Label>
            <Input
              id="subject"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder="z. B. Schlüsselübergabe am Freitag"
              maxLength={160}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="body">Nachricht</Label>
            <Textarea
              id="body"
              rows={6}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              maxLength={5000}
              required
            />
          </div>
        </form>

        <DialogFooter>
          <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button
            type="submit"
            form="compose-form"
            disabled={create.isPending || subject.trim().length < 3 || body.trim().length < 5}
          >
            {create.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            Senden
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
