'use client';

import * as React from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Maximize2,
  Minimize2,
  Minus,
  MoveHorizontal,
  Plus,
  Printer,
  Square,
} from 'lucide-react';

import 'react-pdf/dist/Page/TextLayer.css';
import 'react-pdf/dist/Page/AnnotationLayer.css';

import { cn } from '@/lib/utils';
import {
  clampPage,
  fitPageScale,
  fitWidthScale,
  zoomIn,
  zoomOut,
  zoomPercent,
} from '@/lib/pdf/viewer-math';
import { Button } from '@/components/ui/button';

/**
 * Der PDF-Viewer — eine Komponente für jede Stelle, an der ein PDF gezeigt
 * wird.
 *
 * **Was sie weiss und was nicht.** Sie bekommt eine Adresse, die der Server
 * bereits autorisiert hat, und lädt von dort. Ob dahinter eine Rechnung, eine
 * Offerte, eine Dokumentfassung oder ein öffentlicher Link mit Capability
 * steckt, spielt hier keine Rolle — und darf es nicht: Die Entscheidung,
 * wer ein PDF sehen darf, fällt am Endpunkt, nie im Browser. `canDownload`
 * und `canPrint` blenden Schaltflächen aus; sie sind Bedienung, keine
 * Sperre. Wer die Bytes hat, kann sie kopieren, und ein Viewer, der etwas
 * anderes verspräche, löge.
 *
 * **Warum die Bytes selbst geladen werden** statt PDF.js die Adresse zu
 * geben: PDF.js holt ohne Cookies, und die Endpunkte hier verlangen eine
 * Sitzung. Vor allem aber lässt sich erst so unterscheiden, *warum* etwas
 * nicht angezeigt wird — 403 ist etwas anderes als 404, und beides ist
 * etwas anderes als eine Datei, die PDF.js nicht lesen kann. Die Meldung
 * dazu soll der Person weiterhelfen, nicht dem Entwickler.
 *
 * **Worker und Hilfsdateien kommen aus dem eigenen Ursprung**
 * (`/pdfjs/<Version>/…`, siehe `scripts/copy-pdfjs-assets.ts`). Kein CDN:
 * Die Version muss exakt zur installierten passen, die CSP bleibt bei
 * `'self'`, und kein Dritter erfährt, welche Dokumente hier angesehen
 * werden.
 *
 * **Was PDF.js hier nicht tut.** `enableScripting: false` — in ein PDF
 * eingebettetes JavaScript wird nicht ausgeführt; das ist die
 * PDF.js-Vorgabe, hier ausdrücklich gesetzt, damit sie niemand versehentlich
 * mit einer Option kippt. `isEvalSupported: false` — auch für
 * PostScript-Funktionen in Schriftprogrammen kein `eval`. Verknüpfungen aus
 * dem Dokument öffnen in einem neuen Fenster mit
 * `noopener noreferrer nofollow`; es gibt keine automatische Navigation und
 * keine Launch-Actions, weil PDF.js sie nicht umsetzt.
 *
 * Eine gültige Signatur (Gate 2) heisst nicht, dass PDF.js die Datei lesen
 * kann. Was hier scheitert, wird als beschädigt gemeldet — nicht als
 * unbedenklich durchgereicht, nur weil `%PDF-` am Anfang stand.
 */

pdfjs.GlobalWorkerOptions.workerSrc = `/pdfjs/${pdfjs.version}/pdf.worker.min.mjs`;

const PDFJS_OPTIONS = {
  cMapUrl: `/pdfjs/${pdfjs.version}/cmaps/`,
  wasmUrl: `/pdfjs/${pdfjs.version}/wasm/`,
  standardFontDataUrl: `/pdfjs/${pdfjs.version}/standard_fonts/`,
  enableScripting: false,
  isEvalSupported: false,
} as const;

/**
 * Gerätepixel je CSS-Pixel, gedeckelt. Ein 3×-Bildschirm bei 200 % Zoom
 * ergäbe sonst ein Canvas mit über 5000 Pixeln Breite je A4-Seite — und
 * davon eins je Seite im Speicher.
 */
const MAX_PIXEL_RATIO = 2;

export type PdfFehler = 'zugriff' | 'nichtGefunden' | 'netzwerk' | 'beschaedigt' | 'leer' | 'viewer';

const FEHLERTEXT: Record<PdfFehler, { titel: string; text: string }> = {
  zugriff: {
    titel: 'Kein Zugriff',
    text: 'Für dieses Dokument fehlt die Berechtigung, oder die Sitzung ist abgelaufen.',
  },
  nichtGefunden: {
    titel: 'Dokument nicht gefunden',
    text: 'Das Dokument gibt es nicht mehr, oder der Link ist nicht mehr gültig.',
  },
  netzwerk: {
    titel: 'Verbindung unterbrochen',
    text: 'Das Dokument konnte nicht geladen werden. Bitte die Verbindung prüfen und erneut versuchen.',
  },
  beschaedigt: {
    titel: 'Datei nicht lesbar',
    text: 'Diese Datei lässt sich nicht als PDF öffnen. Sie ist beschädigt oder kein gültiges PDF.',
  },
  leer: {
    titel: 'Leeres Dokument',
    text: 'Das PDF enthält keine Seiten.',
  },
  viewer: {
    titel: 'Anzeige nicht möglich',
    text: 'Der Viewer konnte nicht gestartet werden. Bitte die Seite neu laden oder das PDF herunterladen.',
  },
};

export interface PdfViewerProps {
  /** Die bereits autorisierte Adresse, von der die Bytes kommen. */
  source: string;
  /** Anzeigename — auch der Dateiname beim Herunterladen. */
  fileName: string;
  /** Adresse für die Schaltfläche „Herunterladen"; Vorgabe ist `source`. */
  downloadUrl?: string;
  canDownload?: boolean;
  canPrint?: boolean;
  /** Anfangsdarstellung; „Breite" ist am Telefon die einzig brauchbare. */
  initialFit?: 'width' | 'page';
  className?: string;
  /** Höhe des Anzeigebereichs; Vorgabe ist ein Sichtfenster-Anteil. */
  height?: string;
}

type FitMode = 'width' | 'page' | 'manual';

interface Ladezustand {
  status: 'laden' | 'bereit' | 'fehler';
  fehler: PdfFehler | null;
  /** Nur gesetzt, wenn der Server die Grösse nennt — sonst gibt es keinen Prozentwert. */
  fortschritt: number | null;
}

function fehlerAusStatus(status: number): PdfFehler {
  if (status === 401 || status === 403) return 'zugriff';
  if (status === 404 || status === 410) return 'nichtGefunden';
  return 'netzwerk';
}

export function PdfViewerInner({
  source,
  fileName,
  downloadUrl,
  canDownload = true,
  canPrint = true,
  initialFit = 'width',
  className,
  height = 'min(75vh, 900px)',
}: PdfViewerProps) {
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const druckRahmen = React.useRef<HTMLIFrameElement | null>(null);

  // `Uint8Array<ArrayBuffer>` statt `Uint8Array`: Nur so nimmt `Blob` den
  // Puffer beim Drucken an — ein geteilter Speicher (`SharedArrayBuffer`)
  // kommt hier nie vor, aber der Typ muss das wissen.
  const [bytes, setBytes] = React.useState<Uint8Array<ArrayBuffer> | null>(null);
  const [lade, setLade] = React.useState<Ladezustand>({ status: 'laden', fehler: null, fortschritt: null });
  const [numPages, setNumPages] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [pageInput, setPageInput] = React.useState('1');
  const [zoom, setZoom] = React.useState(1);
  const [fitMode, setFitMode] = React.useState<FitMode>(initialFit);
  const [pageDims, setPageDims] = React.useState<{ w: number; h: number } | null>(null);
  const [containerSize, setContainerSize] = React.useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [fullscreen, setFullscreen] = React.useState(false);
  const [versuch, setVersuch] = React.useState(0);

  // -------------------------------------------------------------------------
  //  Laden
  // -------------------------------------------------------------------------

  React.useEffect(() => {
    const controller = new AbortController();
    let aktiv = true;

    setBytes(null);
    setNumPages(0);
    setPage(1);
    setPageInput('1');
    setPageDims(null);
    setLade({ status: 'laden', fehler: null, fortschritt: null });

    (async () => {
      try {
        const antwort = await fetch(source, {
          credentials: 'same-origin',
          signal: controller.signal,
          headers: { Accept: 'application/pdf' },
        });

        if (!antwort.ok) {
          if (aktiv) setLade({ status: 'fehler', fehler: fehlerAusStatus(antwort.status), fortschritt: null });
          return;
        }

        const typ = antwort.headers.get('content-type') ?? '';
        if (!typ.toLowerCase().startsWith('application/pdf')) {
          // Eine HTML-Anmeldeseite oder eine JSON-Fehlerhülle ist kein PDF —
          // und PDF.js würde daraus nur eine kryptische Meldung machen.
          if (aktiv) setLade({ status: 'fehler', fehler: 'beschaedigt', fortschritt: null });
          return;
        }

        const laenge = Number(antwort.headers.get('content-length') ?? '0');
        const leser = antwort.body?.getReader();

        if (!leser) {
          const puffer = new Uint8Array(await antwort.arrayBuffer());
          if (aktiv) {
            setBytes(puffer);
          }
          return;
        }

        const teile: Uint8Array[] = [];
        let erhalten = 0;
        for (;;) {
          const { done, value } = await leser.read();
          if (done) break;
          if (value) {
            teile.push(value);
            erhalten += value.byteLength;
            // Nur echte Prozentwerte: Ohne bekannte Gesamtlänge gibt es keinen.
            if (aktiv && laenge > 0) {
              setLade((l) => ({ ...l, fortschritt: Math.min(99, Math.round((erhalten / laenge) * 100)) }));
            }
          }
        }

        const gesamt = new Uint8Array(erhalten);
        let offset = 0;
        for (const teil of teile) {
          gesamt.set(teil, offset);
          offset += teil.byteLength;
        }

        if (aktiv) setBytes(gesamt);
      } catch (error) {
        if (!aktiv || (error instanceof DOMException && error.name === 'AbortError')) return;
        setLade({ status: 'fehler', fehler: 'netzwerk', fortschritt: null });
      }
    })();

    return () => {
      aktiv = false;
      controller.abort();
    };
  }, [source, versuch]);

  /**
   * Memoisiert, weil `Document` das Objekt per Referenz vergleicht: Ein neues
   * Objekt bei jedem Rendern hiesse, PDF.js parst das Dokument bei jedem
   * Tastendruck neu.
   */
  const file = React.useMemo(() => (bytes ? { data: bytes } : null), [bytes]);

  // -------------------------------------------------------------------------
  //  Grösse des Anzeigebereichs
  // -------------------------------------------------------------------------

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    const beobachter = new ResizeObserver((eintraege) => {
      const rect = eintraege[0]?.contentRect;
      if (!rect) return;
      // Nur setzen, wenn sich etwas geändert hat — sonst ein Rendern je Frame.
      setContainerSize((alt) =>
        Math.abs(alt.w - rect.width) < 1 && Math.abs(alt.h - rect.height) < 1
          ? alt
          : { w: rect.width, h: rect.height },
      );
    });
    beobachter.observe(el);
    return () => beobachter.disconnect();
  }, []);

  /**
   * Anpassen, sobald Seitenmasse und Containergrösse bekannt sind.
   *
   * Kein Zyklus: Der Massstab ändert die Canvasgrösse, nicht die des
   * Scrollcontainers — der ResizeObserver hängt am Container. Und gesetzt
   * wird nur bei tatsächlicher Abweichung.
   */
  React.useEffect(() => {
    if (fitMode === 'manual' || !pageDims) return;
    const masse = {
      containerWidth: containerSize.w,
      containerHeight: containerSize.h,
      pageWidth: pageDims.w,
      pageHeight: pageDims.h,
    };
    const ziel = fitMode === 'width' ? fitWidthScale(masse) : fitPageScale(masse);
    if (ziel === null) return;
    setZoom((alt) => (Math.abs(alt - ziel) < 0.001 ? alt : ziel));
  }, [fitMode, pageDims, containerSize]);

  // -------------------------------------------------------------------------
  //  Vollbild
  // -------------------------------------------------------------------------

  React.useEffect(() => {
    const handler = () => setFullscreen(document.fullscreenElement === wrapperRef.current);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const vollbildUmschalten = React.useCallback(async () => {
    const el = wrapperRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement === el) await document.exitFullscreen();
      else await el.requestFullscreen();
    } catch {
      // Nicht jeder Browser erlaubt es (iOS Safari), und ohne Vollbild ist
      // der Viewer trotzdem vollständig bedienbar.
    }
  }, []);

  // -------------------------------------------------------------------------
  //  Drucken
  // -------------------------------------------------------------------------

  React.useEffect(
    () => () => {
      // Aufräumen beim Verlassen: Objekt-URL freigeben, Rahmen entfernen.
      const rahmen = druckRahmen.current;
      if (rahmen) {
        if (rahmen.src.startsWith('blob:')) URL.revokeObjectURL(rahmen.src);
        rahmen.remove();
        druckRahmen.current = null;
      }
    },
    [],
  );

  const drucken = React.useCallback(() => {
    if (!bytes) return;
    /**
     * Die bereits geladenen Bytes drucken, nicht die Adresse noch einmal
     * abrufen: Das PDF liegt im Speicher, ein zweiter Abruf wäre ein
     * zweiter Serverzugriff für nichts. Ein versteckter Rahmen bekommt eine
     * Objekt-URL und druckt sich selbst; die URL wird danach freigegeben.
     */
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);

    const alt = druckRahmen.current;
    if (alt) {
      if (alt.src.startsWith('blob:')) URL.revokeObjectURL(alt.src);
      alt.remove();
    }

    const rahmen = document.createElement('iframe');
    rahmen.setAttribute('aria-hidden', 'true');
    rahmen.tabIndex = -1;
    rahmen.style.position = 'fixed';
    rahmen.style.right = '0';
    rahmen.style.bottom = '0';
    rahmen.style.width = '0';
    rahmen.style.height = '0';
    rahmen.style.border = '0';
    rahmen.src = url;
    rahmen.onload = () => {
      try {
        rahmen.contentWindow?.focus();
        rahmen.contentWindow?.print();
      } catch {
        // Dann bleibt der Weg über „Herunterladen" und den eigenen Viewer.
      }
    };
    document.body.appendChild(rahmen);
    druckRahmen.current = rahmen;
  }, [bytes]);

  // -------------------------------------------------------------------------
  //  Navigation
  // -------------------------------------------------------------------------

  const gehe = React.useCallback(
    (n: number) => {
      setPage((alt) => {
        const neu = clampPage(n, numPages, alt);
        setPageInput(String(neu));
        return neu;
      });
      scrollRef.current?.scrollTo({ top: 0 });
    },
    [numPages],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Eingabefelder behalten ihre Tasten.
    if ((event.target as HTMLElement).tagName === 'INPUT') return;
    switch (event.key) {
      case 'ArrowLeft':
      case 'PageUp':
        event.preventDefault();
        gehe(page - 1);
        break;
      case 'ArrowRight':
      case 'PageDown':
        event.preventDefault();
        gehe(page + 1);
        break;
      case 'Home':
        event.preventDefault();
        gehe(1);
        break;
      case 'End':
        event.preventDefault();
        gehe(numPages);
        break;
      case '+':
      case '=':
        event.preventDefault();
        setFitMode('manual');
        setZoom((z) => zoomIn(z));
        break;
      case '-':
        event.preventDefault();
        setFitMode('manual');
        setZoom((z) => zoomOut(z));
        break;
      default:
    }
  };

  const seiteEingeben = (event: React.FormEvent) => {
    event.preventDefault();
    const n = Number.parseInt(pageInput, 10);
    if (Number.isInteger(n)) gehe(n);
    else setPageInput(String(page));
  };

  const bereit = lade.status === 'bereit' && numPages > 0;
  const fehler = lade.status === 'fehler' ? lade.fehler : null;

  return (
    <div
      ref={wrapperRef}
      role="region"
      aria-label={`PDF-Ansicht: ${fileName}`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={cn(
        'flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-soft outline-none',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        fullscreen && 'h-screen rounded-none border-0',
        className,
      )}
      style={fullscreen ? undefined : { height }}
      data-pdf-viewer
    >
      {/* Werkzeugleiste */}
      <div
        className="flex flex-wrap items-center gap-1.5 border-b border-border bg-surface px-2 py-1.5"
        role="toolbar"
        aria-label="PDF-Werkzeuge"
      >
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Vorherige Seite"
            disabled={!bereit || page <= 1}
            onClick={() => gehe(page - 1)}
          >
            <ChevronLeft aria-hidden />
          </Button>
          <form onSubmit={seiteEingeben} className="flex items-center gap-1 text-meta tabular-nums">
            <label className="sr-only" htmlFor="pdf-seite">
              Seite
            </label>
            <input
              id="pdf-seite"
              type="number"
              inputMode="numeric"
              min={1}
              max={Math.max(1, numPages)}
              value={pageInput}
              disabled={!bereit}
              onChange={(e) => setPageInput(e.target.value)}
              onBlur={seiteEingeben}
              className="h-8 w-12 rounded-md border border-border bg-background px-1.5 text-center text-meta tabular-nums"
              aria-describedby="pdf-seiten-total"
            />
            <span id="pdf-seiten-total" className="text-muted-foreground">
              / {bereit ? numPages : '–'}
            </span>
          </form>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Nächste Seite"
            disabled={!bereit || page >= numPages}
            onClick={() => gehe(page + 1)}
          >
            <ChevronRight aria-hidden />
          </Button>
        </div>

        <span className="mx-1 hidden h-6 w-px bg-border sm:block" aria-hidden />

        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Verkleinern"
            disabled={!bereit}
            onClick={() => {
              setFitMode('manual');
              setZoom((z) => zoomOut(z));
            }}
          >
            <Minus aria-hidden />
          </Button>
          <button
            type="button"
            className="h-8 min-w-[3.5rem] rounded-md px-1.5 text-meta tabular-nums text-foreground hover:bg-muted"
            aria-label={`Zoom ${zoomPercent(zoom)} Prozent — auf 100 Prozent setzen`}
            disabled={!bereit}
            onClick={() => {
              setFitMode('manual');
              setZoom(1);
            }}
          >
            {zoomPercent(zoom)}%
          </button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Vergrössern"
            disabled={!bereit}
            onClick={() => {
              setFitMode('manual');
              setZoom((z) => zoomIn(z));
            }}
          >
            <Plus aria-hidden />
          </Button>
          <Button
            type="button"
            variant={fitMode === 'width' ? 'secondary' : 'ghost'}
            size="sm"
            aria-label="An Breite anpassen"
            aria-pressed={fitMode === 'width'}
            disabled={!bereit}
            onClick={() => setFitMode('width')}
          >
            <MoveHorizontal aria-hidden />
            <span className="hidden sm:inline">Breite</span>
          </Button>
          <Button
            type="button"
            variant={fitMode === 'page' ? 'secondary' : 'ghost'}
            size="sm"
            aria-label="Ganze Seite anzeigen"
            aria-pressed={fitMode === 'page'}
            disabled={!bereit}
            onClick={() => setFitMode('page')}
          >
            <Square aria-hidden />
            <span className="hidden sm:inline">Seite</span>
          </Button>
        </div>

        <div className="ml-auto flex items-center gap-1">
          {canDownload ? (
            <Button asChild variant="ghost" size="sm">
              <a href={downloadUrl ?? source} download={fileName} aria-label="PDF herunterladen">
                <Download aria-hidden />
                <span className="hidden sm:inline">Herunterladen</span>
              </a>
            </Button>
          ) : null}
          {canPrint ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="PDF drucken"
              disabled={!bereit}
              onClick={drucken}
            >
              <Printer aria-hidden />
              <span className="hidden sm:inline">Drucken</span>
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={fullscreen ? 'Vollbild beenden' : 'Vollbild'}
            aria-pressed={fullscreen}
            onClick={vollbildUmschalten}
          >
            {fullscreen ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
          </Button>
        </div>
      </div>

      {/* Für Vorleseprogramme: Zustand in Worten, ohne die Leiste zu wiederholen. */}
      <p className="sr-only" aria-live="polite">
        {fehler
          ? `${FEHLERTEXT[fehler].titel}. ${FEHLERTEXT[fehler].text}`
          : bereit
            ? `Seite ${page} von ${numPages}, Zoom ${zoomPercent(zoom)} Prozent.`
            : 'Das Dokument wird geladen.'}
      </p>

      {/* Anzeigebereich */}
      <div
        ref={scrollRef}
        className="relative flex-1 overflow-auto bg-muted/60"
        style={{ touchAction: 'pan-x pan-y pinch-zoom' }}
      >
        {fehler ? (
          <div className="flex h-full items-center justify-center p-6" role="alert">
            <div className="max-w-sm space-y-3 text-center">
              <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-warning/12 text-warning">
                <AlertTriangle className="size-6" aria-hidden />
              </div>
              <p className="font-display text-base font-semibold">{FEHLERTEXT[fehler].titel}</p>
              <p className="text-sm leading-relaxed text-muted-foreground">{FEHLERTEXT[fehler].text}</p>
              {fehler === 'netzwerk' || fehler === 'viewer' ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setVersuch((v) => v + 1)}>
                  Erneut versuchen
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {!fehler && !file ? (
          <div className="flex h-full items-center justify-center p-6" role="status">
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <Loader2 className="size-5 animate-spin" aria-hidden />
              <span>
                Dokument wird geladen
                {lade.fortschritt !== null ? ` · ${lade.fortschritt} %` : '…'}
              </span>
            </div>
          </div>
        ) : null}

        {!fehler && file ? (
          <Document
            file={file}
            options={PDFJS_OPTIONS}
            suspense={false}
            externalLinkTarget="_blank"
            externalLinkRel="noopener noreferrer nofollow"
            loading={
              <div className="flex h-full items-center justify-center p-6" role="status">
                <div className="flex items-center gap-3 text-sm text-muted-foreground">
                  <Loader2 className="size-5 animate-spin" aria-hidden />
                  <span>Dokument wird geöffnet…</span>
                </div>
              </div>
            }
            error={null}
            noData={null}
            onLoadSuccess={(pdf) => {
              if (pdf.numPages < 1) {
                setLade({ status: 'fehler', fehler: 'leer', fortschritt: null });
                return;
              }
              setNumPages(pdf.numPages);
              setLade({ status: 'bereit', fehler: null, fortschritt: null });
            }}
            onLoadError={() => setLade({ status: 'fehler', fehler: 'beschaedigt', fortschritt: null })}
            onSourceError={() => setLade({ status: 'fehler', fehler: 'viewer', fortschritt: null })}
            className="flex min-h-full justify-center p-4"
          >
            {bereit ? (
              <Page
                pageNumber={page}
                scale={zoom}
                devicePixelRatio={Math.min(
                  MAX_PIXEL_RATIO,
                  typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
                )}
                renderTextLayer
                renderAnnotationLayer
                onLoadSuccess={(p) => {
                  setPageDims((alt) =>
                    alt && alt.w === p.originalWidth && alt.h === p.originalHeight
                      ? alt
                      : { w: p.originalWidth, h: p.originalHeight },
                  );
                }}
                onRenderError={() => setLade({ status: 'fehler', fehler: 'beschaedigt', fortschritt: null })}
                className="shadow-card"
                loading={
                  <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground" role="status">
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    Seite {page} wird gerendert…
                  </div>
                }
              />
            ) : null}
          </Document>
        ) : null}
      </div>
    </div>
  );
}
