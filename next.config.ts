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
  'upgrade-insecure-requests',
].join('; ');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  compress: true,

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
