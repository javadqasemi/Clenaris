import type { NextConfig } from 'next';

/**
 * Architekturentscheid:
 * - `serverExternalPackages` hält native/Node-only Pakete (argon2, ioredis, twilio,
 *   @react-pdf/renderer) aus dem Bundling-Prozess heraus. Sie laufen ausschliesslich
 *   in der Node.js-Runtime der Route Handler, niemals in der Edge-Runtime.
 * - Security-Header werden zentral hier gesetzt, damit sie für statische Assets,
 *   Server Components und Route Handler gleichermassen gelten (Defense in Depth
 *   zusätzlich zu Cloudflare).
 */
const cspDirectives = [
  "default-src 'self'",
  // Google Maps + Stripe + Analytics benötigen externe Skripte.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://maps.googleapis.com https://js.stripe.com https://www.googletagmanager.com https://connect.facebook.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https://*.supabase.co https://maps.gstatic.com https://maps.googleapis.com https://*.googleapis.com https://www.google-analytics.com",
  "connect-src 'self' https://*.supabase.co https://api.stripe.com https://maps.googleapis.com https://www.google-analytics.com wss://*.supabase.co",
  "frame-src 'self' https://js.stripe.com https://hooks.stripe.com https://www.google.com",
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
   * Verloren geht dabei nichts: HSTS (unten, zwei Jahre, `includeSubDomains`,
   * `preload`) zwingt den eigenen Ursprung auf `https`, und jede andere Quelle
   * dieser Richtlinie ist ein ausdrückliches `https://`-Ziel. Eine
   * `http://`-Unteranfrage würde also nicht hochgestuft, sondern von der
   * Richtlinie selbst abgewiesen — der Schutz vor gemischten Inhalten bleibt.
   */
].join('; ');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  compress: true,

  /**
   * Das Bauverzeichnis ist über die Umgebung verschiebbar — Vorgabe bleibt
   * `.next`.
   *
   * Der Grund ist ein Diagnoseproblem, das eine ganze Wave lang nicht lösbar
   * war: Ein Hydrationsfehler meldet sich im Produktionsbau nur als
   * „Minified React error #418" ohne das betroffene Element. Die Meldung im
   * Klartext — samt Gegenüberstellung von Server- und Client-Baum — gibt es
   * ausschliesslich im Entwicklungsbau. Der aber schrieb bisher in dasselbe
   * `.next`, in dem der Produktionsbau steht, den die Browserreihe fährt.
   * Wer also die Ursache suchte, zerstörte dabei die Umgebung, in der der
   * Fehler auftrat, und musste vor dem nächsten Lauf neu bauen.
   *
   * Mit `NEXT_DIST_DIR=.next-diagnose` läuft der Entwicklungsserver in einem
   * eigenen Verzeichnis neben dem Produktionsbau. Beide existieren
   * gleichzeitig; `scripts/diagnose-server.ts` nutzt genau das.
   *
   * Der Produktionsweg ist davon unberührt: Ohne die Variable steht hier
   * derselbe Wert wie vorher.
   */
  distDir: process.env.NEXT_DIST_DIR?.trim() || '.next',

  serverExternalPackages: [
    '@node-rs/argon2',
    'ioredis',
    'twilio',
    '@react-pdf/renderer',
    'exceljs',
  ],

  experimental: {
    // Nur Pakete mit vielen benannten Exporten — sonst kostet die Analyse mehr,
    // als sie spart.
    optimizePackageImports: ['lucide-react', 'recharts'],
  },

  images: {
    formats: ['image/avif', 'image/webp'],
    remotePatterns: [
      { protocol: 'https', hostname: '**.supabase.co' },
      { protocol: 'https', hostname: 'images.unsplash.com' },
      { protocol: 'https', hostname: 'maps.googleapis.com' },
    ],
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: cspDirectives },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Muss zu `frame-ancestors` passen — ältere Browser kennen nur
          // diesen Kopf, und zwei widersprüchliche Angaben führen je nach
          // Browser zu unterschiedlichem Verhalten.
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(self), microphone=(self), geolocation=(self), payment=(self)',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
      /**
       * Der Unterzeichnungsbereich: kein Referrer (der Link trägt einen
       * Token im Fragment, und nichts davon soll je eine fremde Adresse
       * erreichen), kein Zwischenspeicher (Dokument, Zustimmung, Ergebnis),
       * keine Indexierung. Gilt zusätzlich zu den allgemeinen Kopfzeilen;
       * gleiche Schlüssel werden hier überschrieben.
       */
      {
        source: '/signieren/:path*',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
      {
        source: '/signieren',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
      /**
       * Die Signatur-API ebenfalls: Die Routen setzen den Kopf selbst, aber
       * die allgemeine Regel oben gewinnt gegen einen im Handler gesetzten
       * Wert. Hier steht er deshalb noch einmal — und zuletzt.
       */
      {
        source: '/api/public/signatures/:path*',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
    ];
  },

  /**
   * Umleitungen auf die kanonischen deutschen Pfade.
   *
   * Die Applikation ist deutschsprachig; `/leistungen` und `/kontakt` sind die
   * echten Seiten. Hier stehen nur die Adressen, die Besucherinnen und
   * Besucher erfahrungsgemäss trotzdem eintippen oder aus alten Links
   * mitbringen — englische Formen und Synonyme.
   */
  async redirects() {
    return [
      { source: '/home', destination: '/', permanent: true },
      { source: '/services', destination: '/leistungen', permanent: true },
      { source: '/dienstleistungen', destination: '/leistungen', permanent: true },
      { source: '/contact', destination: '/kontakt', permanent: true },
      { source: '/about', destination: '/ueber-uns', permanent: true },
      { source: '/pricing', destination: '/preise', permanent: true },
      { source: '/booking', destination: '/buchen', permanent: true },
      { source: '/jobs', destination: '/karriere', permanent: true },
      { source: '/login', destination: '/auth/anmelden', permanent: true },
      { source: '/impressum', destination: '/legal/impressum', permanent: true },
      { source: '/datenschutz', destination: '/legal/datenschutz', permanent: true },
      { source: '/agb', destination: '/legal/agb', permanent: true },
    ];
  },
};

export default nextConfig;
