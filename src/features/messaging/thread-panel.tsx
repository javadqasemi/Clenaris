'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, Send } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError, queryKeys } from '@/lib/api/client';
import { cn, formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/form';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/primitives';

/**
 * Ein Nachrichtenverlauf.
 *
 * Geteilt zwischen Kundenkonto und Büro — dieselbe Akte, gespiegelte
 * Perspektive: die eigene Seite steht rechts, die Gegenseite links. Wer
 * beide Ansichten getrennt implementiert, bekommt früher oder später zwei
 * verschiedene Wahrheiten über denselben Verlauf.
 */
export interface ThreadDetail {
  id: string;
  subject: string;
  closed: boolean;
  customer: {
    id: string;
    firstName: string;
    lastName: string;
    companyName: string | null;
  } | null;
  messages: {
    id: string;
    body: string;
    authorType: string;
    createdAt: string;
    author: { id: string; firstName: string; lastName: string } | null;
    attachments: { id: string; filename: string; url: string }[];
  }[];
}

export function ThreadPanel({
  id,
  /** Aus wessen Sicht wird gelesen — bestimmt, welche Seite „ich" ist. */
  perspective,
  onBack,
  onSent,
}: {
  id: string;
  perspective: 'CUSTOMER' | 'STAFF';
  onBack?: () => void;
  onSent?: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = React.useState('');
  const endRef = React.useRef<HTMLDivElement>(null);

  const thread = useQuery({
    queryKey: queryKeys.thread(id),
    queryFn: () => api.get<ThreadDetail>(`/api/messages/${id}`),
  });

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [thread.data?.messages.length]);

  const reply = useMutation({
    mutationFn: (payload: { body: string; close?: boolean }) =>
      api.post(`/api/messages/${id}`, payload),
    onSuccess: () => {
      setDraft('');
      void queryClient.invalidateQueries({ queryKey: queryKeys.thread(id) });
      onSent?.();
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : 'Senden fehlgeschlagen.');
    },
  });

  if (thread.isLoading || !thread.data) {
    return <Skeleton className="h-96 rounded-2xl" />;
  }

  const data = thread.data;
  const customerName =
    data.customer?.companyName ??
    (data.customer ? `${data.customer.firstName} ${data.customer.lastName}` : null);

  return (
    <section className="flex min-h-[24rem] flex-col overflow-hidden rounded-2xl border border-border bg-card">
      <header className="flex items-center gap-3 border-b border-border px-5 py-4">
        {onBack ? (
          <Button variant="ghost" size="sm" className="lg:hidden" onClick={onBack}>
            Zurück
          </Button>
        ) : null}
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display text-base font-semibold tracking-tight">
            {data.subject}
          </h2>
          {perspective === 'STAFF' && customerName ? (
            <p className="truncate text-sm text-muted-foreground">{customerName}</p>
          ) : null}
        </div>
        {data.closed ? (
          <Badge variant="neutral" size="sm">
            Abgeschlossen
          </Badge>
        ) : null}
      </header>

      <ol className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
        {data.messages.map((message) => {
          const mine = message.authorType === perspective;
          return (
            <li
              key={message.id}
              className={cn('flex flex-col gap-1', mine ? 'items-end' : 'items-start')}
            >
              <div
                className={cn(
                  'max-w-[42ch] rounded-2xl px-4 py-3 text-sm leading-relaxed',
                  mine
                    ? 'rounded-tr-sm bg-primary text-primary-foreground'
                    : 'rounded-tl-sm bg-muted text-foreground',
                )}
              >
                <p className="whitespace-pre-wrap">{message.body}</p>
                {message.attachments.length > 0 ? (
                  <ul className="mt-2 space-y-1 border-t border-current/15 pt-2">
                    {message.attachments.map((file) => (
                      <li key={file.id}>
                        <a href={file.url} className="text-xs underline underline-offset-2">
                          {file.filename}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                {message.author ? `${message.author.firstName} · ` : ''}
                {formatDateTime(message.createdAt)}
              </p>
            </li>
          );
        })}
        <div ref={endRef} />
      </ol>

      {data.closed ? (
        <p className="border-t border-border px-5 py-4 text-sm text-muted-foreground">
          {perspective === 'CUSTOMER'
            ? 'Dieser Verlauf ist abgeschlossen. Für eine neue Frage eröffnen Sie bitte einen neuen.'
            : 'Abgeschlossen. Eine Antwort ist nicht mehr möglich.'}
        </p>
      ) : (
        <form
          className="space-y-3 border-t border-border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            const value = draft.trim();
            if (value) reply.mutate({ body: value });
          }}
        >
          <div>
            <Label htmlFor={`reply-${id}`} className="sr-only">
              Antwort
            </Label>
            <Textarea
              id={`reply-${id}`}
              rows={3}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={
                perspective === 'STAFF' ? 'Antwort an die Kundschaft …' : 'Ihre Nachricht …'
              }
              maxLength={5000}
            />
          </div>

          <div className="flex flex-wrap justify-end gap-2">
            {perspective === 'STAFF' ? (
              <Button
                type="button"
                variant="outline"
                disabled={!draft.trim() || reply.isPending}
                onClick={() => reply.mutate({ body: draft.trim(), close: true })}
              >
                <Check aria-hidden />
                Senden und abschliessen
              </Button>
            ) : null}
            <Button type="submit" disabled={!draft.trim() || reply.isPending}>
              {reply.isPending ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <Send aria-hidden />
              )}
              Senden
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
