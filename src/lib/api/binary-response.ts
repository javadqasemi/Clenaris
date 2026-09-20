/**
 * Binärdateien ausliefern — und die eine Kopfzeile, die dabei Schaden anrichtet.
 *
 * ---------------------------------------------------------------------------
 *  Der Befund, den dieses Modul behebt
 * ---------------------------------------------------------------------------
 *
 * Der PDF-Viewer aus Gate 3 lädt die Bytes **selbst** per `fetch` (die
 * Begründung steht in `pdf-viewer-inner.tsx`: nur so lassen sich 401, 403, 404
 * und „kein lesbares PDF" auseinanderhalten, und nur so reist das
 * Sitzungscookie mit). Genau dieser Abruf schlug in jedem echten Chrome und
 * Edge fehl — und nur dort.
 *
 * Gemessen am 2026-09-20 gegen dieselbe Anwendung, dieselbe Sitzung, dasselbe
 * PDF, einmal mit dem vollen Chromium und einmal mit der Headless-Shell:
 *
 * ```
 *   Content-Type: application/pdf                             → 200, 3449 Bytes
 *   Content-Type: application/pdf + Content-Disposition: inline     → 204, 0 Bytes
 *   Content-Type: application/pdf + Content-Disposition: attachment → 204, 0 Bytes
 *   Content-Type: application/octet-stream                     → 200, 3449 Bytes
 * ```
 *
 * Der volle Chromium-Bau enthält das PDF-Plugin, die Headless-Shell nicht.
 * Trifft eine Antwort auf `application/pdf` **zusammen mit** einer
 * `Content-Disposition`, reicht Chromiums Plugin-Interceptor den Datenstrom an
 * den PDF-Handler weiter und beantwortet den ursprünglichen Abruf mit einem
 * leeren **204**. Für eine Navigation ist das richtig — dort *soll* der
 * Browser die Datei übernehmen. Für ein `fetch()` ist es das Gegenteil: Der
 * Viewer bekam 0 Bytes ohne Content-Type, verwarf sie folgerichtig als
 * „kein PDF" und zeigte **„Datei nicht lesbar"**.
 *
 * Das betraf jede PDF-Anzeige des Produkts: Offerte, Rechnung,
 * Führungsdokument, Rapport, das eingefrorene Dokument der Unterzeichnung
 * (Gate 4C und 4D) und das Ergebnisprotokoll.
 *
 * **Warum es keine Prüfung gefunden hat.** Über HTTP war die Antwort immer
 * korrekt — Node kennt kein PDF-Plugin. Und die Browserreihe aus Gate 4D.1
 * fährt Playwrights Vorgabe, und die ist die Headless-Shell: derselbe blinde
 * Fleck. Ein Statuscode ist eben auch dann keine Datei, wenn ein Browser ihn
 * liefert.
 *
 * ---------------------------------------------------------------------------
 *  Die Regel
 * ---------------------------------------------------------------------------
 *
 * `Content-Disposition` ist eine Anweisung an eine **Navigation**: „öffne das
 * im Fenster" oder „lade das herunter". Für einen Abruf, der die Bytes selbst
 * verarbeitet, hat sie keine Bedeutung — sie ist dort nur schädlich. Also wird
 * sie genau denen geschickt, für die sie gedacht ist.
 *
 * Entschieden wird an `Sec-Fetch-Dest`, das der Browser selbst setzt und das
 * eine Seite nicht fälschen kann:
 *
 *  • `document`, `iframe`, `object`, `embed` → Navigation, Kopfzeile mitgeben.
 *  • `empty` (also `fetch`/XHR) → weglassen.
 *  • Kopfzeile fehlt ganz → mitgeben. Das sind Nicht-Browser (Prüfreihe,
 *    `curl`, Server-zu-Server) und ältere Browser; bei ihnen gibt es keinen
 *    Plugin-Interceptor, und der Dateiname bleibt erhalten.
 *
 * Damit verhält sich jede bestehende Verwendung unverändert: Alle
 * Herunterladen-Schaltflächen des Produkts sind `<a download="…">`, tragen
 * ihren Dateinamen also ohnehin selbst, und eine direkt aufgerufene Adresse
 * ist eine Navigation und bekommt die Kopfzeile wie bisher.
 *
 * `Vary: Sec-Fetch-Dest` gehört dazu, weil die Antwort nun von einer
 * Anfragekopfzeile abhängt — ohne das könnte ein Zwischenspeicher die Fassung
 * ohne Dateinamen an eine Navigation ausliefern.
 */

/** Wie eine Datei gedacht ist, wenn jemand ihre Adresse *aufruft*. */
export type Auslieferungsart = 'inline' | 'attachment';

/**
 * Ist diese Anfrage eine Navigation — also der Fall, für den
 * `Content-Disposition` überhaupt gemacht ist?
 *
 * Exportiert, damit Prüfungen die Entscheidung direkt nachrechnen können,
 * statt sie aus Kopfzeilen zu erraten.
 */
export function istNavigation(request: Request): boolean {
  const ziel = request.headers.get('sec-fetch-dest');
  if (ziel === null) return true;
  return ziel === 'document' || ziel === 'iframe' || ziel === 'frame' || ziel === 'object' || ziel === 'embed';
}

export interface BinaerAntwort {
  bytes: Uint8Array | Buffer;
  mimeType: string;
  /** Bereits bereinigt — dieses Modul fasst den Namen nicht an. */
  filename: string;
  /** Vorgabe `inline`; für Ausgaben, die nie im Fenster stehen sollen, `attachment`. */
  disposition?: Auslieferungsart;
  /** Die Anfrage entscheidet, ob `Content-Disposition` mitgeht. */
  request: Request;
  cacheControl?: string;
  /** Zusätzliche Kopfzeilen, etwa `X-Document-Version`. */
  headers?: Record<string, string>;
}

/**
 * Eine Binärantwort mit den Kopfzeilen, die jede private Datei tragen muss —
 * und mit `Content-Disposition` nur dort, wo sie hingehört.
 */
export function binaerAntwort({
  bytes,
  mimeType,
  filename,
  disposition = 'inline',
  request,
  cacheControl = 'private, no-store, max-age=0, must-revalidate',
  headers = {},
}: BinaerAntwort): Response {
  // `Uint8Array` statt `Buffer`: `Response` nimmt beides, aber ein `Buffer`
  // erbt von einem `ArrayBufferLike`, das auch geteilten Speicher zulässt —
  // und den nimmt die Web-API nicht an.
  const koerper = new Uint8Array(bytes);

  const alle: Record<string, string> = {
    'Content-Type': mimeType,
    'Content-Length': String(koerper.byteLength),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': cacheControl,
    Vary: 'Sec-Fetch-Dest',
    ...headers,
  };

  if (istNavigation(request)) {
    alle['Content-Disposition'] = `${disposition}; filename="${filename}"`;
  }

  return new Response(koerper, { status: 200, headers: alle });
}
