/**
 * Die Inhaltsrichtlinie (`Content-Security-Policy`) der Anwendung — an einer
 * Stelle gebaut, als reine Funktion.
 *
 * ---------------------------------------------------------------------------
 *  Warum eine eigene Datei statt der Zeichenkette in `next.config.ts`
 * ---------------------------------------------------------------------------
 *
 * Bis 2026-09-30 stand die Richtlinie als fertige Zeichenkette in
 * `next.config.ts`, und keine einzige Prüfung las sie. Das hatte die
 * vorhersehbare Folge: `'unsafe-eval'` blieb stehen, obwohl
 * `docs/SECURITY_STANDARD.md` (C6) es ausdrücklich verbietet, und mit ihm
 * dreizehn Quelleneinträge für Stripe.js, die Google-Maps-Bibliothek,
 * Supabase Realtime, Google Fonts und eingebettete Google-Inhalte — Dienste,
 * die der Browser in dieser Anwendung nie anspricht. Eine Richtlinie, die
 * niemand prüft, wird nur länger.
 *
 * Als reine Funktion ist sie ohne Bau und ohne Server prüfbar
 * (`tests/api/inhaltsrichtlinie.test.ts`), und dieselbe Prüfung vergleicht den
 * ausgelieferten Kopf mit genau dieser Ausgabe. `next.config.ts` setzt sie nur
 * noch ein.
 *
 * **Die Datei importiert absichtlich nichts.** `next.config.ts` lädt sie beim
 * Bau und beim Start über den Require-Hook von Next — ausserhalb des Bündlers,
 * in einem gewöhnlichen Node-Prozess. Ein `import 'server-only'` würfe dort
 * (das Paket wirft ausserhalb der Serverkomponenten-Bedingung mit Absicht),
 * und jeder weitere Import wäre eine Abhängigkeit, die der Konfigurationslader
 * auflösen können muss, bevor der Server überhaupt steht.
 *
 * ---------------------------------------------------------------------------
 *  Was die Richtlinie leistet und was nicht
 * ---------------------------------------------------------------------------
 *
 * Ohne `'unsafe-eval'` kann ein eingeschleuster *Text* nicht mehr zu Code
 * werden: Die String-zu-Code-Wege des Browsers — `eval`, der
 * `Function`-Konstruktor, `setTimeout` mit einer Zeichenkette — verweigern
 * den Dienst. Genau diese Wege machen aus einer harmlos aussehenden Stelle,
 * die fremden Text an eine Bibliothek weiterreicht, eine Skriptausführung.
 * Die Anwendung selbst benutzt keinen davon (die Musterprüfung
 * `scripts/security/muster.ts`, Regel `eval`, verbietet sie in `src/`), und
 * die ausgelieferten Bündel greifen nur in Rückfallzweigen darauf zurück, die
 * ein aktueller Browser nie erreicht (`Function("return this")` hinter
 * `globalThis` bzw. `self`).
 *
 * **`'unsafe-inline'` bleibt — das ist die offene Hälfte von S-04**
 * (`docs/NEXT_DEVELOPMENT_AUDIT.md`). Next schreibt die Nutzlast der
 * Serverkomponenten als Inline-Skripte in jede Seite, und die Analyse-Skripte
 * (`src/components/marketing/analytics.tsx`) sind Inline-Skripte. Der Ersatz
 * wären Nonces, und ein Nonce verlangt, dass jede Seite je Anfrage gerendert
 * wird — die Website ist aber bewusst statisch und aus dem CMS vorgerendert.
 * Diese Abwägung gehört in einen eigenen Schritt, nicht in diesen.
 *
 * ---------------------------------------------------------------------------
 *  Jede Quelle hat einen Verbraucher
 * ---------------------------------------------------------------------------
 *
 * Eine neue Quelle braucht hier ihre Begründung (SECURITY_STANDARD C6) — und
 * eine Änderung an der Prüfung „keine ungenutzten Fremdquellen", die jede
 * Fremdquelle einzeln aufzählt. Das ist Absicht: Eine Quelle, die man
 * „vorsorglich" einträgt, bleibt stehen, wenn ihr Verbraucher längst weg ist.
 */

export interface InhaltsrichtlinieOptionen {
  /**
   * `true` **nur** für den Entwicklungsserver (`next dev`).
   *
   * Woher dieser Wert kommt, entscheidet `next.config.ts`: aus der Phase, in
   * der Next die Konfiguration lädt — nie aus einer Umgebungsvariable. Die
   * Begründung steht dort.
   */
  entwicklung: boolean;
}

export function inhaltsrichtlinie({ entwicklung }: InhaltsrichtlinieOptionen): string {
  const anweisungen: string[] = [
    "default-src 'self'",

    [
      'script-src',
      "'self'",
      // Nutzlast der Serverkomponenten und Analyse-Skripte — siehe oben (S-04).
      "'unsafe-inline'",
      /*
       * Nur der Entwicklungsserver. React wertet dort Zeichenketten als Code
       * aus, um die Aufrufstapel der Serverkomponenten im Browser
       * nachzubilden, und der Entwicklungsbau von Next lädt Module über
       * denselben Weg (Quellkarten, schnelles Neuladen). Ohne die Freigabe
       * bliebe `next dev` — und damit der Diagnoseserver
       * (`scripts/diagnose-server.ts`, ebenfalls `next dev`) — eine leere
       * Seite. Im Produktionsbau braucht nichts davon eine Auswertung.
       */
      ...(entwicklung ? ["'unsafe-eval'"] : []),
      /*
       * WebAssembly übersetzen, nicht JavaScript auswerten.
       *
       * PDF.js 6 dekodiert JPEG 2000 (`openjpeg.wasm`) und JBIG2
       * (`jbig2.wasm`) und rechnet Farbprofile (`qcms_bg.wasm`) in
       * WebAssembly, geladen aus `/pdfjs/<Version>/wasm/`
       * (`scripts/copy-pdfjs-assets.ts`). Ohne diese Freigabe verweigert der
       * Browser `WebAssembly.instantiate`; PDF.js fiele auf seine langsameren
       * JavaScript-Ersatzdekoder zurück und schriebe bei jedem solchen
       * Dokument eine CSP-Meldung in die Konsole.
       *
       * Warum das nicht dasselbe Loch wieder öffnet: Ein WebAssembly-Modul ist
       * Bytecode, den die Engine vor dem Übersetzen validiert. Es hat keinen
       * Zugriff auf DOM, Cookies oder Netz ausser über ausdrücklich
       * übergebene Funktionen, und es macht aus keinem Text Skriptcode. Wer
       * ein Modul übersetzen lassen könnte, müsste dafür bereits Skript
       * ausführen — und hätte dann ohnehin alles.
       *
       * Die Richtlinie gilt auch im Worker von PDF.js: Ein Worker aus einer
       * eigenen Adresse bekommt die Richtlinie *seiner* Antwort, und das ist
       * dieser Kopf, weil `next.config.ts` ihn auf jeden Pfad legt.
       */
      "'wasm-unsafe-eval'",
      // Google Analytics 4 (gtag.js) und der Tag Manager — beide erst nach
      // der Einwilligung (`analytics.tsx`).
      'https://www.googletagmanager.com',
      // Meta-Pixel — erst nach der Einwilligung in Marketing (`analytics.tsx`).
      'https://connect.facebook.net',
    ].join(' '),

    /*
     * Kein `https://fonts.googleapis.com` mehr: `next/font/google`
     * (`src/app/layout.tsx`) lädt Bricolage Grotesque und Archivo beim Bau
     * herunter und liefert sie aus `/_next/static/media` aus. Zur Laufzeit
     * fragt kein Browser Google nach einem Stylesheet — und ein Eintrag dafür
     * wäre nur eine Einladung, es doch wieder zu tun, samt der
     * Besucherdaten, die Google dabei sieht.
     */
    "style-src 'self' 'unsafe-inline'",

    /*
     * `data:` bleibt: PDF.js registriert in PDFs eingebettete Schriften als
     * `@font-face` mit einer `data:`-Adresse
     * (`FontFaceObject.createFontFaceRule`). `https://fonts.gstatic.com`
     * entfällt aus demselben Grund wie oben.
     */
    "font-src 'self' data:",

    /*
     * `https://*.supabase.co` bleibt für Bilder aus dem Objektspeicher (auch
     * ältere Datensätze mit gespeicherter Speicheradresse), Google Analytics
     * für seinen Messpixel.
     *
     * Entfallen sind `maps.gstatic.com`, `maps.googleapis.com` und
     * `*.googleapis.com`: Die Anwendung zeigt keine Karte im Browser. Geocoding
     * und Distanzmatrix laufen serverseitig (`src/lib/maps/google.ts`,
     * `server-only`), der Navigationslink ist ein gewöhnlicher Link zu Google
     * Maps (eine Navigation, keine eingebettete Ressource), und
     * `staticMapUrl` hat keinen Aufrufer — sie ist für PDF und E-Mail gedacht,
     * wo diese Richtlinie ohnehin nicht gilt.
     */
    "img-src 'self' data: blob: https://*.supabase.co https://www.google-analytics.com",

    /*
     * `https://*.supabase.co` bleibt: Der Browser lädt Dateien mit der
     * signierten Adresse **direkt** in den Objektspeicher
     * (`src/lib/upload.ts`, `PUT` an `signedUrl`) — an der Anwendung vorbei,
     * wegen des Körperlimits. Ohne den Eintrag scheiterte jeder Upload, sobald
     * Supabase eingerichtet ist.
     *
     * Entfallen:
     *  • `wss://*.supabase.co` — Realtime. Der einzige Supabase-Klient steht in
     *    `src/lib/storage/supabase.ts` und ist `server-only`; im Browser gibt
     *    es keinen, also auch keine Websocket-Verbindung dorthin.
     *  • `https://api.stripe.com` — Stripe.js wird nicht geladen. Bezahlt wird
     *    über eine Weiterleitung zu Stripe Checkout
     *    (`src/features/public/pay-invoice.tsx`); das ist eine Navigation,
     *    kein Abruf aus der Seite.
     *  • `https://maps.googleapis.com` — siehe `img-src`.
     */
    "connect-src 'self' https://*.supabase.co https://www.google-analytics.com",

    /*
     * `'self'`: Die Redaktionsmaske zeigt die echte Website in einem Rahmen
     * (`src/features/admin/content-workspace.tsx`).
     *
     * `blob:`: Der PDF-Viewer druckt, indem er die bereits geladenen Bytes als
     * Objekt-URL in einen versteckten Rahmen legt
     * (`src/components/app/pdf-viewer-inner.tsx`, `drucken`). `'self'` deckt
     * eine `blob:`-Adresse nicht zuverlässig ab — Chromium vergleicht dafür
     * das Schema, und `blob` ist nicht `https` —; der Rahmen würde also
     * verweigert, und der Druck fiele still aus (der Fehler wird dort bewusst
     * geschluckt, damit der Weg über „Herunterladen" bleibt). Eine
     * `blob:`-Adresse kann nur Skript dieser Seite erzeugen; die Freigabe
     * öffnet keinem fremden Ursprung einen Rahmen.
     *
     * Offen und nicht belegt: Das `blob:`-Dokument im Rahmen erbt diese
     * Richtlinie samt `object-src 'none'`. Ob der PDF-Darsteller eines
     * Browsers darin trotzdem erscheinen darf, prüft kein Fall — der
     * Browserfall (`tests/e2e/inhaltsrichtlinie.browser.spec.ts`) lädt nur ein
     * HTML-Dokument über `blob:` und belegt damit `frame-src`, nicht den
     * Druck. `object-src` deshalb vorsorglich zu öffnen hiesse, Plugins für
     * die ganze Anwendung zuzulassen, ohne zu wissen, ob es nötig ist; die
     * Messung in einem Browser mit echtem PDF-Darsteller muss zuerst kommen.
     *
     * Entfallen: `js.stripe.com` und `hooks.stripe.com` (Rahmen von Stripe
     * Elements und 3-D Secure — Checkout ist eine Weiterleitung, kein Rahmen)
     * sowie `www.google.com` (keine eingebettete Karte, kein reCAPTCHA).
     */
    "frame-src 'self' blob:",

    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",

    /**
     * `'self'` statt `'none'`.
     *
     * Die Redaktionsmaske zeigt die echte Website in einem Rahmen, damit eine
     * Änderung dort geprüft werden kann, wo sie erscheint. Mit `'none'` wäre das
     * unmöglich — und eine nachgebaute Vorschau wäre schlechter als keine, weil
     * sie bei jeder Layoutänderung still falsch würde.
     *
     * Der Schutz bleibt vollständig: Gegen Clickjacking hilft, dass *fremde*
     * Seiten diese Anwendung nicht einbetten dürfen, und genau das sagt
     * `'self'` weiterhin. Eine Seite, die sich selbst einbettet, kann ihre
     * eigenen Besucher nicht täuschen.
     */
    "frame-ancestors 'self'",
    /*
     * Kein `upgrade-insecure-requests` mehr (seit 2026-09-28).
     *
     * Die Anweisung schreibt jede Unteranfrage von `http:` auf `https:` um. Auf
     * einem Server, der selbst über `http` ausliefert — Testserver, Vorschau im
     * lokalen Netz —, tut WebKit das auch für `127.0.0.1` und `localhost`
     * (Chromium und Firefox nehmen die Rückschleife aus). Gemessen mit
     * Playwright: CSS, JavaScript und alle Bilder scheiterten mit „SSL connect
     * error", die Seite blieb ungestylt und unhydriert, die Galeriebilder leer
     * (`tests/e2e/bilder.browser.spec.ts`). Ein Bau entscheidet das nicht nach
     * Umgebung — er ist für alle Umgebungen derselbe (V2-1).
     *
     * Verloren geht dabei nichts: HSTS (in `next.config.ts`, zwei Jahre,
     * `includeSubDomains`, `preload`) zwingt den eigenen Ursprung auf `https`,
     * und jede andere Quelle dieser Richtlinie ist ein ausdrückliches
     * `https://`-Ziel. Eine `http://`-Unteranfrage würde also nicht
     * hochgestuft, sondern von der Richtlinie selbst abgewiesen — der Schutz
     * vor gemischten Inhalten bleibt.
     */
  ];

  return anweisungen.join('; ');
}
