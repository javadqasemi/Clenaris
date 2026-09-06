'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquarePlus } from 'lucide-react';

import { api, queryKeys } from '@/lib/api/client';
import { cn, formatRelative } from '@/lib/utils';
import { Skeleton } from '@/components/ui/primitives';
import { EmptyState } from '@/components/app/page-parts';
import { ThreadPanel } from './thread-panel';

/**
 * Zweispaltige Nachrichtenakte: links die Verläufe, rechts der gewählte.
 *
 * Auf schmalen Bildschirmen ersetzt der geöffnete Verlauf die Liste — zwei
 * 320-px-Spalten nebeneinander sind auf keinem Telefon lesbar.
 *
 * Es gibt bewusst kein Polling. Eine eingehende Nachricht erzeugt eine
 * Benachrichtigung, und die Glocke im Kopfbereich ist der Ort, an dem man
 * davon erfährt; ein Sekundentakt gegen die Datenbank spart hier niemandem
 * Zeit.
 */
export interface ThreadSummary {
  id: string;
  subject: string;
  closed: boolean;
  lastMessageAt: string;
  messageCount: number;
  customer: {
    id: string;
    firstName: string;
    lastName: string;
    companyName: string | null;
  } | null;
  preview: { body: string; createdAt: string; authorType: string; readAt: string | null } | null;
}

export function ThreadList({
  perspective,
  initialThreadId,
  status = 'all',
  emptyState,
  toolbar,
}: {
  perspective: 'CUSTOMER' | 'STAFF';
  initialThreadId?: string;
  status?: 'open' | 'closed' | 'all';
  emptyState: React.ReactNode;
  toolbar?: React.ReactNode;
}) {
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = React.useState<string | undefined>(initialThreadId);

  const threads = useQuery({
    queryKey: queryKeys.threads(status),
    queryFn: () => api.get<ThreadSummary[]>('/api/messages', { status }),
  });

  // Ohne ausdrückliche Wahl wird der neueste Verlauf geöffnet.
  React.useEffect(() => {
    if (!activeId && threads.data?.length) setActiveId(threads.data[0].id);
  }, [activeId, threads.data]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['messages'] });
  };

  if (threads.isLoading) {
    return (
      <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <Skeleton className="h-64 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  if (!threads.data?.length) {
    return (
      <div className="space-y-4">
        {emptyState}
        {toolbar ? <div className="flex justify-center">{toolbar}</div> : null}
      </div>
    );
  }

  /** Ungelesen ist, was die *andere* Seite zuletzt geschrieben und niemand geöffnet hat. */
  const isUnread = (thread: ThreadSummary) =>
    thread.preview !== null &&
    thread.preview.authorType !== perspective &&
    thread.preview.readAt === null;

  return (
    <div className="space-y-4">
      {toolbar ? <div className="flex justify-end">{toolbar}</div> : null}

      <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <nav
          aria-label="Nachrichtenverläufe"
          className={cn(
            'overflow-hidden rounded-2xl border border-border bg-card',
            activeId && 'hidden lg:block',
          )}
        >
          <ul className="divide-y divide-border">
            {threads.data.map((thread) => {
              const unread = isUnread(thread);
              const who =
                thread.customer?.companyName ??
                (thread.customer
                  ? `${thread.customer.firstName} ${thread.customer.lastName}`
                  : null);

              return (
                <li key={thread.id}>
                  <button
                    type="button"
                    onClick={() => setActiveId(thread.id)}
                    aria-current={thread.id === activeId ? 'true' : undefined}
                    className={cn(
                      'w-full space-y-1.5 px-4 py-3.5 text-left transition-colors hover:bg-muted/60',
                      thread.id === activeId && 'bg-primary/6',
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span
                        className={cn(
                          'line-clamp-1 text-sm',
                          unread ? 'font-semibold' : 'font-medium',
                        )}
                      >
                        {thread.subject}
                      </span>
                      {unread ? (
                        <span
                          className="mt-1.5 size-2 shrink-0 rounded-full bg-primary"
                          aria-label="Ungelesen"
                        />
                      ) : null}
                    </div>

                    {perspective === 'STAFF' && who ? (
                      <p className="truncate text-xs font-medium text-primary">{who}</p>
                    ) : null}

                    {thread.preview ? (
                      <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                        {thread.preview.body}
                      </p>
                    ) : null}

                    <p className="text-xs text-muted-foreground">
                      {formatRelative(thread.lastMessageAt)}
                      {thread.closed ? ' · abgeschlossen' : ''}
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        {activeId ? (
          <ThreadPanel
            id={activeId}
            perspective={perspective}
            onBack={() => setActiveId(undefined)}
            onSent={refresh}
          />
        ) : (
          <div className="hidden rounded-2xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground lg:block">
            Wählen Sie links einen Verlauf.
          </div>
        )}
      </div>
    </div>
  );
}

/** Standard-Leerzustand für das Kundenkonto. */
export function NoThreadsForCustomer() {
  return (
    <EmptyState
      icon={<MessageSquarePlus aria-hidden />}
      title="Noch keine Nachrichten"
      description="Fragen zu einem Termin, einer Rechnung oder dem Schlüssel? Schreiben Sie uns — wir antworten an Werktagen innerhalb von vier Stunden."
    />
  );
}
