import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  Camera,
  Check,
  Clock,
  Download,
  MapPin,
  Navigation,
  Package,
  X,
} from 'lucide-react';

import { toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { NotFoundError } from '@/lib/errors';
import {
  formatCurrency,
  formatDateLong,
  formatDateTime,
  formatDuration,
  formatPhone,
  timeRangeLabel,
} from '@/lib/utils';
import { navigationUrl } from '@/lib/maps/google';
import { getOrganizationId } from '@/server/services/organization.service';
import { getJobDetail } from '@/server/services/job.service';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PersonAvatar, Progress } from '@/components/ui/primitives';
import { DetailRow, DetailSection, PageHeader } from '@/components/app/page-parts';
import { JobActions } from '@/features/admin/job-actions';

export const metadata: Metadata = {
  title: 'Einsatz',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function AdminJobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePermission('job:read');

  const { id } = await params;
  const organizationId = await getOrganizationId();

  const job = await getJobDetail({ organizationId, jobId: id }).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });

  const address = job.address
    ? `${job.address.street} ${job.address.streetNo ?? ''}, ${job.address.postalCode} ${job.address.city}`.replace(
        /\s+/g,
        ' ',
      )
    : null;

  const doneCount = job.checklist.filter((item) => item.done).length;
  const progress = job.checklist.length > 0 ? (doneCount / job.checklist.length) * 100 : 0;
  const workedMinutes = job.timeEntries.reduce((sum, entry) => sum + entry.minutes, 0);

  const beforePhotos = job.photos.filter((photo) => photo.type === 'BEFORE');
  const afterPhotos = job.photos.filter((photo) => photo.type === 'AFTER');

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/admin/einsaetze">
          <ArrowLeft aria-hidden />
          Alle Einsätze
        </Link>
      </Button>

      <PageHeader
        title={`Einsatz ${job.number}`}
        description={job.title}
        actions={
          <>
            <StatusBadge status={job.status} className="self-center" />
            <Button asChild variant="outline">
              <a href={`/api/jobs/${job.id}/report`} download>
                <Download aria-hidden />
                Bericht (PDF)
              </a>
            </Button>
            <JobActions jobId={job.id} status={job.status} />
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <div className="space-y-6">
          <DetailSection title="Auftrag">
            <dl className="protocol-list">
              <DetailRow label="Termin">
                {formatDateLong(job.scheduledStart)}
                <span className="block text-muted-foreground">
                  {timeRangeLabel(job.scheduledStart, job.scheduledEnd)} Uhr · geplant{' '}
                  {formatDuration(job.estimatedMin)}
                </span>
              </DetailRow>
              {job.actualStart ? (
                <DetailRow label="Tatsächlich">
                  {formatDateTime(job.actualStart)}
                  {job.actualEnd ? ` – ${formatDateTime(job.actualEnd)}` : ' (läuft)'}
                  {workedMinutes > 0 ? (
                    <span className="block text-muted-foreground">
                      Erfasste Arbeitszeit: {formatDuration(workedMinutes)}
                    </span>
                  ) : null}
                </DetailRow>
              ) : null}
              <DetailRow label="Leistung">{job.service?.name ?? '—'}</DetailRow>
              {address ? (
                <DetailRow label="Adresse">
                  <span className="flex flex-wrap items-center gap-2">
                    <MapPin className="size-3.5 text-muted-foreground" aria-hidden />
                    {address}
                    <a
                      href={navigationUrl(address)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                    >
                      <Navigation className="size-3.5" aria-hidden />
                      Route
                    </a>
                  </span>
                </DetailRow>
              ) : null}
              {job.customerNote ? (
                <DetailRow label="Anmerkung der Kundschaft">
                  <span className="whitespace-pre-line">{job.customerNote}</span>
                </DetailRow>
              ) : null}
              {job.internalNote ? (
                <DetailRow label="Interne Notiz">
                  <span className="whitespace-pre-line">{job.internalNote}</span>
                </DetailRow>
              ) : null}
              {job.completionNote ? (
                <DetailRow label="Abschlussbericht">
                  <span className="whitespace-pre-line">{job.completionNote}</span>
                </DetailRow>
              ) : null}
            </dl>
          </DetailSection>

          {/* Checkliste */}
          <DetailSection
            title={`Checkliste (${doneCount}/${job.checklist.length})`}
            action={
              <div className="w-32">
                <Progress value={progress} aria-label={`${Math.round(progress)} % erledigt`} />
              </div>
            }
          >
            {job.checklist.length === 0 ? (
              <p className="py-6 text-sm text-muted-foreground">
                Für diesen Einsatz ist keine Checkliste hinterlegt.
              </p>
            ) : (
              <ul className="protocol-list">
                {job.checklist.map((item) => (
                  <li key={item.id} className="flex items-start gap-3 py-3">
                    <span
                      className={
                        item.done
                          ? 'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-success/15 text-success'
                          : 'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground'
                      }
                      aria-hidden
                    >
                      {item.done ? (
                        <Check className="size-3" strokeWidth={3} />
                      ) : (
                        <X className="size-3" strokeWidth={3} />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className={item.done ? 'text-sm' : 'text-sm text-muted-foreground'}>
                        {item.room ? <span className="font-medium">{item.room}: </span> : null}
                        {item.label}
                        {item.required ? null : (
                          <span className="ml-2 text-xs text-muted-foreground">(optional)</span>
                        )}
                      </p>
                      {item.note ? (
                        <p className="mt-0.5 text-xs text-muted-foreground">{item.note}</p>
                      ) : null}
                    </div>
                    <span className="sr-only">{item.done ? 'erledigt' : 'offen'}</span>
                  </li>
                ))}
              </ul>
            )}
          </DetailSection>

          {/* Fotos */}
          {job.photos.length > 0 ? (
            <DetailSection title={`Fotos (${job.photos.length})`}>
              <div className="space-y-6 py-4">
                {[
                  { label: 'Vorher', photos: beforePhotos },
                  { label: 'Nachher', photos: afterPhotos },
                  {
                    label: 'Weitere',
                    photos: job.photos.filter(
                      (photo) => photo.type !== 'BEFORE' && photo.type !== 'AFTER',
                    ),
                  },
                ]
                  .filter((group) => group.photos.length > 0)
                  .map((group) => (
                    <div key={group.label} className="space-y-3">
                      <h3 className="text-sm font-medium text-muted-foreground">
                        {group.label} ({group.photos.length})
                      </h3>
                      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        {group.photos.map((photo) => (
                          <li key={photo.id}>
                            <a
                              href={photo.url}
                              target="_blank"
                              rel="noreferrer"
                              className="block overflow-hidden rounded-xl border border-border transition-opacity hover:opacity-85"
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={photo.thumbnailUrl ?? photo.url}
                                alt={photo.caption ?? `${group.label}: ${photo.room ?? 'Aufnahme'}`}
                                className="aspect-square w-full object-cover"
                                loading="lazy"
                              />
                            </a>
                            {photo.room || photo.caption ? (
                              <p className="mt-1.5 truncate text-xs text-muted-foreground">
                                {photo.room ?? photo.caption}
                              </p>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
              </div>
            </DetailSection>
          ) : (
            <DetailSection title="Fotos">
              <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                <Camera className="size-4" aria-hidden />
                Das Team lädt Vorher-/Nachher-Fotos über das Mitarbeitendenportal hoch.
              </p>
            </DetailSection>
          )}

          {/* Material */}
          {job.materials.length > 0 ? (
            <DetailSection title="Verwendetes Material">
              <ul className="protocol-list">
                {job.materials.map((material) => (
                  <li key={material.id} className="flex items-center justify-between gap-4 py-3">
                    <span className="flex items-center gap-2 text-sm">
                      <Package className="size-4 text-muted-foreground" aria-hidden />
                      {material.name}
                      {material.billable ? (
                        <span className="text-xs text-primary">verrechenbar</span>
                      ) : null}
                    </span>
                    <span className="text-sm tabular-nums">
                      {toNumber(material.quantity)} {material.unit} ·{' '}
                      {formatCurrency(toNumber(material.total))}
                    </span>
                  </li>
                ))}
              </ul>
            </DetailSection>
          ) : null}
        </div>

        {/* Seitenspalte */}
        <div className="space-y-6">
          <DetailSection title="Kundschaft">
            <dl className="protocol-list">
              <DetailRow label="Name">
                <Link
                  href={`/admin/kunden/${job.customer.id}`}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  {job.customer.companyName ??
                    `${job.customer.firstName} ${job.customer.lastName}`}
                </Link>
              </DetailRow>
              {job.customer.phone ? (
                <DetailRow label="Telefon">
                  <a
                    href={`tel:${job.customer.phone}`}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {formatPhone(job.customer.phone)}
                  </a>
                </DetailRow>
              ) : null}
              {job.booking ? (
                <DetailRow label="Buchung">
                  <Link
                    href={`/admin/buchungen/${job.booking.id}`}
                    className="tabular-nums text-primary underline-offset-4 hover:underline"
                  >
                    {job.booking.number}
                  </Link>
                </DetailRow>
              ) : null}
            </dl>
          </DetailSection>

          <DetailSection title="Team">
            {job.assignments.length === 0 ? (
              <p className="py-6 text-sm text-warning">
                Noch niemand zugeteilt. Über den Kalender lässt sich das in wenigen Klicks erledigen.
              </p>
            ) : (
              <ul className="protocol-list">
                {job.assignments.map((assignment) => (
                  <li key={assignment.id} className="flex items-center gap-3 py-3">
                    <PersonAvatar
                      firstName={assignment.employee.user.firstName}
                      lastName={assignment.employee.user.lastName}
                      src={assignment.employee.user.avatarUrl}
                      color={assignment.employee.color}
                      size="sm"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {assignment.employee.user.firstName} {assignment.employee.user.lastName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {assignment.role === 'LEAD' ? 'Leitung' : 'Team'}
                        {assignment.acceptedAt
                          ? ' · zugesagt'
                          : assignment.declinedAt
                            ? ' · abgesagt'
                            : ' · offen'}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </DetailSection>

          {job.timeEntries.length > 0 ? (
            <DetailSection title="Zeiterfassung">
              <ul className="protocol-list">
                {job.timeEntries.map((entry) => (
                  <li key={entry.id} className="flex items-center justify-between gap-3 py-3">
                    <span className="flex items-center gap-2 text-sm">
                      <Clock className="size-3.5 text-muted-foreground" aria-hidden />
                      {entry.employee.user.firstName} {entry.employee.user.lastName}
                    </span>
                    <span className="text-sm tabular-nums text-muted-foreground">
                      {entry.endedAt ? formatDuration(entry.minutes) : 'läuft'}
                    </span>
                  </li>
                ))}
              </ul>
            </DetailSection>
          ) : null}

          <DetailSection title="Nachkalkulation">
            <dl className="protocol-list">
              <DetailRow label="Umsatz">{formatCurrency(toNumber(job.revenue))}</DetailRow>
              <DetailRow label="Lohnkosten">{formatCurrency(toNumber(job.laborCost))}</DetailRow>
              <DetailRow label="Material">{formatCurrency(toNumber(job.materialCost))}</DetailRow>
              <DetailRow label="Deckungsbeitrag">
                <span
                  className={
                    toNumber(job.revenue) - toNumber(job.laborCost) - toNumber(job.materialCost) >= 0
                      ? 'font-semibold text-success'
                      : 'font-semibold text-destructive'
                  }
                >
                  {formatCurrency(
                    toNumber(job.revenue) - toNumber(job.laborCost) - toNumber(job.materialCost),
                  )}
                </span>
              </DetailRow>
            </dl>
          </DetailSection>

          {job.gpsEvents.length > 0 ? (
            <DetailSection title="Stempelungen">
              <ul className="protocol-list">
                {job.gpsEvents.map((event) => (
                  <li key={event.id} className="flex items-center justify-between gap-3 py-3">
                    <span className="text-sm">
                      {event.type === 'CHECK_IN' ? 'Eingestempelt' : 'Ausgestempelt'}
                    </span>
                    <span className="text-right text-xs text-muted-foreground">
                      {formatDateTime(event.createdAt)}
                      {event.distanceM !== null ? (
                        <span
                          className={
                            event.distanceM > 500 ? 'block text-warning' : 'block text-muted-foreground'
                          }
                        >
                          {Math.round(event.distanceM)} m zur Adresse
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </DetailSection>
          ) : null}
        </div>
      </div>
    </div>
  );
}
