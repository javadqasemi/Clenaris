import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, Download, Mail, Phone, Users } from 'lucide-react';

import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { formatDate, formatPhone, fullName } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KpiTile } from '@/components/app/kpi-tile';
import { EmptyState, PageHeader } from '@/components/app/page-parts';
import { ApplicationStatusSelect } from '@/features/admin/application-actions';

export const metadata: Metadata = {
  title: 'Bewerbungen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const STATUS_META: Record<
  string,
  { label: string; variant: 'default' | 'success' | 'warning' | 'neutral' | 'destructive' }
> = {
  RECEIVED: { label: 'Eingegangen', variant: 'default' },
  SCREENING: { label: 'In Prüfung', variant: 'warning' },
  INTERVIEW: { label: 'Gespräch', variant: 'warning' },
  OFFER: { label: 'Angebot', variant: 'success' },
  HIRED: { label: 'Angestellt', variant: 'success' },
  REJECTED: { label: 'Abgesagt', variant: 'neutral' },
  WITHDRAWN: { label: 'Zurückgezogen', variant: 'neutral' },
};

/**
 * Bewerbungseingang.
 *
 * Gruppiert nach Stelle, nicht nach Datum: die Frage im Alltag lautet „wer
 * hat sich auf die Fensterreinigung beworben", nicht „was kam gestern".
 * Offene Bewerbungen stehen zuoberst, erledigte darunter.
 */
export default async function ApplicationsPage() {
  await requirePermission('application:read');
  const organizationId = await getOrganizationId();

  const postings = await prisma.jobPosting.findMany({
    where: { organizationId },
    orderBy: [{ status: 'asc' }, { publishedAt: 'desc' }],
    include: {
      applications: {
        orderBy: { createdAt: 'desc' },
        include: { files: { select: { id: true, filename: true, url: true } } },
      },
    },
  });

  const all = postings.flatMap((posting) => posting.applications);
  const open = all.filter(
    (application) => !['HIRED', 'REJECTED', 'WITHDRAWN'].includes(application.status),
  );
  const newThisWeek = all.filter(
    (application) => Date.now() - application.createdAt.getTime() < 7 * 86_400_000,
  );

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/admin/personal">
          <ArrowLeft aria-hidden />
          Personal
        </Link>
      </Button>

      <PageHeader
        title="Bewerbungen"
        description="Alle Eingänge zu den ausgeschriebenen Stellen. Der Status wandert mit dem Verfahren mit."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiTile label="Offene Verfahren" value={String(open.length)} />
        <KpiTile label="Neu diese Woche" value={String(newThisWeek.length)} />
        <KpiTile
          label="Offene Stellen"
          value={String(postings.filter((posting) => posting.status === 'PUBLISHED').length)}
        />
      </div>

      {all.length === 0 ? (
        <EmptyState
          icon={<Users aria-hidden />}
          title="Noch keine Bewerbungen"
          description="Sobald sich jemand auf eine ausgeschriebene Stelle bewirbt, erscheint die Bewerbung hier — mit Lebenslauf als Anhang."
          action={{ href: '/karriere', label: 'Stellenseite ansehen' }}
        />
      ) : (
        <div className="space-y-8">
          {postings
            .filter((posting) => posting.applications.length > 0)
            .map((posting) => (
              <section key={posting.id} className="space-y-4">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <h2 className="font-display text-lg font-semibold tracking-tight">
                    {posting.title}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {posting.location} · {posting.workloadFrom}–{posting.workloadTo} % ·{' '}
                    {posting.applications.length}{' '}
                    {posting.applications.length === 1 ? 'Bewerbung' : 'Bewerbungen'}
                  </p>
                </div>

                <ul className="space-y-3">
                  {posting.applications.map((application) => {
                    const meta = STATUS_META[application.status] ?? STATUS_META.RECEIVED;
                    const cv = application.files[0];

                    return (
                      <li
                        key={application.id}
                        className="space-y-3 rounded-2xl border border-border bg-card p-5 shadow-soft"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div className="min-w-0">
                            <p className="font-medium">
                              {fullName(application.firstName, application.lastName)}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              Eingegangen {formatDate(application.createdAt)}
                              {application.availableFrom
                                ? ` · verfügbar ab ${formatDate(application.availableFrom)}`
                                : ''}
                            </p>
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant={meta.variant} size="sm">
                              {meta.label}
                            </Badge>
                            <ApplicationStatusSelect
                              applicationId={application.id}
                              status={application.status}
                            />
                          </div>
                        </div>

                        {application.message ? (
                          <p className="prose-measure whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                            {application.message}
                          </p>
                        ) : null}

                        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                          <Button asChild variant="outline" size="sm">
                            <a href={`mailto:${application.email}`}>
                              <Mail aria-hidden />
                              {application.email}
                            </a>
                          </Button>
                          {application.phone ? (
                            <Button asChild variant="outline" size="sm">
                              <a href={`tel:${application.phone}`}>
                                <Phone aria-hidden />
                                {formatPhone(application.phone)}
                              </a>
                            </Button>
                          ) : null}
                          {cv ?? application.cvUrl ? (
                            <Button asChild variant="outline" size="sm">
                              <a href={cv?.url ?? application.cvUrl ?? '#'} download>
                                <Download aria-hidden />
                                {cv?.filename ?? 'Lebenslauf'}
                              </a>
                            </Button>
                          ) : null}
                        </div>

                        {application.internalNote ? (
                          <p className="rounded-xl bg-muted px-4 py-3 text-sm leading-relaxed">
                            {application.internalNote}
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
        </div>
      )}
    </div>
  );
}
