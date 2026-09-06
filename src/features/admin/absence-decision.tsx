'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, X } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/form';
import { Alert } from '@/components/ui/primitives';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/overlays';

/**
 * Abwesenheit bewilligen oder ablehnen.
 *
 * Die Bewilligung prüft serverseitig, ob im Zeitraum bereits Einsätze
 * zugeteilt sind — eine bewilligte Abwesenheit mit offener Einsatzplanung
 * wäre ein Dispositionsloch, das erst am Einsatztag auffällt.
 */
export function AbsenceDecision({ absenceId }: { absenceId: string }) {
  const router = useRouter();
  const [pending, setPending] = React.useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = React.useState(false);
  const [note, setNote] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const decide = async (status: 'APPROVED' | 'REJECTED', decisionNote?: string) => {
    setPending(status);
    setError(null);
    try {
      await api.post(`/api/absences/${absenceId}/decide`, { status, decisionNote });
      toast.success(status === 'APPROVED' ? 'Abwesenheit bewilligt.' : 'Antrag abgelehnt.');
      setRejectOpen(false);
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Die Entscheidung konnte nicht gespeichert werden.';
      setError(message);
      toast.error(message);
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="success"
          loading={pending === 'APPROVED'}
          onClick={() => decide('APPROVED')}
        >
          <Check aria-hidden />
          Bewilligen
        </Button>
        <Button size="sm" variant="outline" onClick={() => setRejectOpen(true)}>
          <X aria-hidden />
          Ablehnen
        </Button>
      </div>

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Antrag ablehnen</DialogTitle>
            <DialogDescription>
              Die betroffene Person erhält die Begründung per E-Mail und im Portal. Eine
              nachvollziehbare Absage vermeidet Rückfragen.
            </DialogDescription>
          </DialogHeader>

          {error ? <Alert variant="destructive">{error}</Alert> : null}

          <div className="space-y-2">
            <Label htmlFor="absence-note" required>
              Begründung
            </Label>
            <Textarea
              id="absence-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              placeholder="z. B. In dieser Woche sind bereits zwei Personen abwesend."
            />
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejectOpen(false)}>
              Abbrechen
            </Button>
            <Button
              variant="destructive"
              disabled={note.trim().length < 3}
              loading={pending === 'REJECTED'}
              onClick={() => decide('REJECTED', note)}
            >
              Ablehnen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
