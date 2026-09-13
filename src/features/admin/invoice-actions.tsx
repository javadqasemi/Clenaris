'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Ban, Banknote, FileCheck2, MoreHorizontal, Send, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/form';
import { Alert } from '@/components/ui/primitives';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/controls';
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
 * Aktionen auf einer Rechnung.
 *
 * „Ausstellen" ist bewusst ein eigener, bestätigter Schritt: danach ist die
 * Rechnung nummeriert und unveränderlich. Wer sie danach korrigieren muss,
 * erstellt eine Gutschrift — das entspricht der Aufbewahrungspflicht nach
 * Art. 957a OR.
 */
const PAYMENT_METHODS = [
  { value: 'BANK_TRANSFER', label: 'Banküberweisung' },
  { value: 'TWINT', label: 'TWINT' },
  { value: 'CARD', label: 'Karte' },
  { value: 'CASH', label: 'Bar' },
  { value: 'OTHER', label: 'Andere' },
];

export function InvoiceActions({
  invoiceId,
  status,
  balance,
  email,
  canDelete = false,
}: {
  invoiceId: string;
  status: string;
  balance: number;
  email: string;
  /**
   * `invoice:delete` — gilt nur für Entwürfe. Eine ausgestellte Rechnung
   * trägt eine Nummer aus einer lückenlosen Folge (Art. 957a OR) und lässt
   * sich nur stornieren; der Papierkorb verweigert sie ohnehin.
   */
  canDelete?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<'payment' | 'cancel' | 'delete' | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const [amount, setAmount] = React.useState(balance.toFixed(2));
  const [method, setMethod] = React.useState('BANK_TRANSFER');
  const [reference, setReference] = React.useState('');
  const [reason, setReason] = React.useState('');

  const run = async (action: string, request: () => Promise<unknown>, message: string) => {
    setPending(action);
    setError(null);
    try {
      await request();
      toast.success(message);
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

  const isDraft = status === 'DRAFT';
  const canSend = !['CANCELLED', 'PAID'].includes(status);
  const canRecordPayment = balance > 0 && !['DRAFT', 'CANCELLED'].includes(status);
  const canCancel = !['CANCELLED', 'PAID', 'PARTIALLY_PAID'].includes(status);

  return (
    <>
      <div className="flex items-center gap-2">
        {isDraft ? (
          <Button
            loading={pending === 'issue'}
            onClick={() =>
              run(
                'issue',
                () => api.post(`/api/invoices/${invoiceId}/issue`),
                'Rechnung ausgestellt und nummeriert.',
              )
            }
          >
            <FileCheck2 aria-hidden />
            Ausstellen
          </Button>
        ) : canSend ? (
          <Button
            loading={pending === 'send'}
            onClick={() =>
              run(
                'send',
                () => api.post(`/api/invoices/${invoiceId}/send`),
                `Rechnung an ${email} versendet.`,
              )
            }
          >
            <Send aria-hidden />
            Versenden
          </Button>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" aria-label="Weitere Aktionen">
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            {canRecordPayment ? (
              <DropdownMenuItem onSelect={() => setDialog('payment')}>
                <Banknote aria-hidden />
                Zahlung erfassen
              </DropdownMenuItem>
            ) : null}

            {!isDraft && canSend ? (
              <DropdownMenuItem
                onSelect={() =>
                  run(
                    'send',
                    () => api.post(`/api/invoices/${invoiceId}/send`),
                    'Rechnung erneut versendet.',
                  )
                }
              >
                <Send aria-hidden />
                Erneut versenden
              </DropdownMenuItem>
            ) : null}

            {canCancel ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={() => setDialog('cancel')}>
                  <Ban aria-hidden />
                  Rechnung stornieren
                </DropdownMenuItem>
              </>
            ) : null}

            {isDraft && canDelete ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={() => setDialog('delete')}>
                  <Trash2 aria-hidden />
                  Entwurf in den Papierkorb
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Entwurf löschen */}
      <Dialog open={dialog === 'delete'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Entwurf in den Papierkorb legen?</DialogTitle>
            <DialogDescription>
              Der Entwurf hat noch keine Nummer und hinterlässt keine Lücke. Er bleibt unter
              &bdquo;Papierkorb&ldquo; wiederherstellbar.
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
                    await api.delete(`/api/invoices/${invoiceId}`);
                    router.push('/admin/rechnungen');
                  },
                  'Entwurf in den Papierkorb gelegt.',
                )
              }
            >
              <Trash2 aria-hidden />
              In den Papierkorb
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Zahlung erfassen */}
      <Dialog open={dialog === 'payment'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Zahlung erfassen</DialogTitle>
            <DialogDescription>
              Offener Betrag: {formatCurrency(balance)}. Bei vollständigem Ausgleich erhält die
              Kundschaft automatisch eine Bestätigung.
            </DialogDescription>
          </DialogHeader>

          {error ? <Alert variant="destructive">{error}</Alert> : null}

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="payment-amount" required>
                Betrag
              </Label>
              <Input
                id="payment-amount"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value.replace(',', '.'))}
                suffix="CHF"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="payment-method">Zahlungsart</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger id="payment-method">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHODS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="payment-reference">Referenz</Label>
              <Input
                id="payment-reference"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder="z. B. Bankbeleg-Nr."
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Abbrechen
            </Button>
            <Button
              loading={pending === 'payment'}
              disabled={!(Number(amount) > 0)}
              onClick={() =>
                run(
                  'payment',
                  () =>
                    api.post(`/api/invoices/${invoiceId}/payments`, {
                      amount: Number(amount),
                      method,
                      reference: reference || undefined,
                    }),
                  'Zahlung erfasst.',
                )
              }
            >
              Zahlung buchen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Stornieren */}
      <Dialog open={dialog === 'cancel'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Rechnung stornieren</DialogTitle>
            <DialogDescription>
              Die Rechnung bleibt als stornierter Beleg erhalten — die Nummer wird nicht wieder
              vergeben. Bei bereits erhaltenen Zahlungen erstellen Sie stattdessen eine Gutschrift.
            </DialogDescription>
          </DialogHeader>

          {error ? <Alert variant="destructive">{error}</Alert> : null}

          <div className="space-y-2">
            <Label htmlFor="cancel-invoice-reason" required>
              Grund
            </Label>
            <Textarea
              id="cancel-invoice-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              placeholder="z. B. Doppelt erfasst, Leistung nicht erbracht."
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
                  () => api.post(`/api/invoices/${invoiceId}/cancel`, { reason }),
                  'Rechnung storniert.',
                )
              }
            >
              Stornieren
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
