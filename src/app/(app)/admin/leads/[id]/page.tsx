import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, FileText, Mail, MapPin, Phone, UserCheck } from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { formatCurrency, formatDate, formatDateTime, formatPhone, fullName } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KpiTile } from '@/components/app/kpi-tile';
import { DetailRow, DetailSection, PageHeader } from '@/components/app/page-parts';
import { ActivityComposer } from '@/features/admin/activity-composer';

export const metadata: Metadata = {
  title: 'Lead',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const ACTIVITY_LABELS: Record<string, string> = {
  NOTE: 'Notiz',
  CALL: 'Telefonat',
  EMAIL: 'E-Mail',
  SMS: 'SMS',
  MEETING: 'Termin',
  TASK: 'Aufgabe',
  STATUS_CHANGE: 'Statuswechsel',
  FILE_UPLOAD: 'Datei',
  SYSTEM: 'System',
};

const SOURCE_LABELS: Record<string, string> = {
  WEBSITE: 'Website',
  PHONE: 'Telefon',
  EMAIL: 'E-Mail',
  REFERRAL: 'Empfehlung',
  GOOGLE_ADS: 'Google Ads',
  META_ADS: 'Meta Ads',
  SEO: 'Suchmaschine',
  WALK_IN: 'Laufkundschaft',
  PARTNER: 'Partner',
  OTHER: 'Anderes',
};

const SERVICE_LABELS: Record<string, string> = {
  OFFICE_CLEANING: 'Büroreinigung',
  MOVE_OUT_CLEANING: 'Umzugsreinigung',
  RESIDENTIAL_CLEANING: 'Wohnungsreinigung',
  WINDOW_CLEANING: 'Fensterreinigung',
  CONSTRUCTION_CLEANING: 'Baureinigung',
  BUILDING_MAINTENANCE: 'Hauswartung',
  SPECIAL: 'Spezialreinigung',
};

/**
 * Lead-Akte.
 *
 * Der Lead ist der Zustand *vor* der Kundschaft: eine Anfrage, die noch
 * niemandem etwas gekostet hat. Entsprechend steht hier nicht die Historie im
 * Vordergrund, sondern die nächste Handlung — Offerte schreiben, nachfassen,
 * oder als Kunde übernehmen.
 */
export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePermission('lead:read');

  const { id } = await params;
  const organizationId = await getOrganizationId();

  const lead = await prisma.lead.findFirst({
    where: { id, organizationId, deletedAt: null },
    include: {
      stage: true,
      owner: { include: { user: { select: { firstName: true, lastName: true } } } },
      customer: { select: { id: true, firstName: true, lastName: true, companyName: true } },
      tags: { include: { tag: true } },
      quotes: { orderBy: { createdAt: 'desc' } },
      tasks: {
        where: { status: { in: ['OPEN', 'IN_PROGRESS'] } },
        orderBy: { dueAt: 'asc' },
        include: { assignee: { select: { firstName: true, lastName: true } } },
      },
      activities: {
        orderBy: { occurredAt: 'desc' },
        take: 50,
        include: { author: { select: { firstName: true, lastName: true } } },
      },
    },
  });

  if (!lead) notFound();

  const name = fullName(lead.firstName, lead.lastName);
  const isOpen = !['WON', 'LOST'].includes(lead.status);

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/admin/leads">
          <ArrowLeft aria-hidden />
          Alle Leads
        </Link>
      </Button>

      <PageHeader
        title={lead.company ?? name}
        description={`${lead.number} · erfasst ${formatDate(lead.createdAt)} über ${SOURCE_LABELS[lead.source] ?? lead.source}`}
        actions={
          <>
            <StatusBadge status={lead.status} />
            {isOpen ? (
              <Button asChild>
                <Link href={`/admin/offerten/neu?lead=${lead.id}`}>
                  <FileText aria-hidden />
                  Offerte erstellen
                </Link>
              </Button>
            ) : null}
            {lead.customer ? (
              <Button asChild variant="outline">
                <Link href={`/admin/kunden/${lead.customer.id}`}>
                  <UserCheck aria-hidden />
                  Kundenakte
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label="Bewertung"
          value={`${lead.score}/100`}
          hint="von der KI aus Anfrage und Herkunft geschätzt"
        />
        <KpiTile
          label="Erwarteter Wert"
          value={lead.estimatedValue ? formatCurrency(toNumber(lead.estimatedValue)) : '—'}
        />
        <KpiTile label="Stufe" value={lead.stage?.name ?? 'Ohne Zuordnung'} />
        <KpiTile
          label="Nächste Aktion"
          value={lead.nextFollowUpAt ? formatDate(lead.nextFollowUpAt) : 'Keine geplant'}
          accent={
            lead.nextFollowUpAt && lead.nextFollowUpAt < new Date() ? 'warning' : 'neutral'
          }
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          {lead.message ? (
            <DetailSection title="Anfrage im Wortlaut">
              <p className="prose-measure whitespace-pre-wrap py-4 text-sm leading-relaxed">
                {lead.message}
              </p>
            </DetailSection>
          ) : null}

          <section className="space-y-4">
            <h2 className="font-display text-lg font-semibold tracking-tight">Verlauf</h2>
            <ActivityComposer leadId={lead.id} />

            {lead.activities.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-border px-5 py-8 text-center text-sm text-muted-foreground">
                Noch kein Kontakt festgehalten. Der erste Anruf entscheidet, ob aus der Anfrage
                ein Auftrag wird.
              </p>
            ) : (
              <ol className="protocol-list">
                {lead.activities.map((activity) => (
                  <li key={activity.id} className="protocol-row">
                    <span className="protocol-label">
                      {ACTIVITY_LABELS[activity.type] ?? activity.type}
                    </span>
                    <span className="protocol-value space-y-1">
                      <span className="block font-medium">{activity.subject}</span>
                      {activity.body ? (
                        <span className="block whitespace-pre-wrap text-sm text-muted-foreground">
                          {activity.body}
                        </span>
                      ) : null}
                      <span className="block text-xs text-muted-foreground">
                        {formatDateTime(activity.occurredAt)}
                        {activity.author
                          ? ` · ${fullName(activity.author.firstName, activity.author.lastName)}`
                          : ''}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <aside className="space-y-6">
          <DetailSection title="Kontakt">
            <dl className="protocol-list">
              <DetailRow label="Name">{name}</DetailRow>
              {lead.company ? <DetailRow label="Firma">{lead.company}</DetailRow> : null}
              <DetailRow label="E-Mail">
                <a
                  href={`mailto:${lead.email}`}
                  className="inline-flex items-center gap-1.5 text-primary underline-offset-4 hover:underline"
                >
                  <Mail className="size-3.5" aria-hidden />
                  {lead.email}
                </a>
              </DetailRow>
              {lead.phone ? (
                <DetailRow label="Telefon">
                  <a
                    href={`tel:${lead.phone}`}
                    className="inline-flex items-center gap-1.5 text-primary underline-offset-4 hover:underline"
                  >
                    <Phone className="size-3.5" aria-hidden />
                    {formatPhone(lead.phone)}
                  </a>
                </DetailRow>
              ) : null}
              {lead.street || lead.city ? (
                <DetailRow label="Adresse">
                  <span className="inline-flex items-start gap-1.5">
                    <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    <span>
                      {lead.street}
                      {lead.street ? <br /> : null}
                      {lead.postalCode} {lead.city}
                    </span>
                  </span>
                </DetailRow>
              ) : null}
              {lead.serviceKind ? (
                <DetailRow label="Leistung">
                  {SERVICE_LABELS[lead.serviceKind] ?? lead.serviceKind}
                </DetailRow>
              ) : null}
              <DetailRow label="Zuständig">
                {lead.owner
                  ? fullName(lead.owner.user.firstName, lead.owner.user.lastName)
                  : 'Niemand zugewiesen'}
              </DetailRow>
              {lead.lostReason ? (
                <DetailRow label="Verlustgrund">{lead.lostReason}</DetailRow>
              ) : null}
            </dl>
          </DetailSection>

          {lead.tags.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {lead.tags.map(({ tag }) => (
                <Badge key={tag.id} variant="neutral" style={{ borderColor: tag.color }}>
                  {tag.name}
                </Badge>
              ))}
            </div>
          ) : null}

          {(lead.utmSource || lead.referrerUrl || lead.landingPath) && (
            <DetailSection title="Herkunft">
              <dl className="protocol-list">
                {lead.utmSource ? (
                  <DetailRow label="Kampagne">
                    {[lead.utmSource, lead.utmMedium, lead.utmCampaign]
                      .filter(Boolean)
                      .join(' · ')}
                  </DetailRow>
                ) : null}
                {lead.landingPath ? (
                  <DetailRow label="Einstiegsseite">{lead.landingPath}</DetailRow>
                ) : null}
                {lead.referrerUrl ? (
                  <DetailRow label="Verweis">
                    <span className="break-all text-xs">{lead.referrerUrl}</span>
                  </DetailRow>
                ) : null}
              </dl>
            </DetailSection>
          )}

          {lead.quotes.length > 0 ? (
            <DetailSection title="Offerten">
              <dl className="protocol-list">
                {lead.quotes.map((quote) => (
                  <DetailRow key={quote.id} label={quote.number}>
                    <Link
                      href={`/admin/offerten/${quote.id}`}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {formatCurrency(toNumber(quote.grossTotal))}
                    </Link>{' '}
                    · <StatusBadge status={quote.status} />
                  </DetailRow>
                ))}
              </dl>
            </DetailSection>
          ) : null}

          {lead.tasks.length > 0 ? (
            <DetailSection title="Offene Aufgaben">
              <dl className="protocol-list">
                {lead.tasks.map((task) => (
                  <DetailRow
                    key={task.id}
                    label={task.dueAt ? formatDate(task.dueAt) : 'Ohne Termin'}
                  >
                    {task.title}
                    {task.assignee
                      ? ` · ${fullName(task.assignee.firstName, task.assignee.lastName)}`
                      : ''}
                  </DetailRow>
                ))}
              </dl>
            </DetailSection>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
