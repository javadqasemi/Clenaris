'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { BadgeCheck, Ban, MoreHorizontal, Sparkles } from 'lucide-react';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/overlays';

/**
 * Aktionen auf einem Einsatz.
 *
 * „Kontrolliert" (VERIFIED) ist ein eigener Schritt nach „Abgeschlossen": das
 * Team meldet die Ausführung, das Büro bestätigt die Qualitätskontrolle. Erst
 * danach ist der Einsatz abrechnungsreif.
 */
export function JobActions({ jobId, status }: { jobId: string; status: string }) {
  const router = useRouter();
  const [pending, setPending] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<'cancel' | 'report' | null>(null);
  const [reason, setReason] = React.useState('');
  const [report, setReport] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

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

  const generateReport = async () => {
    setPending('ai-report');
    try {
      const result = await api.post<{ text: string }>(`/api/jobs/${jobId}/report/draft`);
      setReport(result.text);
      setDialog('report');
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Der Bericht konnte nicht erzeugt werden.',
      );
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      <div className="flex items-center gap-2">
        {status === 'COMPLETED' ? (
          <Button
            loading={pending === 'verify'}
            onClick={() =>
              run(
                'verify',
                () => api.patch(`/api/jobs/${jobId}`, { status: 'VERIFIED' }),
                'Einsatz als kontrolliert markiert.',
              )
            }
          >
            <BadgeCheck aria-hidden />
            Kontrolliert
          </Button>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" aria-label="Weitere Aktionen">
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuItem onSelect={() => void generateReport()}>
              <Sparkles aria-hidden />
              Einsatzbericht mit KI entwerfen
            </DropdownMenuItem>

            {!['CANCELLED', 'COMPLETED', 'VERIFIED'].includes(status) ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={() => setDialog('cancel')}>
                  <Ban aria-hidden />
                  Einsatz absagen
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Absagen */}
      <Dialog open={dialog === 'cancel'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Einsatz absagen</DialogTitle>
            <DialogDescription>
              Der Einsatz wird abgesagt und die Zuteilung aufgehoben. Die zugehörige Buchung bleibt
              bestehen — stornieren Sie sie separat, falls der Auftrag ganz entfällt.
            </DialogDescription>
          </DialogHeader>

          {error ? <Alert variant="destructive">{error}</Alert> : null}

          <div className="space-y-2">
            <Label htmlFor="job-cancel-reason" required>
              Grund
            </Label>
            <Textarea
              id="job-cancel-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              placeholder="z. B. Kundschaft nicht angetroffen, Zugang fehlte."
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
                  () =>
                    api.patch(`/api/jobs/${jobId}`, {
                      status: 'CANCELLED',
                      internalNote: `Abgesagt: ${reason}`,
                    }),
                  'Einsatz abgesagt.',
                )
              }
            >
              Absagen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* KI-Bericht */}
      <Dialog open={dialog === 'report'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>Einsatzbericht — Entwurf</DialogTitle>
            <DialogDescription>
              Aus Checkliste, Material und Zeiterfassung erzeugt. Bitte prüfen und anpassen, bevor
              der Text gespeichert wird.
            </DialogDescription>
          </DialogHeader>

          <Textarea
            value={report}
            onChange={(event) => setReport(event.target.value)}
            rows={14}
            aria-label="Einsatzbericht"
          />

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Verwerfen
            </Button>
            <Button
              loading={pending === 'save-report'}
              onClick={() =>
                run(
                  'save-report',
                  () => api.patch(`/api/jobs/${jobId}`, { internalNote: report }),
                  'Bericht gespeichert.',
                )
              }
            >
              Bericht übernehmen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
