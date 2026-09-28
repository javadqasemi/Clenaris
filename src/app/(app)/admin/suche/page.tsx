import type { Metadata } from 'next';
import Link from 'next/link';
import { AlertTriangle, Search } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { checkRateLimit } from '@/lib/rate-limit';
import { getOrganizationId } from '@/server/services/organization.service';
import {
  globaleSuche,
  SEITE_JE_BEREICH,
  UEBERSICHT_JE_BEREICH,
  type SuchErgebnis,
  type Treffer,
} from '@/server/services/search.service';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/primitives';
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
 *
 * **Seit 2026-09-27 wirklich „alle".** Vorher lief die Seite durch dieselbe
 * Grenze von fünf Treffern je Bereich wie die Vorschau. Jetzt zeigt die
 * Übersicht zehn je Bereich mit einem Link „Weitere …", und ein gewählter
 * Bereich blättert in Seiten zu 25 (`?bereich=…&seite=…`).
 *
 * **Und mit Kontingent.** Die Seite ruft den Dienst direkt auf, nicht über
 * `/api/search` — und lief damit an jedem Rate-Limit vorbei. Sie zählt jetzt
 * auf denselben Zähler wie der Endpunkt (`search`, je Person).
 */
export default async function SearchPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const session = await requirePermission('dashboard:view');
  const params = await searchParams;
  const q = (params.q ?? '').trim().slice(0, 80);
  const bereich = params.bereich?.trim() || undefined;
  const seite = Math.max(1, Math.min(1000, Number.parseInt(params.seite ?? '1', 10) || 1));

  let ergebnis: SuchErgebnis | null = null;
  let gebremstSekunden = 0;
  if (q.length >= 2) {
    const kontingent = await checkRateLimit('search', session.id);
    if (!kontingent.success) {
      gebremstSekunden = kontingent.retryAfter;
    } else {
      ergebnis = await globaleSuche({
        organizationId: await getOrganizationId(),
        session,
        q,
        bereich,
        seite,
        jeBereich: bereich ? SEITE_JE_BEREICH : UEBERSICHT_JE_BEREICH,
      });
    }
  }

  const gruppen = new Map<string, Treffer[]>();
  for (const t of ergebnis?.treffer ?? []) gruppen.set(t.art, [...(gruppen.get(t.art) ?? []), t]);
  const adresse = (extra: Record<string, string | number>) =>
    `/admin/suche?${new URLSearchParams({ q, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])) }).toString()}`;

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

      {bereich && q ? (
        <p className="text-sm">
          <Link href={adresse({})} className="font-medium text-primary hover:underline">
            ← Alle Bereiche
          </Link>
        </p>
      ) : null}

      {gebremstSekunden > 0 ? (
        <Alert variant="warning" title="Zu viele Suchen">
          Bitte in {gebremstSekunden} Sekunden erneut versuchen. Die Grenze gilt je Person und Minute.
        </Alert>
      ) : null}

      {ergebnis?.hinweis ? (
        <Alert variant="warning" title="Etikett">
          <span className="inline-flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {ergebnis.hinweis}
          </span>
        </Alert>
      ) : null}

      {ergebnis === null ? null : ergebnis.treffer.length === 0 ? (
        <EmptyState icon={<Search aria-hidden />} title="Nichts gefunden" description={seite > 1 ? `Keine weiteren Treffer für „${q}".` : `Kein Treffer für „${q}".`} />
      ) : (
        [...gruppen.entries()].map(([art, treffer]) => {
          const mehr = ergebnis!.mehr.includes(art);
          return (
            <DetailSection key={art} title={bereich ? `${art} — Seite ${seite}` : art} body="flush">
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
              {bereich ? (
                <nav aria-label={`Seiten für ${art}`} className="flex items-center justify-between border-t border-border px-6 py-2.5 text-sm">
                  {seite > 1 ? (
                    <Link href={adresse({ bereich, seite: seite - 1 })} className="font-medium text-primary hover:underline">
                      Vorherige Seite
                    </Link>
                  ) : (
                    <span />
                  )}
                  {mehr ? (
                    <Link href={adresse({ bereich, seite: seite + 1 })} className="font-medium text-primary hover:underline">
                      Nächste Seite
                    </Link>
                  ) : null}
                </nav>
              ) : mehr ? (
                <div className="border-t border-border px-6 py-2.5 text-sm">
                  <Link href={adresse({ bereich: art, seite: 1 })} className="font-medium text-primary hover:underline">
                    Weitere Treffer in „{art}“
                  </Link>
                </div>
              ) : null}
            </DetailSection>
          );
        })
      )}
    </div>
  );
}
