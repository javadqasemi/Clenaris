'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/overlays';

/**
 * Löschbestätigung für die Website-Inhalte.
 *
 * Der Server entscheidet, *ob* gelöscht werden darf. Dieser Dialog fragt
 * deshalb nicht „sind Sie sicher", sondern beschreibt die Folge — und zeigt
 * die Antwort des Servers, wenn sie ablehnend ausfällt. Das ist die
 * Information, die tatsächlich weiterhilft.
 */
export function ConfirmDelete({
  target,
  onClose,
}: {
  target: { title: string; description: string; endpoint: string } | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (target) setError(null);
  }, [target]);

  const confirm = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await api.delete(target.endpoint);
      toast.success(`„${target.title}" gelöscht.`);
      onClose();
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Löschen fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>„{target?.title}&ldquo; löschen?</DialogTitle>
          <DialogDescription>{target?.description}</DialogDescription>
        </DialogHeader>

        {error ? (
          <p
            role="alert"
            className="rounded-xl border border-destructive/25 bg-destructive/5 p-4 text-sm leading-relaxed text-destructive"
          >
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="destructive" onClick={confirm} loading={busy}>
            Löschen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
