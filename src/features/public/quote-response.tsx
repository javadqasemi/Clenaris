'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, Download, X } from 'lucide-react';
import { toast } from 'sonner';

import { formatCurrency } from '@/lib/utils';
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
import { SignaturePad } from '@/features/portal/signature-pad';

/**
 * Annahme oder Ablehnung einer Offerte durch die Kundschaft.
 *
 * Die Annahme verlangt Name *und* Unterschrift. Zusammen mit Zeitstempel und
 * IP-Adresse, die der Server protokolliert, ergibt das eine einfache
 * elektronische Signatur nach ZertES — ausreichend für einen
 * Dienstleistungsvertrag ohne gesetzliche Formvorschrift.
 *
 * Die Ablehnung ist bewusst genauso leicht erreichbar. Eine versteckte
 * Ablehnung erzeugt keine Zusagen, nur unbeantwortete Offerten.
 */
export function QuoteResponse({ token, grossTotal }: { token: string; grossTotal: number }) {
  const router = useRouter();
  const [dialog, setDialog] = React.useState<'accept' | 'reject' | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [name, setName] = React.useState('');
  const [signature, setSignature] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState('');

  const respond = async (decision: 'ACCEPT' | 'REJECT') => {
    setPending(true);
    setError(null);
    try {
      await api.post(`/api/public/quotes/${token}/respond`, {
        decision,
        signatureDataUrl: decision === 'ACCEPT' ? signature : undefined,
        signatureName: decision === 'ACCEPT' ? name : undefined,
        reason: decision === 'REJECT' ? reason || undefined : undefined,
      });

      toast.success(
        decision === 'ACCEPT'
          ? 'Vielen Dank. Wir melden uns zur Terminvereinbarung.'
          : 'Ihre Rückmeldung ist angekommen.',
      );
      setDialog(null);
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Ihre Antwort konnte nicht gespeichert werden.';
      setError(message);
      toast.error(message);
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <div className="rounded-2xl border border-border bg-card p-6 shadow-card sm:p-8">
        <h2 className="font-display text-lg font-semibold tracking-tight">
          Möchten Sie die Offerte annehmen?
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Mit der Annahme beauftragen Sie uns zum Gesamtbetrag von{' '}
          <strong className="text-foreground">{formatCurrency(grossTotal)}</strong> inkl. MWST.
          Anschliessend vereinbaren wir gemeinsam den Termin.
        </p>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <Button size="lg" onClick={() => setDialog('accept')} className="sm:flex-1">
            <Check aria-hidden />
            Offerte annehmen
          </Button>
          <Button size="lg" variant="outline" onClick={() => setDialog('reject')}>
            <X aria-hidden />
            Ablehnen
          </Button>
          <Button asChild size="lg" variant="ghost">
            <a href={`/api/public/quotes/${token}/pdf`} download>
              <Download aria-hidden />
              PDF
            </a>
          </Button>
        </div>
      </div>

      {/* Annehmen */}
      <Dialog open={dialog === 'accept'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Offerte annehmen</DialogTitle>
            <DialogDescription>
              Bitte bestätigen Sie mit Ihrem Namen und Ihrer Unterschrift. Wir speichern beides
              zusammen mit Datum und Uhrzeit als Nachweis der Auftragserteilung.
            </DialogDescription>
          </DialogHeader>

          {error ? <Alert variant="destructive">{error}</Alert> : null}

          <div className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="signature-name" required>
                Vor- und Nachname
              </Label>
              <Input
                id="signature-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Maria Muster"
                autoComplete="name"
              />
            </div>

            <div className="space-y-2">
              <Label required>Unterschrift</Label>
              <SignaturePad value={signature} onChange={setSignature} />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Abbrechen
            </Button>
            <Button
              loading={pending}
              disabled={name.trim().length < 3 || !signature}
              onClick={() => respond('ACCEPT')}
            >
              Verbindlich annehmen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Ablehnen */}
      <Dialog open={dialog === 'reject'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Offerte ablehnen</DialogTitle>
            <DialogDescription>
              Schade. Eine kurze Rückmeldung hilft uns, das nächste Angebot besser zu machen — ist
              aber freiwillig.
            </DialogDescription>
          </DialogHeader>

          {error ? <Alert variant="destructive">{error}</Alert> : null}

          <div className="space-y-2">
            <Label htmlFor="reject-reason">Grund (optional)</Label>
            <Textarea
              id="reject-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              placeholder="z. B. Preis über Budget, anderer Anbieter, Termin passt nicht."
            />
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Abbrechen
            </Button>
            <Button variant="destructive" loading={pending} onClick={() => respond('REJECT')}>
              Offerte ablehnen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
