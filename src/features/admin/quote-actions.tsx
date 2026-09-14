'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { CalendarPlus, Copy, MoreHorizontal, Receipt, Send, Trash2 } from 'lucide-react';
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
 * Aktionen auf einer Offerte.
 *
 * Nach der Annahme sind nur noch zwei Wege sinnvoll: in eine Buchung (der
 * Einsatz muss terminiert werden) oder direkt in eine Rechnung (die Leistung
 * ist bereits erbracht). Beides erzeugt einen verknüpften Beleg, damit die
 * Herkunft nachvollziehbar bleibt.
 */
export function QuoteActions({
  quoteId,
  status,
  hasCustomer,
  email,
  canDelete = false,
}: {
  quoteId: string;
  status: string;
  hasCustomer: boolean;
  email: string;
  /** `quote:delete` — die Seite reicht das Recht durch, der Endpunkt prüft es erneut. */
  canDelete?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<'send' | 'booking' | 'delete' | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const [message, setMessage] = React.useState('');
  const [scheduledStart, setScheduledStart] = React.useState(() => defaultStart());

  const run = async (action: string, request: () => Promise<unknown>, successMessage: string) => {
    setPending(action);
    setError(null);
    try {
      await request();
      toast.success(successMessage);
      setDialog(null);
      router.refresh();
    } catch (err) {
      const text =
        err instanceof ApiError ? err.message : 'Die Aktion konnte nicht ausgeführt werden.';
      setError(text);
      toast.error(text);
    } finally {
      setPending(null);
    }
  };

  const canSend = ['DRAFT', 'SENT', 'VIEWED'].includes(status);
  const canConvert = status === 'ACCEPTED';
  // Eine angenommene Offerte ist eine vertragliche Zusage — der Papierkorb
  // verweigert sie (siehe `trash.service`), also wird sie gar nicht angeboten.
  const mayTrash = canDelete && !['ACCEPTED', 'CONVERTED'].includes(status);

  return (
    <>
      <div className="flex items-center gap-2">
        {canSend ? (
          <Button onClick={() => setDialog('send')}>
            <Send aria-hidden />
            {status === 'DRAFT' ? 'Versenden' : 'Erneut senden'}
          </Button>
        ) : null}

        {canConvert ? (
          <Button onClick={() => setDialog('booking')}>
            <CalendarPlus aria-hidden />
            In Buchung umwandeln
          </Button>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" aria-label="Weitere Aktionen">
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuItem
              onSelect={() =>
                run(
                  'duplicate',
                  async () => {
                    const copy = await api.post<{ id: string }>(`/api/quotes/${quoteId}/duplicate`);
                    router.push(`/admin/offerten/${copy.id}`);
                  },
                  'Kopie erstellt.',
                )
              }
            >
              <Copy aria-hidden />
              Duplizieren
            </DropdownMenuItem>

            {canConvert && hasCustomer ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() =>
                    run(
                      'invoice',
                      async () => {
                        const invoice = await api.post<{ id: string }>(
                          `/api/quotes/${quoteId}/convert`,
                          { target: 'INVOICE' },
                        );
                        router.push(`/admin/rechnungen/${invoice.id}`);
                      },
                      'Rechnung aus Offerte erstellt.',
                    )
                  }
                >
                  <Receipt aria-hidden />
                  In Rechnung umwandeln
                </DropdownMenuItem>
              </>
            ) : null}

            {mayTrash ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={() => setDialog('delete')}>
                  <Trash2 aria-hidden />
                  In den Papierkorb
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Papierkorb */}
      <Dialog open={dialog === 'delete'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Offerte in den Papierkorb legen?</DialogTitle>
            <DialogDescription>
              Die Offerte verschwindet aus den Listen, bleibt aber unter &bdquo;Papierkorb&ldquo;
              wiederherstellbar. Die Kundschaft wird nicht benachrichtigt; ein versendeter Link
              bleibt bis zum Ablauf gültig.
            </DialogDescription>
          </DialogHeader>

          {error ? <Alert variant="destructive">{error}</Alert> : null}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Abbrechen
            </Button>
            <Button
              variant="destructive"
              loading={pending === 'delete'}
              onClick={() =>
                run(
                  'delete',
                  async () => {
                    await api.delete(`/api/quotes/${quoteId}`);
                    router.push('/admin/offerten');
                  },
                  'Offerte in den Papierkorb gelegt.',
                )
              }
            >
              <Trash2 aria-hidden />
              In den Papierkorb
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Versenden */}
      <Dialog open={dialog === 'send'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Offerte versenden</DialogTitle>
            <DialogDescription>
              Empfänger: {email || 'keine E-Mail-Adresse hinterlegt'}. Die Offerte wird als PDF
              angehängt; zusätzlich erhält die Kundschaft einen Link zum Annehmen mit digitaler
              Unterschrift.
            </DialogDescription>
          </DialogHeader>

          {error ? <Alert variant="destructive">{error}</Alert> : null}

          <div className="space-y-2">
            <Label htmlFor="quote-message">Persönliche Nachricht (optional)</Label>
            <Textarea
              id="quote-message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              rows={4}
              placeholder="Guten Tag Frau Muster, gerne unterbreiten wir Ihnen wie besprochen unsere Offerte …"
            />
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Abbrechen
            </Button>
            <Button
              loading={pending === 'send'}
              disabled={!email}
              onClick={() =>
                run(
                  'send',
                  () =>
                    api.post(`/api/quotes/${quoteId}/send`, {
                      message: message || undefined,
                      attachPdf: true,
                    }),
                  'Offerte versendet.',
                )
              }
            >
              Jetzt versenden
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* In Buchung umwandeln */}
      <Dialog open={dialog === 'booking'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>In Buchung umwandeln</DialogTitle>
            <DialogDescription>
              Aus den Positionen entsteht eine bestätigte Buchung samt Einsatz. Die Dauer leiten wir
              aus den Stundenpositionen ab.
            </DialogDescription>
          </DialogHeader>

          {error ? <Alert variant="destructive">{error}</Alert> : null}

          <div className="space-y-2">
            <Label htmlFor="quote-start" required>
              Einsatzbeginn
            </Label>
            <Input
              id="quote-start"
              type="datetime-local"
              value={scheduledStart}
              onChange={(event) => setScheduledStart(event.target.value)}
            />
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Abbrechen
            </Button>
            <Button
              loading={pending === 'booking'}
              onClick={() =>
                run(
                  'booking',
                  async () => {
                    const booking = await api.post<{ id: string }>(
                      `/api/quotes/${quoteId}/convert`,
                      {
                        target: 'BOOKING',
                        scheduledStart: new Date(scheduledStart).toISOString(),
                      },
                    );
                    router.push(`/admin/buchungen/${booking.id}`);
                  },
                  'Buchung erstellt.',
                )
              }
            >
              Buchung erstellen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Vorschlag: übernächster Werktag, 08:00 Uhr. */
function defaultStart(): string {
  const date = new Date();
  date.setDate(date.getDate() + 3);
  while (date.getDay() === 0 || date.getDay() === 6) date.setDate(date.getDate() + 1);
  date.setHours(8, 0, 0, 0);

  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T08:00`;
}
