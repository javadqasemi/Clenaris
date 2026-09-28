import type { Metadata } from 'next';
import Link from 'next/link';
import { FileSignature } from 'lucide-react';

import { toNumber } from '@/lib/db';
import { requireCustomerId, requirePermission } from '@/lib/auth/session';
import { ABRECHNUNGSZYKLUS, preisText } from '@/lib/contracts/bezeichnungen';
import { formatDate } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { listCustomerContracts } from '@/server/services/contract.service';
import { StatusBadge } from '@/components/ui/badge';
import { EmptyState, ListCard, PageHeader, Pagination } from '@/components/app/page-parts';

export const metadata: Metadata = {
  title: 'Verträge',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Die eigenen Verträge im Kundenkonto (L-18, 2026-09-28).
 *
 * Die Kundschaft hält `contract:read_own` seit Wave 10 — gelesen werden
 * konnte es bis hierher nur über die Schnittstelle, die kein Mensch aufruft.
 * Ein Dauerschuldverhältnis, dessen Laufzeit und Preis die Kundschaft nicht
 * nachlesen kann, endet in einem Anruf.
 *
 * **Eigentum und Zustand stehen in der Abfrage** (`listCustomerContracts`):
 * `customerId` aus der Sitzung, `organizationId`, und nur Zustände, die der
 * Kundschaft zugegangen sind. Entwürfe werden nicht geladen und dann
 * weggefiltert, sondern gar nicht gefunden — sonst stimmte die Gesamtzahl der
 * Blätterung nicht, und die Rechnungsliste zeigt, wie leicht das passiert.
 *
 * `requirePermission` vor `requireCustomerId`: Die Seite liest ein Recht, und
 * die vier Ebenen (Middleware, Navigation, Seite, Abfrage) sollen dasselbe Recht
 * nennen. Wird es der Kundschaft einmal entzogen, verschwindet der
 * Navigationseintrag, und die Seite folgt, statt weiter Verträge zu zeigen.
 */
export default async function AccountContractsPage({
  searchParams,
}: {
  searchParams: Promise<{ seite?: string }>;
}) {
  await requirePermission('contract:read_own');
  const { customerId } = await requireCustomerId();
  const params = await searchParams;
  const organizationId = await getOrganizationId();

  const page = Math.max(1, Number(params.seite) || 1);
  const perPage = 20;

  const { gesamt, zeilen } = await listCustomerContracts({ organizationId, customerId, page, perPage });
  const totalPages = Math.max(1, Math.ceil(gesamt / perPage));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Verträge"
        description="Ihre laufenden und abgeschlossenen Verträge mit Laufzeit, Leistungen und Konditionen."
      />

      {zeilen.length === 0 ? (
        <EmptyState
          icon={<FileSignature aria-hidden />}
          title="Keine Verträge"
          description="Sobald wir mit Ihnen eine regelmässige Reinigung vereinbaren, finden Sie den Vertrag hier."
          action={{ href: '/konto/nachrichten', label: 'Nachricht schreiben' }}
        />
      ) : (
        <ListCard
          footer={
            <Pagination page={page} totalPages={totalPages} total={gesamt} baseHref="/konto/vertraege" />
          }
        >
          {/*
            Dasselbe feste Raster wie die Rechnungsliste: Preis und Status
            fluchten von Zeile zu Zeile, unter `sm` wird gestapelt.
          */}
          <ul className="divide-y divide-border">
            {zeilen.map((vertrag) => {
              const fassung = vertrag.versions[0];
              return (
                <li
                  key={vertrag.id}
                  className="grid gap-3 p-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_8rem] sm:items-center sm:gap-4"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/konto/vertraege/${vertrag.id}`}
                      className="font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {vertrag.title}
                    </Link>
                    <p className="text-meta tabular-nums text-muted-foreground">
                      {vertrag.number ? `${vertrag.number} · ` : ''}
                      ab {formatDate(vertrag.startDate)}
                      {vertrag.endDate ? ` bis ${formatDate(vertrag.endDate)}` : ' · unbefristet'}
                      {vertrag.property ? ` · ${vertrag.property.label}` : ''}
                    </p>
                  </div>

                  <div className="min-w-0 text-sm sm:text-right">
                    {fassung ? (
                      <>
                        <p className="tabular-nums">
                          {preisText({
                            pricingModel: fassung.pricingModel,
                            currency: fassung.currency,
                            baseAmount: toNumber(fassung.baseAmount),
                            hourlyRate: toNumber(fassung.hourlyRate),
                            unitPrice: toNumber(fassung.unitPrice),
                            unitLabel: fassung.unitLabel,
                            vatRate: toNumber(fassung.vatRate),
                          })}
                        </p>
                        <p className="text-meta text-muted-foreground">
                          Abrechnung {(ABRECHNUNGSZYKLUS[fassung.billingCycle] ?? fassung.billingCycle).toLowerCase()}
                        </p>
                      </>
                    ) : (
                      /*
                        Angebot ohne geltende Fassung: Die Konditionen stehen im
                        Dokument, das zur Unterschrift vorliegt — hier einen
                        Entwurfspreis zu zeigen, hiesse etwas zuzusagen, das
                        noch nicht angenommen ist.
                      */
                      <p className="text-meta text-muted-foreground">Konditionen im Vertragsangebot</p>
                    )}
                  </div>

                  <div className="min-w-0">
                    <StatusBadge status={vertrag.status} />
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
