import Link from 'next/link';

import { can } from '@/lib/auth/rbac';
import type { ActorRole } from '@/lib/auth/rbac';
import { cn } from '@/lib/utils';

/**
 * Reiter „Finanzen und Betrieb | Website-Besuche" über den Auswertungsseiten.
 *
 * **Warum Reiter und kein neuer Eintrag in der Seitenleiste.** Die
 * Besuchsauswertung ist eine weitere Sicht derselben Frage — „wie läuft das
 * Geschäft?" — und gehört neben Umsatz und Auslastung, nicht als eigener
 * Bereich daneben. Die Seitenleiste ist die Karte der Bereiche; ein zweiter
 * Eintrag „Website-Besuche" in der Gruppe Marketing hätte dieselbe Seite von
 * zwei Stellen her erreichbar gemacht und wäre beim Öffnen unter
 * „Auswertungen" markiert gewesen — eine Navigation, die zwei Orte behauptet.
 *
 * **Warum eine Server-Komponente.** Welche Reiter es gibt, entscheidet das
 * Recht der Rolle (`can`) auf dem Server: Ein Reiter, den erst der Browser
 * ausblendet, stünde im HTML und wäre ein Wegweiser auf eine verschlossene
 * Tür. Hat die Rolle nur eine der beiden Sichten, entfällt die Leiste ganz —
 * ein einzelner Reiter ist keine Auswahl.
 *
 * Heute haben alle Rollen mit `traffic:read` auch `report:read` (die
 * Seitenleiste führt über „Auswertungen" hierher). Wer eine Rolle nur mit
 * `traffic:read` einrichtet, braucht einen eigenen Einstieg — das steht in
 * `docs/TRAFFIC_ANALYTICS.md`.
 */
export function AuswertungenReiter({
  rolle,
  aktiv,
}: {
  rolle: ActorRole;
  aktiv: 'finanzen' | 'website';
}) {
  const reiter = [
    {
      key: 'finanzen' as const,
      href: '/admin/auswertungen',
      label: 'Finanzen und Betrieb',
      sichtbar: can(rolle, 'report:read'),
    },
    {
      key: 'website' as const,
      href: '/admin/auswertungen/website',
      label: 'Website-Besuche',
      sichtbar: can(rolle, 'traffic:read'),
    },
  ].filter((r) => r.sichtbar);

  if (reiter.length < 2) return null;

  return (
    <nav aria-label="Auswertungen" className="border-b border-border">
      <ul className="-mb-px flex flex-wrap gap-x-6 gap-y-1">
        {reiter.map((r) => {
          const istAktiv = r.key === aktiv;
          return (
            <li key={r.key}>
              <Link
                href={r.href}
                aria-current={istAktiv ? 'page' : undefined}
                className={cn(
                  'inline-block border-b-2 px-0.5 pb-2.5 text-sm font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  istAktiv
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {r.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
