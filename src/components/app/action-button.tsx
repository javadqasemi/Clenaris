'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { Button, type ButtonProps } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/overlays';
import { Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/form';

/**
 * Eine Schaltfläche, die einen Endpunkt anstösst — genehmigen, neu rechnen,
 * prüfen, löschen, wiederherstellen.
 *
 * **Warum ein gemeinsamer Baustein.** Die Anwendung hat Dutzende solcher
 * Handlungen, und jede braucht dasselbe: Ladezustand, Erfolgsmeldung,
 * Fehlermeldung aus der Antwort, Neuladen der Seite. Wo das je Handlung
 * ausgeschrieben stand, fehlte an der einen Stelle die Bestätigung, an der
 * anderen der Ladezustand — und ein Löschen ohne Rückfrage ist genau der
 * Fehler, der sich erst beim falschen Datensatz bemerkbar macht.
 *
 * Unumkehrbares fragt nach (`confirm`); alles andere läuft sofort. Eine
 * Prüfung kann eine Notiz mitgeben (`withNote`), damit die Bestätigung nicht
 * nur ein Zeitstempel ist.
 *
 * Ursprünglich im Bereich Unternehmensführung entstanden; die dortige Datei
 * exportiert diesen Baustein weiter, damit bestehende Importe stehen bleiben.
 */
export function ActionButton({
  endpoint,
  method = 'POST',
  body,
  label,
  confirm,
  confirmTitle,
  withNote,
  noteLabel = 'Notiz',
  noteField = 'note',
  successMessage = 'Erledigt.',
  redirectTo,
  variant = 'outline',
  size = 'sm',
  children,
  disabled,
  className,
  'aria-label': ariaLabel,
}: {
  endpoint: string;
  method?: 'POST' | 'PATCH' | 'DELETE';
  body?: Record<string, unknown>;
  label: string;
  confirm?: string;
  confirmTitle?: string;
  withNote?: boolean;
  noteLabel?: string;
  noteField?: string;
  successMessage?: string;
  redirectTo?: string;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  children?: React.ReactNode;
  disabled?: boolean;
  className?: string;
  /** Für reine Symbolschaltflächen (`size="icon"`): der Name für Screenreader. */
  'aria-label'?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const payload = {
        ...(body ?? {}),
        ...(withNote && note.trim() ? { [noteField]: note.trim() } : {}),
      };
      if (method === 'DELETE') await api.delete(endpoint);
      else if (method === 'PATCH') await api.patch(endpoint, payload);
      else await api.post(endpoint, Object.keys(payload).length ? payload : undefined);
      toast.success(successMessage);
      setOpen(false);
      if (redirectTo) router.push(redirectTo);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Die Aktion ist fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  };

  const needsDialog = Boolean(confirm || withNote);

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        disabled={disabled}
        loading={!needsDialog && busy}
        onClick={() => (needsDialog ? setOpen(true) : run())}
        className={className}
        aria-label={ariaLabel}
        title={ariaLabel}
      >
        {children}
        {size === 'icon' ? null : label}
      </Button>
      {needsDialog ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent size="sm">
            <DialogHeader>
              <DialogTitle>{confirmTitle ?? label}</DialogTitle>
              {confirm ? <DialogDescription>{confirm}</DialogDescription> : null}
            </DialogHeader>
            {withNote ? (
              <div className="space-y-2">
                <Label htmlFor="action-note">{noteLabel}</Label>
                <Textarea
                  id="action-note"
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Abbrechen
              </Button>
              <Button
                type="button"
                variant={method === 'DELETE' ? 'destructive' : 'default'}
                loading={busy}
                onClick={run}
              >
                {label}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
