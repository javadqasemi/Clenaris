'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { FileSignature, Loader2, Plus, Send, Trash2, XCircle } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/form';
import { Alert } from '@/components/ui/primitives';
import { Badge } from '@/components/ui/badge';
import { ActionButton } from '@/components/app/action-button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/controls';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/overlays';

/**
 * Verwaltung: „Zur Unterschrift senden" und die Vorgänge eines Dokuments.
 *
 * Die Maske fragt nur, was der Server nicht wissen kann: wer, welche
 * Prüfstufe, wie lange, welcher Modus. Alles andere — Fassung, Prüfsumme,
 * Zustimmungstext, Token — bestimmt der Server. Einen Link zeigt sie nie:
 * Es gibt ihn nur in der versendeten E-Mail.
 */

export interface SignatureRequestSummary {
  id: string;
  publicId: string;
  status: string;
  artifactMode: string;
  assuranceLevel: string;
  title: string;
  createdAt: string | Date;
  sentAt: string | Date | null;
  expiresAt: string | Date;
  completedAt: string | Date | null;
  originalDocumentHash: string;
  signedArtifactHash: string | null;
  evidenceArtifactHash: string | null;
  documentVersion: { version: number } | null;
  participants: { id: string; nameSnapshot: string; emailSnapshot: string; status: string; signedAt: string | Date | null; declinedAt: string | Date | null }[];
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Entwurf',
  PENDING: 'Ausstehend',
  FINALIZING: 'Wird abgeschlossen',
  COMPLETED: 'Unterzeichnet',
  DECLINED: 'Abgelehnt',
  EXPIRED: 'Abgelaufen',
  CANCELLED: 'Abgebrochen',
};
const TEILNEHMER_LABEL: Record<string, string> = {
  PENDING: 'ausstehend',
  VIEWED: 'angesehen',
  VERIFIED: 'bestätigt',
  SIGNED: 'unterschrieben',
  DECLINED: 'abgelehnt',
};
const STUFE_LABEL: Record<string, string> = {
  LINK_ONLY: 'Link',
  LINK_PLUS_EMAIL_CODE: 'Link + E-Mail-Code',
  LINK_PLUS_SMS_CODE: 'Link + SMS-Code',
};

export function SignatureRequestPanel({
  documentId,
  currentVersion,
  isPdf,
  requests,
  canCreate,
  canCancel,
}: {
  documentId: string;
  currentVersion: number | null;
  isPdf: boolean;
  requests: SignatureRequestSummary[];
  canCreate: boolean;
  canCancel: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [teilnehmer, setTeilnehmer] = React.useState([{ name: '', email: '', phone: '' }]);
  const [stufe, setStufe] = React.useState('LINK_ONLY');
  const [modus, setModus] = React.useState('DETACHED_EVIDENCE');
  const [tage, setTage] = React.useState('14');

  const senden = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/bi/documents/${documentId}/signature-requests`, {
        assuranceLevel: stufe,
        artifactMode: modus,
        expiresInDays: Number(tage) || 14,
        participants: teilnehmer.map((t) => ({ name: t.name.trim(), email: t.email.trim(), phone: t.phone.trim() || undefined })),
        send: true,
      });
      toast.success('Zur Unterschrift versendet.');
      setOpen(false);
      setTeilnehmer([{ name: '', email: '', phone: '' }]);
      router.refresh();
    } catch (err) {
      const m = err instanceof ApiError ? err.message : 'Der Vorgang konnte nicht angelegt werden.';
      setError(m);
    } finally {
      setBusy(false);
    }
  };


  return (
    <section className="rounded-2xl border border-border bg-card shadow-soft">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div>
          <h2 className="font-display text-base font-semibold">Elektronische Unterzeichnung</h2>
          <p className="text-meta text-muted-foreground">
            {isPdf ? `Geltende Fassung ${currentVersion ?? '–'} · Vorgänge binden genau eine Fassung.` : 'Nur PDF-Fassungen können unterzeichnet werden.'}
          </p>
        </div>
        {canCreate && isPdf ? (
          <Button type="button" onClick={() => setOpen(true)}>
            <FileSignature aria-hidden /> Zur Unterschrift senden
          </Button>
        ) : null}
      </header>

      {requests.length === 0 ? (
        <p className="px-6 py-6 text-sm text-muted-foreground">Noch kein Vorgang.</p>
      ) : (
        <ul className="divide-y divide-border">
          {requests.map((r) => (
            <li key={r.id} className="space-y-2 px-6 py-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge size="sm" variant={r.status === 'COMPLETED' ? 'success' : r.status === 'PENDING' ? 'info' : r.status === 'DECLINED' ? 'destructive' : 'neutral'}>
                    {STATUS_LABEL[r.status] ?? r.status}
                  </Badge>
                  <span className="font-medium">Fassung {r.documentVersion?.version ?? '–'}</span>
                  <span className="text-muted-foreground">
                    · {STUFE_LABEL[r.assuranceLevel] ?? r.assuranceLevel} · {r.artifactMode === 'EMBEDDED_VISUAL' ? 'mit Einbettung' : 'Protokoll'}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>angelegt {formatDateTime(new Date(r.createdAt))}</span>
                  {/*
                    Erneut senden (2026-09-27): Der Endpunkt stellte neue Links
                    aus und widerrief die alten, aber keine Schaltfläche rief ihn
                    — wer die erste E-Mail verlor, musste den Vorgang abbrechen
                    und neu anlegen. Beide Handlungen fragen jetzt nach, weil
                    beide etwas Bestehendes ungültig machen.
                  */}
                  {canCreate && r.status === 'PENDING' ? (
                    <ActionButton
                      endpoint={`/api/signatures/${r.id}/send`}
                      label="Erneut senden"
                      confirmTitle="Links erneut senden?"
                      confirm="Jede Person erhält einen neuen Link; die bisherigen Links werden ungültig."
                      successMessage="Neu versendet."
                      variant="ghost"
                      size="sm"
                    >
                      <Send aria-hidden /> Erneut senden
                    </ActionButton>
                  ) : null}
                  {canCancel && (r.status === 'PENDING' || r.status === 'DRAFT') ? (
                    <ActionButton
                      endpoint={`/api/signatures/${r.id}/cancel`}
                      body={{}}
                      label="Abbrechen"
                      confirmTitle="Vorgang abbrechen?"
                      confirm="Die Links werden ungültig; bereits geleistete Unterschriften bleiben im Protokoll, der Vorgang wird nicht abgeschlossen."
                      successMessage="Vorgang abgebrochen."
                      variant="ghost"
                      size="sm"
                    >
                      <XCircle aria-hidden /> Abbrechen
                    </ActionButton>
                  ) : null}
                </div>
              </div>
              <ul className="space-y-1">
                {r.participants.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-medium">{p.nameSnapshot}</span>
                    <span className="text-muted-foreground">{p.emailSnapshot}</span>
                    <Badge size="sm" variant="outline">{TEILNEHMER_LABEL[p.status] ?? p.status}</Badge>
                    {p.signedAt ? <span className="text-muted-foreground">{formatDateTime(new Date(p.signedAt))}</span> : null}
                  </li>
                ))}
              </ul>
              {r.status === 'COMPLETED' ? (
                <p className="break-all font-mono text-2xs text-muted-foreground" title="SHA-256 Original / unterzeichnet / Protokoll">
                  A {r.originalDocumentHash.slice(0, 16)}… {r.signedArtifactHash ? `· B ${r.signedArtifactHash.slice(0, 16)}…` : ''}{' '}
                  {r.evidenceArtifactHash ? `· C ${r.evidenceArtifactHash.slice(0, 16)}…` : '· C wird erstellt'}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent size="md">
          <form onSubmit={senden} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Zur Unterschrift senden</DialogTitle>
              <DialogDescription>
                Die geltende Fassung wird gebunden. Jede Person erhält einen eigenen, befristeten Link per E-Mail.
              </DialogDescription>
            </DialogHeader>

            {teilnehmer.map((t, i) => (
              <div key={i} className="grid gap-3 rounded-xl border border-border p-3 sm:grid-cols-[1fr_1fr_auto]">
                <div className="space-y-1">
                  <Label htmlFor={`sig-name-${i}`}>Name</Label>
                  <Input id={`sig-name-${i}`} required value={t.name} onChange={(e) => setTeilnehmer((l) => l.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`sig-email-${i}`}>E-Mail</Label>
                  <Input id={`sig-email-${i}`} type="email" required value={t.email} onChange={(e) => setTeilnehmer((l) => l.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))} />
                </div>
                <div className="flex items-end">
                  {teilnehmer.length > 1 ? (
                    <Button type="button" variant="ghost" size="icon" aria-label="Person entfernen" onClick={() => setTeilnehmer((l) => l.filter((_, j) => j !== i))}>
                      <Trash2 aria-hidden />
                    </Button>
                  ) : null}
                </div>
                {stufe === 'LINK_PLUS_SMS_CODE' ? (
                  <div className="space-y-1 sm:col-span-3">
                    <Label htmlFor={`sig-phone-${i}`}>Mobilnummer (für den SMS-Code)</Label>
                    <Input id={`sig-phone-${i}`} required value={t.phone} onChange={(e) => setTeilnehmer((l) => l.map((x, j) => (j === i ? { ...x, phone: e.target.value } : x)))} />
                  </div>
                ) : null}
              </div>
            ))}
            {teilnehmer.length < 3 ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setTeilnehmer((l) => [...l, { name: '', email: '', phone: '' }])}>
                <Plus aria-hidden /> Weitere Person
              </Button>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label>Prüfstufe</Label>
                <Select value={stufe} onValueChange={setStufe}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="LINK_ONLY">Link</SelectItem>
                    <SelectItem value="LINK_PLUS_EMAIL_CODE">Link + E-Mail-Code</SelectItem>
                    <SelectItem value="LINK_PLUS_SMS_CODE">Link + SMS-Code</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Modus</Label>
                <Select value={modus} onValueChange={setModus}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="DETACHED_EVIDENCE">Protokoll, Original unverändert</SelectItem>
                    <SelectItem value="EMBEDDED_VISUAL">Sichtbare Unterschrift einbetten</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="sig-tage">Gültig (Tage)</Label>
                <Input id="sig-tage" type="number" min={1} max={90} value={tage} onChange={(e) => setTage(e.target.value)} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Einbetten ist nur bei Dokumenten sinnvoll, die Clenaris selbst erzeugt hat; ein hochgeladenes PDF mit vorhandener Signatur wird abgelehnt.
            </p>

            {error ? <Alert variant="destructive">{error}</Alert> : null}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Abbrechen</Button>
              <Button type="submit" disabled={busy}>
                {busy ? <Loader2 className="animate-spin" aria-hidden /> : <FileSignature aria-hidden />} Senden
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
