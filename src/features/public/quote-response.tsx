'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, Download, PenLine, X } from 'lucide-react';
import { toast } from 'sonner';

import { formatCurrency } from '@/lib/utils';
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
 * Annahme oder Ablehnung einer Offerte durch die Kundschaft.
 *
 * **Was sich mit Gate 4C geändert hat.** Hier standen ein Namensfeld und ein
 * Unterschriftenfeld, und das Abschicken setzte die Offerte unmittelbar auf
 * ACCEPTED. Beides ist weg. Die Annahme entscheidet diese Maske nicht mehr —
 * sie *beginnt* sie: Der Server legt den Unterzeichnungsvorgang an, friert
 * die Offerte als PDF ein (Hash A) und antwortet mit dem Weg dorthin. Erst
 * auf `/signieren` folgen Zustimmung, Unterschrift und Protokoll, und erst
 * deren Abschluss nimmt die Offerte an.
 *
 * **Warum die Unterschrift nicht hierbleiben konnte.** Ein Bild neben einem
 * Datensatz, der sich danach noch ändern lässt, belegt nichts. Der
 * Signaturkern bindet stattdessen Bytes: Was unterschrieben wird, ist die
 * eingefrorene Fassung, und ihre Prüfsumme steht im Protokoll. Diese Maske
 * darf davon nichts nachbauen — sonst gäbe es wieder zwei Schreibwege.
 *
 * Die Ablehnung bleibt, was sie war: eine direkte Entscheidung, ohne
 * Unterzeichnung, genauso leicht erreichbar wie die Annahme. Eine versteckte
 * Ablehnung erzeugt keine Zusagen, nur unbeantwortete Offerten.
 */
export interface QuoteResponseProps {
  grossTotal: number;
  /**
   * Wohin die Antwort geht. Der öffentliche Weg zeigt auf die Route mit
   * Capability, der Kundenbereich auf die angemeldete — dieselbe Maske, zwei
   * Eingänge. Die Adresse wird vom Server gesetzt, nicht hier gebaut: Diese
   * Komponente soll nicht wissen, welche Berechtigung dahintersteht.
   */
  endpoint: string;
  /** Abrufadresse des PDF, passend zum selben Eingang. */
  pdfUrl: string;
  /**
   * Läuft bereits eine Unterzeichnung für diese Offerte? Dann heisst die
   * Schaltfläche „fortsetzen", und der Server stellt beim Klick einen
   * erneuerten Zugang zum **selben** Vorgang aus — kein zweiter Snapshot
   * (§ 17). Die Kennung ist nicht geheim und dient nur der Anzeige.
   */
  laufendeUnterzeichnung?: boolean;
}

/** Was die Antwortroute zurückgibt — zwei Fälle, ein Schema. */
interface Antwort {
  requiresSignature: boolean;
  signatureUrl?: string;
}

export function QuoteResponse({
  grossTotal,
  endpoint,
  pdfUrl,
  laufendeUnterzeichnung = false,
}: QuoteResponseProps) {
  const router = useRouter();
  const [dialog, setDialog] = React.useState<'accept' | 'reject' | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState('');

  const respond = async (decision: 'ACCEPT' | 'REJECT') => {
    setPending(true);
    setError(null);
    try {
      const antwort = await api.post<Antwort>(endpoint, {
        decision,
        reason: decision === 'REJECT' ? reason || undefined : undefined,
      });

      if (decision === 'ACCEPT' && antwort?.requiresSignature && antwort.signatureUrl) {
        /**
         * `assign`, nicht `router.push`: Beim öffentlichen Weg trägt die
         * Adresse den Zugang im **Fragment**. Das überlebt den Client-Router
         * nicht zuverlässig, und der Browser schickt es ohnehin nie an den
         * Server — genau dafür steht es dort. Ein voller Seitenwechsel ist
         * hier das Einfachere und das Sichere.
         */
        window.location.assign(antwort.signatureUrl);
        return;
      }

      toast.success(
        decision === 'ACCEPT'
          ? 'Der Unterzeichnungsvorgang ist bereit.'
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
          {laufendeUnterzeichnung
            ? 'Ihre Unterzeichnung ist noch offen'
            : 'Möchten Sie die Offerte annehmen?'}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {laufendeUnterzeichnung ? (
            <>
              Sie haben die Annahme bereits begonnen. Setzen Sie die Unterzeichnung fort — es gilt
              die Fassung der Offerte, die beim Beginn festgehalten wurde.
            </>
          ) : (
            <>
              Mit der Annahme beauftragen Sie uns zum Gesamtbetrag von{' '}
              <strong className="text-foreground">{formatCurrency(grossTotal)}</strong> inkl. MWST.
              Im nächsten Schritt unterzeichnen Sie die Offerte elektronisch.
            </>
          )}
        </p>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <Button size="lg" onClick={() => setDialog('accept')} className="sm:flex-1">
            {laufendeUnterzeichnung ? <PenLine aria-hidden /> : <Check aria-hidden />}
            {laufendeUnterzeichnung ? 'Unterzeichnung fortsetzen' : 'Offerte annehmen'}
          </Button>
          <Button size="lg" variant="outline" onClick={() => setDialog('reject')}>
            <X aria-hidden />
            Ablehnen
          </Button>
          <Button asChild size="lg" variant="ghost">
            <a href={pdfUrl} download>
              <Download aria-hidden />
              PDF
            </a>
          </Button>
        </div>
      </div>

      {/* Annehmen — der Beginn, nicht der Abschluss */}
      <Dialog open={dialog === 'accept'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>
              {laufendeUnterzeichnung ? 'Unterzeichnung fortsetzen' : 'Offerte annehmen'}
            </DialogTitle>
            <DialogDescription>
              Wir halten die Offerte in ihrer aktuellen Fassung als PDF fest. Auf der nächsten Seite
              lesen Sie dieses Dokument, stimmen zu und unterschreiben — getippt oder gezeichnet.
              Erst damit ist die Offerte angenommen.
            </DialogDescription>
          </DialogHeader>

          {error ? <Alert variant="destructive">{error}</Alert> : null}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Abbrechen
            </Button>
            <Button loading={pending} onClick={() => respond('ACCEPT')}>
              Weiter zur Unterzeichnung
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Ablehnen — direkt und endgültig */}
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
