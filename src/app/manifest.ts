import type { MetadataRoute } from 'next';

import { SEITENNAME } from '@/lib/seo/metadaten';

/**
 * Web-App-Manifest (SEO-06, 2026-09-29) — ausgeliefert als
 * `/manifest.webmanifest`, verlinkt von Next im `<head>` jeder Seite.
 *
 * Bewusst schmal: Name, Bildmarke, Farben. `display: 'browser'` statt
 * `standalone`, weil Clenaris keine installierbare App verspricht — ohne
 * Service Worker und Offline-Betrieb wäre „als App installieren" eine Zusage,
 * die das Produkt nicht hält. Die Farben sind die des hellen Themas aus
 * `viewport.themeColor` in `layout.tsx`, damit Browserleiste und Manifest
 * nicht auseinanderlaufen. Das einzige Symbol ist die freigegebene Bildmarke
 * `icon.svg` — keine neuen Rastergrafiken.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${SEITENNAME} — Reinigung im Kanton Bern`,
    short_name: SEITENNAME,
    lang: 'de-CH',
    start_url: '/',
    scope: '/',
    display: 'browser',
    background_color: '#FBFCFC',
    theme_color: '#FBFCFC',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
  };
}
