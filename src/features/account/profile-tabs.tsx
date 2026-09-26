'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';

/**
 * Reiter „Profil | Einstellungen" über den beiden Kontoseiten.
 *
 * **Warum es diese Trennung gibt.** Bis zum Produktsprint vom 2026-09-26
 * führte der Eintrag „Einstellungen" im Kontomenü der Administration auf
 * `/admin/einstellungen` — die *Betriebs*einstellungen mit Firmenangaben,
 * Öffnungszeiten, Katalog und Finanzen. Wer im Menü seines eigenen Kontos
 * „Einstellungen" wählt, erwartet aber seine eigenen: Benachrichtigungen,
 * Darstellung, Passwort, zweiter Faktor. Die Verwechslung war nicht bloss
 * lästig, sie lud dazu ein, an der Firmenkonfiguration zu drehen, während man
 * das eigene Passwort suchte. Persönliches steht jetzt unter
 * `…/profil/einstellungen`, in jedem der drei Bereiche; die
 * Betriebseinstellungen erreicht man nur noch über die Seitenleiste.
 *
 * **Warum eine Client-Komponente.** Beide Seiten werden in drei Bereichen
 * wiederverwendet (`/admin`, `/portal`, `/konto` exportieren dieselbe Seite
 * weiter). Die Seite selbst weiss deshalb nicht, unter welchem Präfix sie
 * läuft — der Pfad schon. `usePathname()` liefert auf dem Server und beim
 * ersten Durchgang im Browser denselben Wert, die Struktur hängt nicht davon
 * ab (immer zwei Links, nur `aria-current` und Klassen wechseln); das ist die
 * Form, die `docs/HYDRATION.md` §9 erlaubt.
 */
export function ProfileTabs() {
  const pathname = usePathname();
  const basis = pathname.replace(/\/profil(?:\/einstellungen)?\/?$/, '');
  const einstellungen = /\/profil\/einstellungen\/?$/.test(pathname);

  const reiter = [
    { href: `${basis}/profil`, label: 'Profil', aktiv: !einstellungen },
    { href: `${basis}/profil/einstellungen`, label: 'Einstellungen', aktiv: einstellungen },
  ];

  return (
    <nav aria-label="Kontobereich" className="border-b border-border">
      <ul className="-mb-px flex gap-6">
        {reiter.map((r) => (
          <li key={r.label}>
            <Link
              href={r.href}
              aria-current={r.aktiv ? 'page' : undefined}
              className={cn(
                'inline-block border-b-2 px-0.5 pb-2.5 text-sm font-medium transition-colors',
                r.aktiv
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {r.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
