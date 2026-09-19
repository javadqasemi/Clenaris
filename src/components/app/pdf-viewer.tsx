'use client';

import dynamic from 'next/dynamic';
import { Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { PdfViewerProps } from './pdf-viewer-inner';

export type { PdfViewerProps } from './pdf-viewer-inner';

/**
 * Die Server-Grenze des PDF-Viewers.
 *
 * PDF.js braucht `DOMMatrix`, `Worker` und ein Canvas — nichts davon gibt
 * es beim Rendern auf dem Server. Der eigentliche Viewer wird deshalb erst
 * im Browser geladen (`ssr: false`); Seiten können `PdfViewer` trotzdem
 * wie jede andere Komponente einsetzen und bekommen für die erste
 * Auslieferung einen Platzhalter in der richtigen Grösse, damit das Layout
 * nicht springt, wenn der Viewer nachkommt.
 *
 * Der zweite Grund ist das Bündel: PDF.js wiegt mehrere hundert Kilobyte.
 * Wer eine Rechnungsliste öffnet, soll es nicht mitladen — nur wer ein PDF
 * ansieht.
 */
const PdfViewerInner = dynamic(
  () => import('./pdf-viewer-inner').then((m) => m.PdfViewerInner),
  {
    ssr: false,
    loading: () => (
      <div
        className="flex items-center justify-center rounded-2xl border border-border bg-card shadow-soft"
        style={{ height: 'min(75vh, 900px)' }}
        role="status"
        aria-label="PDF-Ansicht wird vorbereitet"
      >
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="size-5 animate-spin" aria-hidden />
          <span>Ansicht wird vorbereitet…</span>
        </div>
      </div>
    ),
  },
);

export function PdfViewer(props: PdfViewerProps) {
  return (
    <div className={cn('w-full min-w-0', props.className)} data-pdf-viewer-mount>
      <PdfViewerInner {...props} className={undefined} />
    </div>
  );
}
