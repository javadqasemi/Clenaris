import type { MetadataRoute } from 'next';

import { clientEnv } from '@/lib/env';

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
  const base = clientEnv.NEXT_PUBLIC_APP_URL.replace(/\/$/, '');

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
