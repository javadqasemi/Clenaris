import type { Metadata } from 'next';
import Link from 'next/link';
import { Search } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { getOrganizationId } from '@/server/services/organization.service';
import { globaleSuche, type Treffer } from '@/server/services/search.service';
import { Badge } from '@/components/ui/badge';
import { DetailSection, EmptyState, PageHeader } from '@/components/app/page-parts';

export const metadata: Metadata = {
  title: 'Suche',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Globale Suche (Wave 17) — die Vollansicht.
 *
 * Seit dem Produktsprint vom 2026-09-26 sucht man in der Kopfzeile, live
 * während des Tippens (`src/components/app/global-search.tsx`). Diese Seite
 * bleibt als Ziel von „Alle Treffer anzeigen" und als Weg ohne JavaScript:
 * ein schlichtes Formular, auf dem Server gerendert, die Treffer sind Links.
 * Der Einwand von damals — Client-Zustand in jeder Seite gefährde die
 * Hydration — ist in der Kopfzeilensuche dadurch aufgefangen, dass ihre
 * Struktur bis zur ersten Eingabe feststeht; Begründung dort.
 */
export default async function SearchPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const session = await requirePermission('dashboard:view');
  const params = await searchParams;
  const q = (params.q ?? '').trim().slice(0, 80);
  const ergebnis = q.length >= 2 ? await globaleSuche({ organizationId: await getOrganizationId(), session, q }) : null;
  const gruppen = new Map<string, Treffer[]>();
  for (const t of ergebnis?.treffer ?? []) gruppen.set(t.art, [...(gruppen.get(t.art) ?? []), t]);

  return (
    <div className="space-y-6">
      <PageHeader title="Suche" description="Kundschaft, Objekte, Buchungen, Offerten, Verträge, Einsätze, Rechnungen, Dokumente und mehr — je nach Ihren Rechten." />
      <form action="/admin/suche" method="get" role="search" className="flex max-w-xl gap-2">
        <label htmlFor="suche-q" className="sr-only">
          Suchbegriff
        </label>
        <input
          id="suche-q"
          name="q"
          type="search"
          defaultValue={q}
          minLength={2}
          maxLength={80}
          placeholder="Name, Nummer, Titel …"
          className="h-10 flex-1 rounded-md border border-input bg-background px-3 text-body"
        />
        <button type="submit" className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">
          <Search className="size-4" aria-hidden />
          Suchen
        </button>
      </form>

      {ergebnis === null ? null : ergebnis.treffer.length === 0 ? (
        <EmptyState icon={<Search aria-hidden />} title="Nichts gefunden" description={`Kein Treffer für „${q}".`} />
      ) : (
        [...gruppen.entries()].map(([art, treffer]) => (
          <DetailSection key={art} title={art} body="flush">
            <ul className="divide-y divide-border">
              {treffer.map((t) => (
                <li key={`${t.art}-${t.id}`} className="flex items-center justify-between gap-3 px-6 py-2.5 text-sm">
                  <Link href={t.link} className="font-medium hover:text-primary">
                    {t.titel}
                  </Link>
                  {t.untertitel ? (
                    <Badge size="sm" variant="outline">
                      {t.untertitel}
                    </Badge>
                  ) : null}
                </li>
              ))}
            </ul>
          </DetailSection>
        ))
      )}
    </div>
  );
}
