'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronUp, Eye, EyeOff, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { CTA_SLOTS, CTA_SLOT_HINTS, CTA_SLOT_LABELS } from '@/lib/validation/cta';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/overlays';
import { EmptyState, ListCard } from '@/components/app/page-parts';
import { CtaButton, type CtaData } from '@/components/marketing/cta-button';

import { CtaForm, type CtaRow } from './cta-form';

/**
 * Verwaltung der Handlungsaufrufe.
 *
 * Gestaltungsentscheide:
 *
 *  • **Gruppiert nach Platz, nicht als eine lange Liste.** Die Frage lautet
 *    fast immer „was steht in der Kopfzeile", nicht „welche Aufrufe gibt es".
 *    Die Gruppe zeigt ausserdem, wenn ein Platz leer ist — das ist die
 *    Information, die sonst niemand findet.
 *
 *  • **Jede Zeile zeigt die echte Schaltfläche.** Eine Tabelle aus Text,
 *    Farbwert und Symbolnamen zwingt zum Nachdenken; die gerenderte
 *    Schaltfläche beantwortet die Frage sofort.
 *
 *  • **Ein- und Ausschalten ist ein Klick, kein Formular.** Es ist die
 *    häufigste Handlung. Alles andere steckt im Seitenpanel.
 */

export interface CtaWorkspaceProps {
  ctas: CtaRow[];
  trashed: CtaRow[];
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canPublish: boolean;
}

export function CtaWorkspace({
  ctas,
  trashed,
  canCreate,
  canUpdate,
  canDelete,
  canPublish,
}: CtaWorkspaceProps) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<{ row?: CtaRow } | null>(null);
  const [deleting, setDeleting] = React.useState<CtaRow | null>(null);
  const [purging, setPurging] = React.useState<CtaRow | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const act = async (id: string, run: () => Promise<unknown>, success: string) => {
    setBusy(id);
    try {
      await run();
      toast.success(success);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Die Aktion ist fehlgeschlagen.');
    } finally {
      setBusy(null);
    }
  };

  const toggle = (row: CtaRow) =>
    act(
      row.id,
      () => api.post(`/api/cta/${row.id}/publish`, { active: !row.active }),
      row.active ? `„${row.label}" ist nicht mehr sichtbar.` : `„${row.label}" ist jetzt auf der Website.`,
    );

  const move = async (slot: string, ids: string[], index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    const next = [...ids];
    [next[index], next[target]] = [next[target], next[index]];
    await act(ids[index], () => api.post('/api/cta/reorder', { slot, ids: next }), 'Reihenfolge gespeichert.');
  };

  const restore = (row: CtaRow) =>
    act(
      row.id,
      () => api.post(`/api/cta/${row.id}/restore`),
      `„${row.label}" wiederhergestellt — noch nicht sichtbar.`,
    );

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {ctas.length} {ctas.length === 1 ? 'Handlungsaufruf' : 'Handlungsaufrufe'} ·{' '}
          {ctas.filter((c) => c.active).length} sichtbar
        </p>
        {canCreate ? (
          <Button onClick={() => setEditing({})}>
            <Plus aria-hidden />
            Handlungsaufruf
          </Button>
        ) : null}
      </div>

      {ctas.length === 0 ? (
        <EmptyState
          title="Noch kein Handlungsaufruf"
          description="Ohne Aufruf zeigt die Website keine Schaltfläche zum Buchen, Offerieren oder Anrufen — Besucherinnen und Besucher finden dann keinen nächsten Schritt."
        />
      ) : (
        <div className="space-y-6">
          {CTA_SLOTS.map((slot) => {
            const rows = ctas.filter((cta) => cta.slot === slot);
            const ids = rows.map((row) => row.id);

            return (
              <ListCard
                key={slot}
                title={`${CTA_SLOT_LABELS[slot]} (${rows.length})`}
                footer={
                  <p className="text-meta leading-relaxed text-muted-foreground">
                    {CTA_SLOT_HINTS[slot]}
                  </p>
                }
              >
                {rows.length === 0 ? (
                  <p className="px-5 py-6 text-sm text-muted-foreground">
                    An diesem Platz steht nichts.
                  </p>
                ) : (
                  <ul className="divide-y divide-border">
                    {rows.map((row, index) => (
                      <li key={row.id} className="p-5">
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div className="flex min-w-0 flex-wrap items-center gap-3">
                            <div className={cn(!row.active && 'opacity-45 grayscale')}>
                              <CtaButton cta={toPreview(row)} size="sm" />
                            </div>

                            <div className="min-w-0 space-y-1">
                              <p className="flex flex-wrap items-center gap-2 text-sm">
                                <span className="font-mono text-xs text-muted-foreground">
                                  {row.key}
                                </span>
                                <StatusBadge row={row} />
                              </p>
                              <p className="text-meta text-muted-foreground">
                                <span className="font-mono">{row.href}</span>
                                {row.newTab ? ' · neuer Tab' : ''}
                                {' · '}
                                {row.pages.length === 0
                                  ? 'auf allen Seiten'
                                  : row.pages.join(', ')}
                              </p>
                              {row.publishFrom || row.publishUntil ? (
                                <p className="text-meta text-muted-foreground">
                                  {describeSchedule(row)}
                                </p>
                              ) : null}
                              {row.note ? (
                                <p className="text-meta italic text-muted-foreground">{row.note}</p>
                              ) : null}
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-0.5">
                            {canUpdate && rows.length > 1 ? (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={`${row.label} nach oben`}
                                  disabled={index === 0 || busy !== null}
                                  onClick={() => move(slot, ids, index, -1)}
                                >
                                  <ChevronUp aria-hidden />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={`${row.label} nach unten`}
                                  disabled={index === rows.length - 1 || busy !== null}
                                  onClick={() => move(slot, ids, index, 1)}
                                >
                                  <ChevronDown aria-hidden />
                                </Button>
                              </>
                            ) : null}

                            {canPublish ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                loading={busy === row.id}
                                onClick={() => toggle(row)}
                              >
                                {row.active ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                                {row.active ? 'Ausblenden' : 'Anzeigen'}
                              </Button>
                            ) : null}

                            {canUpdate ? (
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`${row.label} bearbeiten`}
                                onClick={() => setEditing({ row })}
                              >
                                <Pencil aria-hidden />
                              </Button>
                            ) : null}

                            {canDelete ? (
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`${row.label} löschen`}
                                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                onClick={() => setDeleting(row)}
                              >
                                <Trash2 aria-hidden />
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </ListCard>
            );
          })}
        </div>
      )}

      {/* --- Papierkorb ---------------------------------------------------- */}
      {trashed.length > 0 ? (
        <ListCard title={`Papierkorb (${trashed.length})`}>
          <Alert variant="info" className="mx-5 mt-5">
            Gelöschte Aufrufe bleiben hier, bis sie endgültig entfernt werden. Wiederhergestellte
            kommen abgeschaltet zurück — Sie sehen sie erst nach, bevor sie wieder auf der Website
            stehen.
          </Alert>
          <ul className="divide-y divide-border">
            {trashed.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 p-5">
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium">{row.label}</p>
                  <p className="text-meta text-muted-foreground">
                    <span className="font-mono">{row.key}</span> ·{' '}
                    {CTA_SLOT_LABELS[row.slot as (typeof CTA_SLOTS)[number]] ?? row.slot}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {canUpdate ? (
                    <Button variant="outline" size="sm" loading={busy === row.id} onClick={() => restore(row)}>
                      <RotateCcw aria-hidden />
                      Wiederherstellen
                    </Button>
                  ) : null}
                  {canDelete ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10"
                      onClick={() => setPurging(row)}
                    >
                      Endgültig löschen
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </ListCard>
      ) : null}

      <CtaForm
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        cta={editing?.row}
        canPublish={canPublish}
      />

      <ConfirmDialog
        row={deleting}
        onClose={() => setDeleting(null)}
        title="In den Papierkorb legen?"
        description="Die Schaltfläche verschwindet sofort von der Website. Text, Farbe, Ziel und Zeitplan bleiben erhalten und lassen sich wiederherstellen."
        confirmLabel="In den Papierkorb"
        endpoint={(row) => `/api/cta/${row.id}`}
      />

      <ConfirmDialog
        row={purging}
        onClose={() => setPurging(null)}
        title="Endgültig löschen?"
        description="Der Eintrag wird unwiderruflich entfernt. Es gibt danach keine Wiederherstellung."
        confirmLabel="Unwiderruflich löschen"
        endpoint={(row) => `/api/cta/${row.id}?endgueltig=1`}
      />
    </>
  );
}

function toPreview(row: CtaRow): CtaData {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    // In der Verwaltung soll ein Klick auf die Vorschau nicht navigieren.
    href: '#',
    newTab: false,
    icon: row.icon,
    slot: row.slot,
    style: row.style,
    bgColor: row.bgColor,
    fgColor: row.fgColor,
  };
}

function StatusBadge({ row }: { row: CtaRow }) {
  if (!row.active) {
    return (
      <Badge variant="neutral" size="sm">
        Nicht sichtbar
      </Badge>
    );
  }

  const now = new Date();
  if (row.publishFrom && new Date(row.publishFrom) > now) {
    return (
      <Badge variant="info" size="sm">
        Geplant
      </Badge>
    );
  }
  if (row.publishUntil && new Date(row.publishUntil) < now) {
    return (
      <Badge variant="warning" size="sm">
        Abgelaufen
      </Badge>
    );
  }
  return (
    <Badge variant="success" size="sm">
      Sichtbar
    </Badge>
  );
}

function describeSchedule(row: CtaRow): string {
  const format = (iso: string) =>
    new Date(iso).toLocaleString('de-CH', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Zurich',
    });

  if (row.publishFrom && row.publishUntil) {
    return `${format(row.publishFrom)} bis ${format(row.publishUntil)}`;
  }
  if (row.publishFrom) return `ab ${format(row.publishFrom)}`;
  return `bis ${format(row.publishUntil!)}`;
}

function ConfirmDialog({
  row,
  onClose,
  title,
  description,
  confirmLabel,
  endpoint,
}: {
  row: CtaRow | null;
  onClose: () => void;
  title: string;
  description: string;
  confirmLabel: string;
  endpoint: (row: CtaRow) => string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (row) setError(null);
  }, [row]);

  const confirm = async () => {
    if (!row) return;
    setBusy(true);
    setError(null);
    try {
      await api.delete(endpoint(row));
      toast.success(`„${row.label}" entfernt.`);
      onClose();
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Löschen fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {row ? (
          <div className="rounded-xl bg-muted/50 p-4">
            <CtaButton cta={toPreview(row)} size="sm" />
          </div>
        ) : null}

        {error ? (
          <p
            role="alert"
            className="rounded-xl border border-destructive/25 bg-destructive/5 p-4 text-sm leading-relaxed text-destructive"
          >
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="destructive" onClick={confirm} loading={busy}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
