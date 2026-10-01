import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';

import { inhaltsrichtlinie } from './src/lib/security/inhaltsrichtlinie';

/**
 * Architekturentscheid:
 * - `serverExternalPackages` hält native/Node-only Pakete (argon2, ioredis, twilio,
 *   @react-pdf/renderer) aus dem Bundling-Prozess heraus. Sie laufen ausschliesslich
 *   in der Node.js-Runtime der Route Handler, niemals in der Edge-Runtime.
 * - Security-Header werden zentral hier gesetzt, damit sie für statische Assets,
 *   Server Components und Route Handler gleichermassen gelten (Defense in Depth
 *   zusätzlich zu Cloudflare). Die Inhaltsrichtlinie selbst entsteht in
 *   `src/lib/security/inhaltsrichtlinie.ts` — dort steht zu jeder Quelle, wer
 *   sie braucht, und dort wird sie ohne Server geprüft.
 */
const nextConfig = (entwicklung: boolean): NextConfig => ({
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
          { key: 'Content-Security-Policy', value: inhaltsrichtlinie({ entwicklung }) },
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
});

/**
 * Die Konfiguration ist eine **Funktion der Phase**, nicht ein fester Wert —
 * und zwar allein wegen `'unsafe-eval'`.
 *
 * Der Entwicklungsserver braucht es (React bildet dort die Aufrufstapel der
 * Serverkomponenten über ausgewertete Zeichenketten nach), der Produktionsbau
 * nicht, und dort ist es verboten (SECURITY_STANDARD C6). Die Frage ist nur,
 * *woran* man den Entwicklungsserver erkennt. Next übergibt dafür die Phase:
 * `phase-development-server` gibt es ausschliesslich unter `next dev`.
 *
 * **Warum keine Umgebungsvariable** (etwa `NODE_ENV` oder ein eigener
 * Schalter). Die Kopfzeilen werden beim Bau festgeschrieben: `next build`
 * ruft `headers()` in der Phase `phase-production-build` auf und legt das
 * Ergebnis in `routes-manifest.json` ab; `next start` liest sie von dort und
 * ruft `headers()` nicht noch einmal auf. Eine Variable, die beim Bau
 * zufällig gesetzt war — in einer CI-Stufe, einer lokalen Shell, einem
 * Probebau —, läge damit unsichtbar im Artefakt, und zwei Artefakte aus
 * demselben Commit trügen verschiedene Richtlinien. Das ist genau, was V2-1
 * ausschliesst: ein Artefakt für jede Umgebung, dessen Inhalt nicht davon
 * abhängt, wo es gebaut wurde. Die Phase dagegen setzt Next selbst nach dem
 * Befehl; es gibt keinen Weg, `next build` den Entwicklungsserver behaupten
 * zu lassen. Ein Artefakt kann `'unsafe-eval'` also gar nicht tragen.
 *
 * Der Entwicklungsserver ist kein Artefakt: Er übersetzt bei jeder Anfrage aus
 * dem Quelltext und wird nie ausgeliefert. Dass er eine weitere Richtlinie
 * bekommt, verletzt V2-1 deshalb nicht.
 *
 * Der Diagnoseserver (`scripts/diagnose-server.ts`) startet `next dev` und
 * bekommt die Freigabe damit von selbst; sein `NODE_ENV=development` spielt
 * für die Richtlinie keine Rolle.
 */
export default function konfiguration(phase: string): NextConfig {
  return nextConfig(phase === PHASE_DEVELOPMENT_SERVER);
}
