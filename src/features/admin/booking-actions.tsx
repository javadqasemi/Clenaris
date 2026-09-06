'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Ban, CalendarClock, Check, MoreHorizontal, Receipt } from 'lucide-react';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/overlays';

/**
 * Aktionen auf einer Buchung.
 *
 * Der Storno verlangt eine Begründung — sie landet in der Bestätigungsmail an
 * die Kundschaft und im Audit-Log. Ohne Begründung entstehen Rückfragen, die
 * das Büro dann telefonisch klären muss.
 */
export function BookingActions({
  bookingId,
  status,
  scheduledStart,
  hasInvoice,
}: {
  bookingId: string;
  status: string;
  scheduledStart: string;
  hasInvoice: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<'cancel' | 'reschedule' | null>(null);
  const [reason, setReason] = React.useState('');
  const [newStart, setNewStart] = React.useState(() => toLocalInput(scheduledStart));
  const [error, setError] = React.useState<string | null>(null);

  const run = async (action: string, request: () => Promise<unknown>, successMessage: string) => {
    setPending(action);
    setError(null);
    try {
      await request();
      toast.success(successMessage);
      setDialog(null);
      setReason('');
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Die Aktion konnte nicht ausgeführt werden.';
      setError(message);
      toast.error(message);
    } finally {
      setPending(null);
    }
  };

  const canConfirm = status === 'PENDING' || status === 'DRAFT';
  const canCancel = !['CANCELLED', 'COMPLETED'].includes(status);
  const canReschedule = !['CANCELLED', 'COMPLETED', 'IN_PROGRESS'].includes(status);
  const canInvoice = status === 'COMPLETED' && !hasInvoice;

  return (
    <>
      <div className="flex items-center gap-2">
        {canConfirm ? (
          <Button
            loading={pending === 'confirm'}
            onClick={() =>
              run(
                'confirm',
                () => api.post(`/api/bookings/${bookingId}/confirm`),
                'Buchung bestätigt. Die Kundschaft wurde benachrichtigt.',
              )
            }
          >
            <Check aria-hidden />
            Bestätigen
          </Button>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" aria-label="Weitere Aktionen">
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {canReschedule ? (
              <DropdownMenuItem onSelect={() => setDialog('reschedule')}>
                <CalendarClock aria-hidden />
                Termin verschieben
              </DropdownMenuItem>
            ) : null}

            {canInvoice ? (
              <DropdownMenuItem
                onSelect={() =>
                  run(
                    'invoice',
                    () => api.post(`/api/bookings/${bookingId}/invoice`),
                    'Rechnungsentwurf erstellt.',
                  )
                }
              >
                <Receipt aria-hidden />
                Rechnung erstellen
              </DropdownMenuItem>
            ) : null}

            {canCancel ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={() => setDialog('cancel')}>
                  <Ban aria-hidden />
                  Buchung stornieren
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Stornieren */}
      <Dialog open={dialog === 'cancel'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Buchung stornieren</DialogTitle>
            <DialogDescription>
              Die Kundschaft erhält eine E-Mail mit Ihrer Begründung. Zugehörige Einsätze werden
              ebenfalls abgesagt.
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
              placeholder="z. B. Auf Wunsch der Kundschaft, Termin nicht mehr benötigt."
              rows={3}
            />
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Abbrechen
            </Button>
            <Button
              variant="destructive"
              disabled={reason.trim().length < 3}
              loading={pending === 'cancel'}
              onClick={() =>
                run(
                  'cancel',
                  () => api.post(`/api/bookings/${bookingId}/cancel`, { reason }),
                  'Buchung storniert.',
                )
              }
            >
              Buchung stornieren
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
              Die Dauer bleibt unverändert. Zugehörige Einsätze und die Kundschaft werden
              automatisch aktualisiert.
            </DialogDescription>
          </DialogHeader>

          {error ? <Alert variant="destructive">{error}</Alert> : null}

          <div className="space-y-2">
            <Label htmlFor="new-start" required>
              Neuer Beginn
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
              loading={pending === 'reschedule'}
              onClick={() =>
                run(
                  'reschedule',
                  () =>
                    api.post(`/api/bookings/${bookingId}/reschedule`, {
                      scheduledStart: new Date(newStart).toISOString(),
                    }),
                  'Termin verschoben.',
                )
              }
            >
              Verschieben
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** ISO-Zeitstempel in den Wert eines `datetime-local`-Feldes umwandeln. */
function toLocalInput(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
