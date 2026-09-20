import type { Metadata } from 'next';

import { Logo } from '@/components/marketing/logo';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * Der Rahmen für die Unterzeichnung — absichtlich leer.
 *
 * Kein Website-Kopf, keine Fusszeile, keine Analytik, keine fremden Skripte,
 * keine fremden Schriften oder Bilder. Der Link, der hierher führt, trägt
 * einen Zugangstoken im Fragment; jedes eingebundene Drittskript könnte ihn
 * lesen, bevor die Seite ihn aus der Adresse entfernt hat. Was hier fehlt,
 * fehlt deshalb mit Absicht — auch wenn die Seite dadurch nüchterner wirkt
 * als der Rest der Website.
 */
export default function SignierenLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-surface">
      <header className="border-b border-border bg-card">
        <div className="container flex h-14 items-center justify-between">
          <Logo />
          <span className="text-meta text-muted-foreground">Elektronische Unterzeichnung</span>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-border py-4 text-center text-2xs text-muted-foreground">
        Sichere Verbindung · Der Ablauf wird in einem Signaturprotokoll festgehalten.
      </footer>
    </div>
  );
}
