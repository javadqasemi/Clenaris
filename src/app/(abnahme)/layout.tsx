import type { Metadata } from 'next';

import { Logo } from '@/components/marketing/logo';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * Der Rahmen für die Abnahme auf dem übergebenen Gerät — absichtlich leer.
 *
 * **Warum ein eigener Rahmen und nicht der Anwendungsrahmen.** Hier hält die
 * Kundschaft das Telefon einer Mitarbeiterin in der Hand. Der
 * Anwendungsrahmen brächte Seitennavigation, Benachrichtigungen, Profilmenü
 * und Verwaltungslinks mit — alles, was diese Person nicht sehen soll und
 * was sie mit einem Fehlgriff öffnen würde. Also nichts davon: kein Menü,
 * keine Navigation, kein Konto, kein Zurück in die Anwendung.
 *
 * Dass die Anmeldecookies der Mitarbeiterin weiterhin im Browser liegen,
 * ändert dieser Rahmen nicht — dafür sorgt die Gerätesperre auf dem Server
 * (`device-handoff.service.ts`). Eine Seite ohne Navigation ist eine Bitte;
 * die Sperre ist die Zusicherung. Beide zusammen ergeben erst das, was hier
 * nötig ist.
 */
export default function AbnahmeLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-surface">
      <header className="border-b border-border bg-card">
        <div className="container flex h-14 items-center justify-between">
          <Logo />
          <span className="text-meta text-muted-foreground">Abnahme vor Ort</span>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-border py-4 text-center text-2xs text-muted-foreground">
        Der Ablauf wird in einem Signaturprotokoll festgehalten.
      </footer>
    </div>
  );
}
