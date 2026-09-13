'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { MoreHorizontal, Trash2, UserPlus } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
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
 * Aktionen auf einer Anfrage.
 *
 * Die wichtigste davon fehlte bisher ganz: **die Übernahme in die Kundschaft.**
 * Der Endpunkt existierte, aber keine Schaltfläche führte dorthin — wer eine
 * Anfrage gewonnen hatte, musste den Kundendatensatz von Hand neu tippen und
 * die Verbindung zur Anfrage ging verloren. Damit fehlte anschliessend die
 * Antwort auf „woher kommt diese Kundschaft eigentlich".
 *
 * Die Übernahme erkennt eine bestehende Kundschaft mit derselben Adresse und
 * verknüpft, statt zu duplizieren — das entscheidet der Server.
 */

const STATUS_OPTIONS = [
  { value: 'NEW', label: 'Neu' },
  { value: 'CONTACTED', label: 'Kontaktiert' },
  { value: 'QUALIFIED', label: 'Qualifiziert' },
  { value: 'PROPOSAL', label: 'Offerte gestellt' },
  { value: 'WON', label: 'Gewonnen' },
  { value: 'LOST', label: 'Verloren' },
] as const;

export function LeadActions({
  leadId,
  status,
  hasCustomer,
  canConvert = false,
  canUpdate = false,
  canDelete = false,
}: {
  leadId: string;
  status: string;
  hasCustomer: boolean;
  canConvert?: boolean;
  canUpdate?: boolean;
  canDelete?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<'convert' | 'lost' | 'delete' | null>(null);
  const [lostReason, setLostReason] = React.useState('');
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

  const changeStatus = (next: string) => {
    // „Verloren" ohne Begründung ist eine verlorene Information: In der
    // Auswertung ist der Grund die einzige Zahl, aus der sich etwas lernen
    // lässt. Deshalb der Umweg über den Dialog.
    if (next === 'LOST') {
      setDialog('lost');
      return;
    }
    void run('status', () => api.patch(`/api/leads/${leadId}`, { status: next }), 'Status geändert.');
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {canUpdate ? (
          <Select value={status} onValueChange={changeStatus}>
            <SelectTrigger className="w-48" aria-label="Status der Anfrage">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        {canConvert && !hasCustomer ? (
          <Button onClick={() => setDialog('convert')}>
            <UserPlus aria-hidden />
            Als Kundschaft erfassen
          </Button>
        ) : null}

        {canDelete ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="Weitere Aktionen">
                <MoreHorizontal aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem disabled>Weitere Aktionen</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={() => setDialog('delete')}>
                <Trash2 aria-hidden />
                In den Papierkorb
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      {/* Übernehmen */}
      <Dialog open={dialog === 'convert'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Anfrage als Kundschaft erfassen</DialogTitle>
            <DialogDescription>
              Name, Kontaktangaben und Adresse werden übernommen, die bisherigen Aktivitäten wandern
              in die Kundenakte. Existiert bereits eine Kundschaft mit derselben E-Mail-Adresse,
              wird verknüpft statt ein zweiter Datensatz angelegt. Die Anfrage gilt danach als
              gewonnen.
            </DialogDescription>
          </DialogHeader>

          {error ? <Alert variant="destructive">{error}</Alert> : null}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Abbrechen
            </Button>
            <Button
              loading={pending === 'convert'}
              onClick={() =>
                run(
                  'convert',
                  async () => {
                    const customer = await api.post<{ id: string; number: string }>(
                      `/api/leads/${leadId}/convert`,
                    );
                    router.push(`/admin/kunden/${customer.id}`);
                  },
                  'Kundschaft erfasst.',
                )
              }
            >
              <UserPlus aria-hidden />
              Übernehmen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Verloren */}
      <Dialog open={dialog === 'lost'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Anfrage als verloren markieren</DialogTitle>
            <DialogDescription>
              Der Grund erscheint in der Trichterauswertung. Er ist die einzige Angabe, aus der sich
              ablesen lässt, woran Anfragen scheitern.
            </DialogDescription>
          </DialogHeader>

          {error ? <Alert variant="destructive">{error}</Alert> : null}

          <div className="space-y-2">
            <Label htmlFor="lost-reason" required>
              Grund
            </Label>
            <Textarea
              id="lost-reason"
              value={lostReason}
              onChange={(event) => setLostReason(event.target.value)}
              rows={3}
              placeholder="z. B. Preis zu hoch, Mitbewerb war schneller, Termin nicht möglich."
            />
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Abbrechen
            </Button>
            <Button
              variant="destructive"
              disabled={lostReason.trim().length < 3}
              loading={pending === 'lost'}
              onClick={() =>
                run(
                  'lost',
                  () =>
                    api.patch(`/api/leads/${leadId}`, {
                      status: 'LOST',
                      lostReason: lostReason.trim(),
                    }),
                  'Anfrage als verloren markiert.',
                )
              }
            >
              Als verloren markieren
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Löschen */}
      <Dialog open={dialog === 'delete'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Anfrage in den Papierkorb legen?</DialogTitle>
            <DialogDescription>
              Die Anfrage verschwindet aus Liste und Trichter, bleibt aber wiederherstellbar. Für
              eine Anfrage, aus der nichts geworden ist, ist &bdquo;verloren&ldquo; die richtige
              Wahl — sie bleibt dann in der Auswertung.
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
                    await api.delete(`/api/leads/${leadId}`);
                    router.push('/admin/leads');
                  },
                  'Anfrage in den Papierkorb gelegt.',
                )
              }
            >
              <Trash2 aria-hidden />
              In den Papierkorb
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
