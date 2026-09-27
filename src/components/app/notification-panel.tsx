'use client';

import * as React from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BellOff, CheckCheck } from 'lucide-react';

import { cn, formatRelative } from '@/lib/utils';
import { api, queryKeys } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { ScrollArea, Skeleton } from '@/components/ui/primitives';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/overlays';

/**
 * Benachrichtigungen.
 *
 * Sie werden erst geladen, wenn das Panel geöffnet wird — der Zähler in der
 * Kopfzeile ist eine eigene, sehr günstige Abfrage. So kostet ein
 * Seitenaufruf nicht die vollständige Liste.
 */

interface NotificationDto {
  id: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export function NotificationPanel({
  children,
  unreadCount,
}: {
  children: React.ReactNode;
  unreadCount: number;
}) {
  const [open, setOpen] = React.useState(false);
  const queryClient = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: [...queryKeys.notifications(), 'list'],
    queryFn: () => api.get<NotificationDto[]>('/api/notifications'),
    enabled: open,
  });

  /*
    Fehler werden gemeldet (2026-09-27). Vorher hatten beide Aufrufe kein
    `onError`: Scheiterte „alle gelesen", blieb der Zähler stehen, und nichts
    sagte warum — ein Klick, der nichts tut, sieht aus wie ein Fehler der
    Maus.
  */
  const markAllRead = useMutation({
    mutationFn: () => api.post('/api/notifications/read-all'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications() });
    },
    onError: () => toast.error('Die Benachrichtigungen liessen sich nicht als gelesen markieren. Bitte erneut versuchen.'),
  });

  const markRead = useMutation({
    mutationFn: (id: string) => api.post(`/api/notifications/${id}/read`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications() });
    },
    onError: () => toast.error('Die Benachrichtigung liess sich nicht als gelesen markieren.'),
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-2rem))] p-0">
        <div className="flex items-center justify-between gap-3 border-b border-border p-4">
          <h2 className="font-display text-sm font-semibold">
            Benachrichtigungen
            {unreadCount > 0 ? (
              <span className="ml-2 text-muted-foreground">({unreadCount} neu)</span>
            ) : null}
          </h2>
          {unreadCount > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => markAllRead.mutate()}
              loading={markAllRead.isPending}
            >
              <CheckCheck aria-hidden />
              Alle gelesen
            </Button>
          ) : null}
        </div>

        <ScrollArea className="max-h-96">
          {isLoading ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 3 }).map((_, index) => (
                <Skeleton key={index} className="h-14" />
              ))}
            </div>
          ) : isError ? (
            // Ein Ladefehler ist kein leeres Postfach — sonst hiesse „keine
            // Benachrichtigungen", dass es keine gibt, obwohl sie nur fehlen.
            <div className="flex flex-col items-center gap-3 p-10 text-center" role="alert">
              <p className="text-sm text-muted-foreground">Die Benachrichtigungen liessen sich nicht laden.</p>
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                Erneut laden
              </Button>
            </div>
          ) : !data || data.length === 0 ? (
            <div className="flex flex-col items-center gap-3 p-10 text-center">
              <BellOff className="size-8 text-muted-foreground/50" aria-hidden />
              <p className="text-sm text-muted-foreground">
                Keine Benachrichtigungen. Hier erscheinen neue Buchungen, Termine und Zahlungen.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {data.map((notification) => {
                const unread = !notification.readAt;
                const content = (
                  <div className="flex gap-3">
                    <span
                      className={cn(
                        'mt-1.5 size-2 shrink-0 rounded-full',
                        unread ? 'bg-primary' : 'bg-transparent',
                      )}
                      aria-hidden
                    />
                    <div className="min-w-0 space-y-0.5">
                      <p className={cn('text-sm leading-snug', unread && 'font-medium')}>
                        {notification.title}
                      </p>
                      <p className="text-meta leading-relaxed text-muted-foreground">
                        {notification.body}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatRelative(notification.createdAt)}
                      </p>
                    </div>
                  </div>
                );

                return (
                  <li key={notification.id}>
                    {notification.link ? (
                      <Link
                        href={notification.link}
                        onClick={() => {
                          if (unread) markRead.mutate(notification.id);
                          setOpen(false);
                        }}
                        className="block p-4 transition-colors hover:bg-muted"
                      >
                        {content}
                      </Link>
                    ) : (
                      <button
                        type="button"
                        onClick={() => unread && markRead.mutate(notification.id)}
                        className="block w-full p-4 text-left transition-colors hover:bg-muted"
                      >
                        {content}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
