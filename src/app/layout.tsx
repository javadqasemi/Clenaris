import type { Metadata, Viewport } from 'next';
import { Archivo, Bricolage_Grotesque } from 'next/font/google';

import { Providers } from '@/components/providers';
import { clientEnv } from '@/lib/env';

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
  metadataBase: new URL(clientEnv.NEXT_PUBLIC_APP_URL),
  title: {
    default: 'Clenaris — Reinigungsfirma in Bern',
    template: '%s | Clenaris',
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
  openGraph: {
    type: 'website',
    locale: 'de_CH',
    url: clientEnv.NEXT_PUBLIC_APP_URL,
    siteName: 'Clenaris',
    title: 'Clenaris — Reinigungsfirma in Bern',
    description:
      'Preis online berechnen, Termin wählen, fertig. Umzugsreinigung mit Abgabegarantie, Unterhalts- und Büroreinigung im Kanton Bern.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Clenaris — Reinigungsfirma in Bern',
    description: 'Preis online berechnen, Termin wählen, fertig.',
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 },
  },
  ...(clientEnv.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION
    ? { verification: { google: clientEnv.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION } }
    : {}),
  alternates: {
    canonical: '/',
    languages: { 'de-CH': '/', 'en-CH': '/en', 'fr-CH': '/fr', 'it-CH': '/it' },
  },
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de-CH" suppressHydrationWarning className={`${sans.variable} ${display.variable}`}>
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
