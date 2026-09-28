'use client';

import * as React from 'react';
import { AlertTriangle, Download, FileCheck2, Loader2 } from 'lucide-react';

import { api, ApiError } from '@/lib/api/client';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { PdfViewer } from '@/components/app/pdf-viewer';

interface Ergebnis {
  title: string;
  status: string;
  artifactMode: 'EMBEDDED_VISUAL' | 'DETACHED_EVIDENCE';
  completedAt: string | null;
  participant: { name: string; signedAt: string | null };
  hashes: { original: string; signed: string | null; evidence: string | null };
  available: { original: boolean; signed: boolean; evidence: boolean };
}

/** Das Ergebnis nach Abschluss — ansehen und laden, sonst nichts. */
export function ResultView({ publicId }: { publicId: string }) {
  const [e, setE] = React.useState<Ergebnis | null>(null);
  const [lade, setLade] = React.useState<'laden' | 'bereit' | 'ungueltig' | 'fehler'>('laden');

  React.useEffect(() => {
    api
      .get<Ergebnis>(`/api/public/signatures/${publicId}/result`)
      .then((r) => {
        setE(r);
        setLade('bereit');
      })
      .catch((error) => setLade(error instanceof ApiError && error.status === 404 ? 'ungueltig' : 'fehler'));
  }, [publicId]);

  if (lade === 'laden') {
    return (
      <div className="container flex min-h-[50vh] items-center justify-center" role="status">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
      </div>
    );
  }
  if (lade !== 'bereit' || !e) {
    return (
      <div className="container max-w-lg py-16 text-center">
        <AlertTriangle className="mx-auto mb-3 size-8 text-warning" aria-hidden />
        <h1 className="font-display text-lg font-semibold">Dieser Link ist nicht mehr gültig</h1>
        <p className="mt-2 text-sm text-muted-foreground">Der Ergebnislink ist abgelaufen oder wurde zurückgezogen.</p>
      </div>
    );
  }

  const basis = `/api/public/signatures/${publicId}/result`;
  const hauptdokument = e.available.signed ? 'signed' : 'original';

  return (
    <div className="container max-w-3xl space-y-8 py-10">
      <header className="space-y-2">
        <p className="flex items-center gap-2 text-meta text-success">
          <FileCheck2 className="size-4" aria-hidden /> Elektronisch unterzeichnet
        </p>
        <h1 className="font-display text-title font-bold">{e.title}</h1>
        <p className="text-sm text-muted-foreground">
          {e.participant.name}
          {e.participant.signedAt ? ` · unterzeichnet am ${formatDateTime(new Date(e.participant.signedAt))}` : ''}
        </p>
        <p className="text-sm text-muted-foreground">
          {e.artifactMode === 'EMBEDDED_VISUAL'
            ? 'Dokument mit sichtbarer Unterschrift und separates Signaturprotokoll.'
            : 'Elektronisch bestätigtes Dokument mit separatem Signaturprotokoll — das Original ist unverändert.'}
        </p>
      </header>

      <PdfViewer source={`${basis}/${hauptdokument}`} fileName={`${e.title}.pdf`} />

      <div className="flex flex-wrap gap-3">
        <Button asChild variant="outline">
          <a href={`${basis}/${hauptdokument}`} download>
            <Download aria-hidden /> {e.available.signed ? 'Unterzeichnetes Dokument' : 'Dokument'}
          </a>
        </Button>
        {e.available.evidence ? (
          <Button asChild variant="outline">
            <a href={`${basis}/evidence`} download>
              <Download aria-hidden /> Signaturprotokoll
            </a>
          </Button>
        ) : (
          <span className="self-center text-sm text-muted-foreground">Das Signaturprotokoll wird erstellt…</span>
        )}
      </div>

      <dl className="protocol-list rounded-2xl border border-border bg-card px-6 text-xs">
        <div className="py-3">
          <dt className="text-muted-foreground">SHA-256 Original</dt>
          <dd className="break-all font-mono">{e.hashes.original}</dd>
        </div>
        {e.hashes.signed ? (
          <div className="py-3">
            <dt className="text-muted-foreground">SHA-256 unterzeichnetes Dokument</dt>
            <dd className="break-all font-mono">{e.hashes.signed}</dd>
          </div>
        ) : null}
        {e.hashes.evidence ? (
          <div className="py-3">
            <dt className="text-muted-foreground">SHA-256 Signaturprotokoll</dt>
            <dd className="break-all font-mono">{e.hashes.evidence}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}
