import type { Metadata, Viewport } from 'next';
import { Archivo, Bricolage_Grotesque } from 'next/font/google';

import { Providers } from '@/components/providers';
import { GOOGLE_SITE_VERIFICATION, SEITEN_URL } from '@/lib/seiten-url';
import { OG_LOCALE, SEITENNAME, TITEL_VORLAGE } from '@/lib/seo/metadaten';

import './globals.css';

/**
 * Typografie.
 *
 * „Bricolage Grotesque" für Display-Grössen: eine Grotesk mit eigenem
 * Charakter, die eng gesetzt selbstbewusst wirkt, ohne modisch zu sein.
 * „Archivo" für alles darunter: neutral, exzellent in kleinen Graden, mit
 * tabellarischen Ziffern für Beträge und Zeiten.
 */
const display = Bricolage_Grotesque({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
  weight: ['500', '600', '700', '800'],
});

const sans = Archivo({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
});

export const metadata: Metadata = {
  // Kanonische Domain, bewusst zur Bauzeit — Begründung in `src/lib/seiten-url.ts`.
  metadataBase: new URL(SEITEN_URL),
  title: {
    default: 'Clenaris — Reinigungsfirma in Bern',
    // Dieselbe Vorlage, mit der `/admin/seo` die Titellänge misst.
    template: TITEL_VORLAGE,
  },
  description:
    'Professionelle Reinigung im Kanton Bern: Unterhaltsreinigung, Umzugsreinigung mit Abgabegarantie, Büroreinigung und Fensterreinigung. Preis online berechnen und in zwei Minuten buchen.',
  applicationName: 'Clenaris',
  authors: [{ name: 'Clenaris Reinigungen GmbH' }],
  generator: 'Next.js',
  keywords: [
    'Reinigungsfirma Bern',
    'Umzugsreinigung Bern',
    'Büroreinigung Bern',
    'Unterhaltsreinigung',
    'Fensterreinigung Bern',
    'Putzfirma Bern',
    'Abgabegarantie',
  ],
  formatDetection: { telephone: true, address: true, email: true },
  // Ohne `url`: Next ersetzt `openGraph` einer Seite nicht, wenn sie keines
  // setzt — jede solche Seite (Rechtstexte bis 2026-09-28, Anmeldung,
  // Belegseiten) meldete sonst die Startseite als ihre Adresse. Die
  // öffentlichen Seiten setzen `og:url` selbst über `seitenMetadaten()`.
  openGraph: {
    type: 'website',
    locale: OG_LOCALE,
    siteName: SEITENNAME,
    title: 'Clenaris — Reinigungsfirma in Bern',
    description:
      'Preis online berechnen, Termin wählen, fertig. Umzugsreinigung mit Abgabegarantie, Unterhalts- und Büroreinigung im Kanton Bern.',
  },
  twitter: {
    // `summary`, nicht `summary_large_image`: Es gibt kein Standard-Vorschaubild,
    // und die grosse Karte ohne Bild zeigt eine leere Fläche.
    card: 'summary',
    title: 'Clenaris — Reinigungsfirma in Bern',
    description: 'Preis online berechnen, Termin wählen, fertig.',
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 },
  },
  ...(GOOGLE_SITE_VERIFICATION
    ? { verification: { google: GOOGLE_SITE_VERIFICATION } }
    : {}),
  /*
   * Bewusst **keine** `alternates` auf dieser Ebene (SEO-Prüfung 2026-09-28).
   *
   *  • `canonical: '/'` stand hier und wurde von jeder Seite geerbt, die
   *    keine eigene Angabe machte — Rechnung, Buchung, Anmeldung und alle
   *    Applikationsseiten erklärten damit die *Startseite* zu ihrer
   *    kanonischen Fassung. Eine Seite ohne Canonical ist harmlos; eine mit
   *    falschem Canonical bittet Google, sie mit einer anderen
   *    zusammenzulegen. Jede öffentliche Seite setzt ihre Adresse jetzt
   *    selbst (`seitenMetadaten()` in `lib/seo/metadaten.ts`).
   *  • `hreflang` auf `/en`, `/fr` und `/it`: Diese Seiten gibt es nicht, alle
   *    drei antworten 404. Ein hreflang auf eine 404-Seite ist ein Fehler in
   *    der Search Console, und bei einer einsprachigen Website ist gar kein
   *    hreflang nötig — `lang="de-CH"` am `<html>` genügt.
   */
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FBFCFC' },
    { media: '(prefers-color-scheme: dark)', color: '#071316' },
  ],
};

/**
 * `data-scroll-behavior="smooth"` ist keine Zierde, sondern eine Zusage an
 * Next: `globals.css` setzt `scroll-behavior: smooth` auf `<html>`, und Next
 * schaltet weiches Scrollen während eines Seitenwechsels heute noch
 * stillschweigend ab — sonst gleitet der Browser bei jedem Wechsel sichtbar
 * nach oben, statt oben zu beginnen. Ohne dieses Attribut warnt Next bei
 * **jedem** Seitenaufruf in der Konsole, dass es das künftig nicht mehr tun
 * wird. Eine Warnung, die in jedem Lauf steht und jedes Mal überlesen wird,
 * nimmt allen anderen Meldungen die Aufmerksamkeit — und diese Reihe behandelt
 * Konsolenmeldungen als Fehler.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="de-CH"
      suppressHydrationWarning
      data-scroll-behavior="smooth"
      className={`${sans.variable} ${display.variable}`}
    >
      <body className="min-h-dvh bg-background font-sans">
        {/* Tastaturnavigation: erster Tabstopp springt zum Inhalt. */}
        <a
          href="#inhalt"
          className="sr-only-focusable fixed left-4 top-4 z-[100] rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-elevated"
        >
          Zum Inhalt springen
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
