import type { Metadata } from 'next';
import Link from 'next/link';
import { ClipboardCheck } from 'lucide-react';

import { toNumber } from '@/lib/db';
import { requireCustomerId, requirePermission } from '@/lib/auth/session';
import { formatDate } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { KUNDENSICHTBARE_VERTRAGSZUSTAENDE } from '@/server/services/contract.service';
import { listCustomerInspections } from '@/server/services/quality.service';
import { StatusBadge } from '@/components/ui/badge';
import { EmptyState, ListCard, PageHeader, Pagination } from '@/components/app/page-parts';

export const metadata: Metadata = {
  title: 'Qualitätskontrollen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Die Qualitätskontrollen der eigenen Objekte (L-18, 2026-09-28) — nur lesend.
 *
 * Die Kundschaft hält `quality:read_own`, weil eine zugesagte Qualität, deren
 * Messung sie nicht sehen darf, eine Zusage an niemanden ist (`rbac.ts`). Bis
 * hierher war die Messung nur über die Schnittstelle lesbar.
 *
 * **Die Sichtregel ist die der Schnittstelle** (`qualityVisibilityWhere` über
 * `listCustomerInspections`): eigene Objekte oder Verträge, nur abgeschlossene
 * Begehungen. Ein Entwurf ist eine Momentaufnahme, die sich noch ändert — die
 * Kundschaft soll kein Urteil lesen, das morgen anders lautet. Die interne
 * Notiz lädt die Abfrage nicht.
 *
 * Keine Detailseite: Die Liste zeigt bereits alles, was die Kundschaft von
 * einer Begehung erfahren soll — Tag, Objekt, Ergebnis, Zielwert, Bemerkung.
 * Die Einzelpositionen sind das Arbeitsblatt der Prüfperson; eine Seite nur
 * für sie wäre ein zweiter Weg, dessen Feldauswahl ebenfalls gepflegt werden
 * müsste.
 */
export default async function AccountQualityPage({
  searchParams,
}: {
  searchParams: Promise<{ seite?: string }>;
}) {
  await requirePermission('quality:read_own');
  const { customerId } = await requireCustomerId();
  const params = await searchParams;
  const organizationId = await getOrganizationId();

  const page = Math.max(1, Number(params.seite) || 1);
  const perPage = 20;

  const { items, total } = await listCustomerInspections({ organizationId, customerId, page, perPage });
  const totalPages = Math.max(1, Math.ceil(total / perPage));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Qualitätskontrollen"
        description="Die Ergebnisse unserer Kontrollen bei Ihren Objekten, gemessen am vereinbarten Zielwert."
      />

      {items.length === 0 ? (
        <EmptyState
          icon={<ClipboardCheck aria-hidden />}
          title="Noch keine Kontrollen"
          description="Nach der ersten abgeschlossenen Qualitätskontrolle bei Ihnen finden Sie das Ergebnis hier. Etwas war nicht in Ordnung? Melden Sie es direkt."
          action={{ href: '/konto/reklamationen', label: 'Reklamation melden' }}
        />
      ) : (
        <ListCard
          footer={
            <Pagination page={page} totalPages={totalPages} total={total} baseHref="/konto/qualitaet" />
          }
        >
          <ul className="divide-y divide-border">
            {items.map((begehung) => {
              /*
                Den Vertrag nur nennen und verlinken, wenn die Kundschaft ihn
                unter „Verträge" auch findet — sonst führte der Link auf eine
                404 oder nennte den Titel eines internen Entwurfs.
              */
              const vertrag =
                begehung.contract && KUNDENSICHTBARE_VERTRAGSZUSTAENDE.includes(begehung.contract.status)
                  ? begehung.contract
                  : null;
              return (
                <li
                  key={begehung.id}
                  className="grid gap-3 p-5 sm:grid-cols-[minmax(0,1fr)_9rem_10rem] sm:items-start sm:gap-4"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="font-medium tabular-nums">
                      {formatDate(begehung.inspectedAt)}
                      {begehung.number ? (
                        <span className="text-muted-foreground"> · {begehung.number}</span>
                      ) : null}
                    </p>
                    <p className="text-meta text-muted-foreground">
                      {begehung.property?.label ?? 'Ohne Objektangabe'}
                      {vertrag ? (
                        <>
                          {' · '}
                          <Link
                            href={`/konto/vertraege/${vertrag.id}`}
                            className="text-primary underline-offset-4 hover:underline"
                          >
                            {vertrag.number ?? vertrag.title}
                          </Link>
                        </>
                      ) : null}
                    </p>
                    {begehung.note ? (
                      <p className="whitespace-pre-line text-sm leading-relaxed">{begehung.note}</p>
                    ) : null}
                  </div>

                  <div className="text-sm tabular-nums sm:text-right">
                    <p className="font-semibold">
                      {begehung.scorePercent === null
                        ? 'nicht beurteilbar'
                        : `${toNumber(begehung.scorePercent)} %`}
                    </p>
                    {begehung.targetScore !== null ? (
                      <p className="text-meta text-muted-foreground">Ziel {begehung.targetScore} %</p>
                    ) : null}
                  </div>

                  <div className="min-w-0">
                    <StatusBadge status={begehung.outcome} />
                  </div>
                </li>
              );
            })}
          </ul>
        </ListCard>
      )}
    </div>
  );
}
