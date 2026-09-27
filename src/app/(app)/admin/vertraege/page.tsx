import type { Metadata } from 'next';
import Link from 'next/link';
import { FileSignature, Plus } from 'lucide-react';

import { can } from '@/lib/auth/rbac';
import { requirePermission } from '@/lib/auth/session';
import { plusTage, zuercherHeute } from '@/lib/contracts/serie';
import { prisma, toNumber } from '@/lib/db';
import type { Prisma } from '@/lib/db';
import { formatCurrency, formatDate, toQueryString } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FilterBar } from '@/components/app/filter-bar';
import { KpiTile } from '@/components/app/kpi-tile';
import {
  EmptyState,
  ListCard,
  PageHeader,
  Pagination,
  TableScroll,
} from '@/components/app/page-parts';

export const metadata: Metadata = {
  title: 'Verträge',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const STATUS_FILTER = [
  { value: 'DRAFT', label: 'Entwurf' },
  { value: 'IN_REVIEW', label: 'In Prüfung' },
  { value: 'OFFERED', label: 'Offeriert' },
  { value: 'ACTIVE', label: 'Aktiv' },
  { value: 'PAUSED', label: 'Pausiert' },
  { value: 'NOTICE_GIVEN', label: 'Gekündigt' },
  { value: 'ENDED', label: 'Beendet' },
  { value: 'CANCELLED', label: 'Storniert' },
];

/**
 * Die Sichten dieser Seite.
 *
 * Bewusst Filter über denselben Pfad statt eigener Unterseiten: Es ist
 * dieselbe Liste mit derselben Sortierung, und wer zwischen „Aktiv" und
 * „Verlängerungen" wechselt, will nicht eine andere Seite, sondern eine
 * andere Auswahl. Die Adresse bleibt teilbar.
 */
const SICHTEN = [
  { key: '', label: 'Alle' },
  { key: 'aktiv', label: 'Aktiv' },
  { key: 'entwuerfe', label: 'Entwürfe' },
  { key: 'fristen', label: 'Kündigungsfristen' },
  { key: 'enden', label: 'Laufen aus' },
  { key: 'aenderungen', label: 'Änderungen' },
] as const;

const KUENDIGUNGSFENSTER_TAGE = 60;

export default async function AdminContractsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requirePermission('contract:read');

  const params = await searchParams;
  const organizationId = await getOrganizationId();

  const page = Math.max(1, Number(params.seite) || 1);
  const pageSize = 25;
  const sicht = params.sicht ?? '';
  // Der Zürcher Tag, nicht der UTC-Tag (2026-09-27).
  const heute = zuercherHeute();
  const fenster = plusTage(heute, KUENDIGUNGSFENSTER_TAGE);

  const sichtWhere: Prisma.ContractWhereInput =
    sicht === 'aktiv'
      ? { status: { in: ['ACTIVE', 'PAUSED'] } }
      : sicht === 'entwuerfe'
        ? { status: { in: ['DRAFT', 'IN_REVIEW', 'OFFERED'] } }
        : sicht === 'fristen'
          ? { status: { in: ['ACTIVE', 'PAUSED'] }, noticeDeadline: { gte: heute, lte: fenster } }
          : sicht === 'enden'
            ? { endDate: { gte: heute, lte: fenster } }
            : sicht === 'aenderungen'
              ? { amendments: { some: { status: { in: ['DRAFT', 'REVIEW', 'APPROVED'] } } } }
              : {};

  const where: Prisma.ContractWhereInput = {
    organizationId,
    deletedAt: null,
    ...sichtWhere,
    ...(params.status ? { status: params.status as never } : {}),
    ...(params.q
      ? {
          OR: [
            { title: { contains: params.q, mode: 'insensitive' } },
            { number: { contains: params.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [total, items, aktive, offeneFristen, offeneAenderungen] = await Promise.all([
    prisma.contract.count({ where }),
    prisma.contract.findMany({
      where,
      orderBy: [{ startDate: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        startDate: true,
        endDate: true,
        noticeDeadline: true,
        customer: { select: { companyName: true, firstName: true, lastName: true } },
        versions: {
          where: { status: 'ACTIVE' },
          select: { baseAmount: true, currency: true, billingCycle: true, pricingModel: true },
        },
        _count: { select: { jobs: true } },
      },
    }),
    prisma.contract.count({ where: { organizationId, deletedAt: null, status: { in: ['ACTIVE', 'PAUSED'] } } }),
    prisma.contract.count({
      where: {
        organizationId,
        deletedAt: null,
        status: { in: ['ACTIVE', 'PAUSED'] },
        noticeDeadline: { gte: heute, lte: fenster },
      },
    }),
    prisma.contractAmendment.count({
      where: {
        status: { in: ['DRAFT', 'REVIEW', 'APPROVED'] },
        contract: { organizationId, deletedAt: null },
      },
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const baseHref = `/admin/vertraege${toQueryString({ q: params.q, status: params.status, sicht: params.sicht })}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Verträge"
        description="Der Ursprung wiederkehrender Leistungen: Aus einem aktiven Vertrag entstehen die Einsätze, aus den Einsätzen die Abrechnung."
        actions={
          can(session.role, 'contract:create') ? (
            <Button asChild>
              <Link href="/admin/vertraege/neu">
                <Plus aria-hidden />
                Vertrag anlegen
              </Link>
            </Button>
          ) : null
        }
      >
        <FilterBar
          searchPlaceholder="Nummer oder Bezeichnung …"
          filters={[{ param: 'status', label: 'Status', options: STATUS_FILTER }]}
        />
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiTile
          label="Laufende Verträge"
          value={String(aktive)}
          hint="Aktiv oder pausiert"
          href="/admin/vertraege?sicht=aktiv"
        />
        <KpiTile
          label={`Kündigungsfrist in ${KUENDIGUNGSFENSTER_TAGE} Tagen`}
          value={String(offeneFristen)}
          hint="Wer jetzt nicht entscheidet, verlängert"
          href="/admin/vertraege?sicht=fristen"
          accent={offeneFristen > 0 ? 'warning' : 'neutral'}
        />
        <KpiTile
          label="Offene Änderungsanträge"
          value={String(offeneAenderungen)}
          hint="Warten auf Prüfung oder Wirksamkeit"
          href="/admin/vertraege?sicht=aenderungen"
        />
      </div>

      {/*
        Die Sichten als Zeile von Verweisen, nicht als Registerkarten mit
        Zustand: Eine Auswahl, die in der Adresse steht, lässt sich
        weitergeben, als Lesezeichen ablegen und neu laden — und genau das tut
        man mit „welche Verträge laufen aus".
      */}
      <nav aria-label="Sichten" className="flex flex-wrap gap-2">
        {SICHTEN.map((eintrag) => {
          const aktiv = sicht === eintrag.key;
          return (
            <Link
              key={eintrag.key || 'alle'}
              href={`/admin/vertraege${toQueryString({ q: params.q, status: params.status, sicht: eintrag.key || undefined })}`}
              aria-current={aktiv ? 'page' : undefined}
              className={
                aktiv
                  ? 'rounded-full bg-primary/12 px-3 py-1.5 text-sm font-medium text-primary'
                  : 'rounded-full px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'
              }
            >
              {eintrag.label}
            </Link>
          );
        })}
      </nav>

      {items.length === 0 ? (
        <EmptyState
          icon={<FileSignature aria-hidden />}
          title="Keine Verträge gefunden"
          description="Ein Vertrag entsteht aus einer angenommenen Offerte — oder direkt, wenn die Vereinbarung ohne Offerte zustande kam."
          action={
            can(session.role, 'contract:create')
              ? { href: '/admin/vertraege/neu', label: 'Vertrag anlegen' }
              : undefined
          }
        />
      ) : (
        <ListCard
          footer={<Pagination page={page} totalPages={totalPages} total={total} baseHref={baseHref} />}
        >
          <TableScroll>
            <table className="data-table">
              <caption className="sr-only">Vertragsliste. {total} Einträge.</caption>
              <thead>
                <tr>
                  <th scope="col">Nummer</th>
                  <th scope="col">Bezeichnung</th>
                  <th scope="col">Kundschaft</th>
                  <th scope="col">Laufzeit</th>
                  <th scope="col">Frist</th>
                  <th scope="col" className="text-right">
                    Betrag
                  </th>
                  <th scope="col" className="text-right">
                    Einsätze
                  </th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((vertrag) => {
                  const geltend = vertrag.versions[0];
                  const kundschaft =
                    vertrag.customer.companyName ??
                    `${vertrag.customer.firstName} ${vertrag.customer.lastName}`;
                  const fristNaht =
                    vertrag.noticeDeadline !== null &&
                    vertrag.noticeDeadline >= heute &&
                    vertrag.noticeDeadline <= fenster;

                  return (
                    <tr key={vertrag.id}>
                      <td>
                        <Link
                          href={`/admin/vertraege/${vertrag.id}`}
                          className="font-medium tabular-nums text-primary underline-offset-4 hover:underline"
                        >
                          {vertrag.number ?? 'Entwurf'}
                        </Link>
                      </td>
                      <td className="max-w-[16rem] truncate">{vertrag.title}</td>
                      <td className="text-muted-foreground">{kundschaft}</td>
                      <td className="tabular-nums text-muted-foreground">
                        {formatDate(vertrag.startDate)}
                        {vertrag.endDate ? ` – ${formatDate(vertrag.endDate)}` : ' – unbefristet'}
                      </td>
                      <td
                        className={
                          fristNaht ? 'tabular-nums font-medium text-warning' : 'tabular-nums text-muted-foreground'
                        }
                      >
                        {vertrag.noticeDeadline ? formatDate(vertrag.noticeDeadline) : '—'}
                      </td>
                      <td className="num font-medium">
                        {geltend ? formatCurrency(toNumber(geltend.baseAmount)) : '—'}
                      </td>
                      <td className="num text-muted-foreground">{vertrag._count.jobs}</td>
                      <td>
                        <StatusBadge status={vertrag.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        </ListCard>
      )}
    </div>
  );
}
