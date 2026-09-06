import Link from 'next/link';

/**
 * Rahmen für die Rechtstexte.
 *
 * Schmale Spalte, links eine Sprungnavigation. Rechtstexte werden gelesen,
 * wenn jemand ein konkretes Anliegen hat — dann zählt Auffindbarkeit mehr als
 * Gestaltung.
 */
const PAGES = [
  { href: '/legal/impressum', label: 'Impressum' },
  { href: '/legal/datenschutz', label: 'Datenschutz' },
  { href: '/legal/agb', label: 'AGB' },
  { href: '/legal/cookies', label: 'Cookies' },
];

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="container grid max-w-5xl gap-12 py-14 sm:py-20 lg:grid-cols-[minmax(0,14rem)_1fr]">
      <nav aria-label="Rechtliche Dokumente" className="lg:sticky lg:top-24 lg:self-start">
        <h2 className="mb-3 font-display text-sm font-semibold">Rechtliches</h2>
        <ul className="space-y-1">
          {PAGES.map((page) => (
            <li key={page.href}>
              <Link
                href={page.href}
                className="block rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {page.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <article className="space-y-6 [&_h2]:pt-8 [&_h2]:text-title [&_h2]:font-bold [&_h2]:tracking-tight [&_h3]:pt-4 [&_h3]:font-display [&_h3]:text-lg [&_h3]:font-semibold [&_li]:leading-relaxed [&_p]:leading-relaxed [&_p]:text-muted-foreground [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5 [&_ul]:text-muted-foreground">
        {children}
      </article>
    </div>
  );
}
