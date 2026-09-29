import type { MetadataRoute } from 'next';

import { SEITEN_URL } from '@/lib/seiten-url';

/**
 * robots.txt
 *
 * Alle internen Bereiche sind ausgeschlossen — zusätzlich zum
 * `X-Robots-Tag`-Header, den die Middleware setzt. Die tokenbasierten
 * Dokumentseiten (`/offerte/…`, `/rechnung/…`, `/buchung/…`) sind ebenfalls
 * gesperrt: sie enthalten personenbezogene Daten und sollen nie im Index
 * landen, auch wenn ein Link versehentlich geteilt wird.
 */
export default function robots(): MetadataRoute.Robots {
  // Kanonische Domain (Bauzeit, `src/lib/seiten-url.ts`). Eine Probeumgebung
  // gehört ohnehin mit `X-Robots-Tag: noindex` hinter den Proxy.
  const base = SEITEN_URL;

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/admin/',
          '/portal/',
          '/konto/',
          '/api/',
          '/auth/',
          '/offerte/',
          '/rechnung/',
          '/buchung/',
          '/newsletter/',
          // Ergänzt 2026-09-28 (SEO-Prüfung): Unterzeichnung und Vor-Ort-
          // Abnahme (per Link erreichbar, tragen Personendaten und schon
          // `X-Robots-Tag: noindex`), die Rückkehr vom Zahlungsanbieter und
          // die Buchungsbestätigung — alle vier `noindex`, nichts davon ist
          // eine Seite, die jemand über eine Suchmaschine finden soll.
          '/signieren',
          '/abnahme/',
          '/geraet-uebernehmen',
          '/zahlung/',
          '/buchen/bestaetigt',
        ],
      },
      {
        // Trainingscrawler ausschliessen — unsere Inhalte sollen Kundschaft
        // erreichen, nicht Sprachmodelle Dritter trainieren.
        userAgent: ['GPTBot', 'CCBot', 'Google-Extended', 'anthropic-ai', 'ClaudeBot'],
        disallow: '/',
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
