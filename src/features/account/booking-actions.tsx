'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { CalendarClock, Phone, X } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
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
 * Kundenaktionen auf einer Buchung.
 *
 * Innerhalb der 24-Stunden-Frist blenden wir die Schaltflächen nicht aus,
 * sondern erklären, warum sie nicht mehr greifen, und bieten den Anruf an.
 * Eine verschwundene Funktion erzeugt mehr Support-Aufwand als eine erklärte
 * Einschränkung.
 */
export function CustomerBookingActions({
  bookingId,
  canModify,
  status,
  scheduledStart,
}: {
  bookingId: string;
  canModify: boolean;
  status: string;
  scheduledStart: string;
}) {
  const router = useRouter();
  const [dialog, setDialog] = React.useState<'cancel' | 'reschedule' | 'locked' | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState('');
  const [newStart, setNewStart] = React.useState(() => toLocalInput(scheduledStart));

  const isOpen = ['PENDING', 'CONFIRMED'].includes(status);
  if (!isOpen) return null;

  const run = async (request: () => Promise<unknown>, message: string) => {
    setPending(true);
    setError(null);
    try {
      await request();
      toast.success(message);
      setDialog(null);
      router.refresh();
    } catch (err) {
      const text =
        err instanceof ApiError ? err.message : 'Die Änderung konnte nicht gespeichert werden.';
      setError(text);
      toast.error(text);
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={() => setDialog(canModify ? 'reschedule' : 'locked')}>
          <CalendarClock aria-hidden />
          Verschieben
        </Button>
        <Button variant="ghost" onClick={() => setDialog(canModify ? 'cancel' : 'locked')}>
          <X aria-hidden />
          Stornieren
        </Button>
      </div>

      {/* Frist abgelaufen */}
      <Dialog open={dialog === 'locked'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Änderung nur noch telefonisch</DialogTitle>
            <DialogDescription>
              Ihr Termin beginnt in weniger als 24 Stunden. Unser Team ist bereits eingeplant —
              rufen Sie uns an, wir finden meist noch eine Lösung.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Schliessen
            </Button>
            <Button asChild>
              <a href="tel:+41315112233">
                <Phone aria-hidden />
                031 511 22 33
              </a>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Verschieben */}
      <Dialog open={dialog === 'reschedule'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Termin verschieben</DialogTitle>
            <DialogDescription>
              Wählen Sie einen neuen Beginn. Die Dauer und der Preis bleiben unverändert. Ist der
              Wunschtermin ausgebucht, melden wir uns bei Ihnen.
            </DialogDescription>
          </DialogHeader>

          {error ? <Alert variant="destructive">{error}</Alert> : null}

          <div className="space-y-2">
            <Label htmlFor="new-start" required>
              Neuer Termin
            </Label>
            <Input
              id="new-start"
              type="datetime-local"
              value={newStart}
              onChange={(event) => setNewStart(event.target.value)}
            />
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Abbrechen
            </Button>
            <Button
              loading={pending}
              onClick={() =>
                run(
                  () =>
                    api.post(`/api/account/bookings/${bookingId}/reschedule`, {
                      scheduledStart: new Date(newStart).toISOString(),
                    }),
                  'Ihr Termin wurde verschoben.',
                )
              }
            >
              Termin verschieben
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Stornieren */}
      <Dialog open={dialog === 'cancel'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Termin stornieren</DialogTitle>
            <DialogDescription>
              Die Stornierung ist kostenlos. Sie erhalten eine Bestätigung per E-Mail.
            </DialogDescription>
          </DialogHeader>

          {error ? <Alert variant="destructive">{error}</Alert> : null}

          <div className="space-y-2">
            <Label htmlFor="cancel-reason" required>
              Grund
            </Label>
            <Textarea
              id="cancel-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              placeholder="z. B. Termin passt doch nicht, Umzug verschoben."
            />
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Doch behalten
            </Button>
            <Button
              variant="destructive"
              disabled={reason.trim().length < 3}
              loading={pending}
              onClick={() =>
                run(
                  () => api.post(`/api/account/bookings/${bookingId}/cancel`, { reason }),
                  'Ihr Termin wurde storniert.',
                )
              }
            >
              Termin stornieren
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function toLocalInput(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
