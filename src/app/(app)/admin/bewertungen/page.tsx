import type { Metadata } from 'next';
import { Star } from 'lucide-react';

import { prisma } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { formatDate } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTriggerUnderline } from '@/components/ui/controls';
import { Stars } from '@/components/marketing/sections';
import { KpiTile } from '@/components/app/kpi-tile';
import { EmptyState, PageHeader } from '@/components/app/page-parts';
import { ReviewModeration } from '@/features/admin/review-moderation';

export const metadata: Metadata = {
  title: 'Bewertungen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const SERVICE_LABELS: Record<string, string> = {
  RESIDENTIAL_CLEANING: 'Unterhaltsreinigung',
  MOVE_OUT_CLEANING: 'Umzugsreinigung',
  OFFICE_CLEANING: 'Büroreinigung',
  WINDOW_CLEANING: 'Fensterreinigung',
  CONSTRUCTION_CLEANING: 'Baureinigung',
  BUILDING_MAINTENANCE: 'Hauswartung',
  SPECIAL: 'Spezialauftrag',
};

export default async function ReviewsAdminPage() {
  const session = await requirePermission('review:read');
  const canModerate = can(session.role, 'review:moderate');
  const canDelete = can(session.role, 'review:delete');

  const organizationId = await getOrganizationId();

  const [pending, published, rejected, aggregate] = await Promise.all([
    prisma.review.findMany({
      where: { organizationId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      include: { customer: { select: { id: true, number: true } } },
    }),
    prisma.review.findMany({
      where: { organizationId, status: 'PUBLISHED' },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { customer: { select: { id: true, number: true } } },
    }),
    prisma.review.count({ where: { organizationId, status: 'REJECTED' } }),
    prisma.review.aggregate({
      where: { organizationId, status: 'PUBLISHED' },
      _avg: { rating: true },
      _count: true,
    }),
  ]);

  const unanswered = published.filter((review) => review.rating <= 3 && !review.reply);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bewertungen"
        description="Wir veröffentlichen alle echten Bewertungen — auch kritische. Ablehnen ist für Spam und Beleidigungen gedacht, nicht für schlechte Noten."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label="Durchschnitt"
          value={(aggregate._avg.rating ?? 0).toFixed(1)}
          hint={`aus ${aggregate._count} veröffentlichten`}
        />
        <KpiTile
          label="Zu prüfen"
          value={String(pending.length)}
          accent={pending.length > 0 ? 'warning' : undefined}
        />
        <KpiTile
          label="Ohne Antwort (≤ 3 Sterne)"
          value={String(unanswered.length)}
          hint="Eine Antwort zeigt, dass Kritik ankommt"
          accent={unanswered.length > 0 ? 'warning' : undefined}
        />
        <KpiTile label="Abgelehnt" value={String(rejected)} />
      </div>

      <Tabs defaultValue={pending.length > 0 ? 'offen' : 'veroeffentlicht'}>
        <TabsList variant="underline">
          <TabsTriggerUnderline value="offen">Zu prüfen ({pending.length})</TabsTriggerUnderline>
          <TabsTriggerUnderline value="veroeffentlicht">
            Veröffentlicht ({published.length})
          </TabsTriggerUnderline>
        </TabsList>

        <TabsContent value="offen">
          {pending.length === 0 ? (
            <EmptyState
              icon={<Star aria-hidden />}
              title="Nichts zu prüfen"
              description="Neue Bewertungen erscheinen hier, sobald Kundinnen und Kunden auf die Bewertungsanfrage antworten."
            />
          ) : (
            <ul className="space-y-4">
              {pending.map((review) => (
                <li key={review.id}>
                  <ReviewCardAdmin
                    review={review}
                    canModerate={canModerate}
                    canDelete={canDelete}
                    serviceLabel={
                      review.serviceKind ? SERVICE_LABELS[review.serviceKind] : undefined
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="veroeffentlicht">
          {published.length === 0 ? (
            <EmptyState
              icon={<Star aria-hidden />}
              title="Noch keine veröffentlichten Bewertungen"
              description="Nach jedem abgeschlossenen Einsatz fragen wir automatisch nach einer Rückmeldung."
            />
          ) : (
            <ul className="space-y-4">
              {published.map((review) => (
                <li key={review.id}>
                  <ReviewCardAdmin
                    review={review}
                    canModerate={canModerate}
                    canDelete={canDelete}
                    serviceLabel={
                      review.serviceKind ? SERVICE_LABELS[review.serviceKind] : undefined
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

type ReviewRow = Awaited<
  ReturnType<typeof prisma.review.findMany<{ include: { customer: { select: { id: true; number: true } } } }>>
>[number];

function ReviewCardAdmin({
  review,
  serviceLabel,
  canModerate,
  canDelete,
}: {
  review: ReviewRow;
  serviceLabel?: string;
  canModerate: boolean;
  canDelete: boolean;
}) {
  return (
    <article className="space-y-4 rounded-2xl border border-border bg-card p-5 shadow-soft">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <Stars rating={review.rating} />
          <p className="font-medium">{review.authorName}</p>
          <p className="text-sm text-muted-foreground">
            {formatDate(review.createdAt)}
            {review.customer ? ` · Kunde ${review.customer.number}` : ''}
            {serviceLabel ? ` · ${serviceLabel}` : ''}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {review.featured ? <Badge variant="accent">Hervorgehoben</Badge> : null}
          <Badge
            variant={
              review.status === 'PUBLISHED'
                ? 'success'
                : review.status === 'REJECTED'
                  ? 'destructive'
                  : 'warning'
            }
          >
            {review.status === 'PUBLISHED'
              ? 'Veröffentlicht'
              : review.status === 'REJECTED'
                ? 'Abgelehnt'
                : 'Zu prüfen'}
          </Badge>
        </div>
      </div>

      <div className="space-y-1.5">
        {review.title ? <p className="font-display font-semibold">{review.title}</p> : null}
        <p className="prose-measure leading-relaxed text-muted-foreground">{review.body}</p>
      </div>

      {review.reply ? (
        <div className="rounded-xl bg-muted/60 p-4">
          <p className="mb-1 text-xs font-medium">
            Ihre Antwort{review.repliedAt ? ` · ${formatDate(review.repliedAt)}` : ''}
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">{review.reply}</p>
        </div>
      ) : null}

      {canModerate || canDelete ? (
        <ReviewModeration
          reviewId={review.id}
          status={review.status}
          featured={review.featured}
          hasReply={Boolean(review.reply)}
          rating={review.rating}
          canDelete={canDelete}
        />
      ) : null}
    </article>
  );
}
