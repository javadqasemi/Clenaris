'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Merge, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';

import { cn, formatDate } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Alert, Skeleton } from '@/components/ui/primitives';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/overlays';

/**
 * Doppelte Kundendatensätze zusammenführen.
 *
 * Gestaltungsentscheide:
 *
 *  • **Vorschläge statt Suchfeld.** Wer zusammenführen will, weiss selten die
 *    Kundennummer des Doppels auswendig — er hat nur den Verdacht. Die
 *    Vorschlagsliste sucht mit denselben Kriterien wie die Doppelerkennung bei
 *    Anfragen: E-Mail, Telefonnummer, Name plus Firma.
 *
 *  • **Die Richtung steht ausdrücklich da.** „A wird in B eingegliedert" ist
 *    keine symmetrische Aussage, und wer sie verwechselt, verliert die
 *    Stammdaten des falschen Datensatzes. Deshalb nennt der Bestätigungstext
 *    beide Nummern beim Namen.
 *
 *  • **Ein zweiter, bewusster Klick.** Der Vorgang ist nicht umkehrbar. Die
 *    Auswahl eines Vorschlags führt deshalb nicht direkt zur Ausführung.
 */

interface DuplicateCandidate {
  id: string;
  number: string;
  name: string;
  email: string;
  phone: string | null;
  createdAt: string;
}

export function CustomerMerge({
  customerId,
  customerNumber,
  customerName,
}: {
  customerId: string;
  customerNumber: string;
  customerName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [candidates, setCandidates] = React.useState<DuplicateCandidate[] | null>(null);
  const [selected, setSelected] = React.useState<DuplicateCandidate | null>(null);
  const [confirming, setConfirming] = React.useState(false);
  const [merging, setMerging] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = async () => {
    setOpen(true);
    setLoading(true);
    setError(null);
    setSelected(null);
    setConfirming(false);
    try {
      setCandidates(await api.get<DuplicateCandidate[]>(`/api/customers/${customerId}/merge`));
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Die Vorschläge konnten nicht geladen werden.',
      );
    } finally {
      setLoading(false);
    }
  };

  const merge = async () => {
    if (!selected) return;
    setMerging(true);
    setError(null);
    try {
      await api.post(`/api/customers/${customerId}/merge`, { sourceId: selected.id });
      toast.success(`${selected.number} wurde in ${customerNumber} eingegliedert.`);
      setOpen(false);
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Die Zusammenführung ist fehlgeschlagen.';
      setError(message);
      toast.error(message);
    } finally {
      setMerging(false);
    }
  };

  return (
    <>
      <Button variant="outline" onClick={() => void load()}>
        <Merge aria-hidden />
        Zusammenführen
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>Doppelten Kundendatensatz eingliedern</DialogTitle>
            <DialogDescription>
              Buchungen, Einsätze, Offerten, Rechnungen, Objekte und die Historie wandern zu{' '}
              <strong>{customerNumber}</strong>. Der eingegliederte Datensatz wird anschliessend
              archiviert — seine Nummer bleibt auf bereits versendeten Belegen gültig.
            </DialogDescription>
          </DialogHeader>

          {error ? <Alert variant="destructive">{error}</Alert> : null}

          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, index) => (
                <Skeleton key={index} className="h-16" />
              ))}
            </div>
          ) : candidates && candidates.length === 0 ? (
            <Alert variant="info" title="Kein Doppel gefunden">
              Es gibt keinen weiteren Datensatz mit derselben E-Mail-Adresse, Telefonnummer oder
              derselben Person in derselben Firma. Wenn Sie trotzdem eines vermuten, prüfen Sie die
              Schreibweise der Adresse in der Kundenliste.
            </Alert>
          ) : (
            <ul className="space-y-2">
              {candidates?.map((candidate) => {
                const active = selected?.id === candidate.id;
                return (
                  <li key={candidate.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(candidate);
                        setConfirming(false);
                      }}
                      aria-pressed={active}
                      className={cn(
                        'flex w-full flex-wrap items-center gap-3 rounded-xl border p-3 text-left transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        active
                          ? 'border-primary bg-primary/[0.06]'
                          : 'border-border hover:bg-muted/50',
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {candidate.name}{' '}
                          <span className="font-normal tabular-nums text-muted-foreground">
                            {candidate.number}
                          </span>
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {candidate.email}
                          {candidate.phone ? ` · ${candidate.phone}` : ''} · erfasst{' '}
                          {formatDate(candidate.createdAt)}
                        </p>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {selected && !confirming ? (
            <Alert variant="warning" title="Nicht umkehrbar">
              <span className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  <strong>{selected.number}</strong> ({selected.name}) wird in{' '}
                  <strong>{customerNumber}</strong> ({customerName}) eingegliedert. Name, Adresse
                  und Konditionen von {customerNumber} bleiben unverändert — was fehlt, ergänzen
                  Sie danach von Hand.
                </span>
              </span>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Abbrechen
            </Button>
            {confirming ? (
              <Button variant="destructive" loading={merging} onClick={() => void merge()}>
                <Merge aria-hidden />
                Endgültig eingliedern
              </Button>
            ) : (
              <Button disabled={!selected} onClick={() => setConfirming(true)}>
                Weiter
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
