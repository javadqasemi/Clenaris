import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, KeyRound, MapPin, Navigation, Phone, StickyNote } from 'lucide-react';

import { requireEmployeeId } from '@/lib/auth/session';
import { NotFoundError } from '@/lib/errors';
import { formatDateLong, formatDuration, formatPhone, timeRangeLabel } from '@/lib/utils';
import { navigationUrl } from '@/lib/maps/google';
import { getOrganizationId } from '@/server/services/organization.service';
import { getJobDetail } from '@/server/services/job.service';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, PersonAvatar } from '@/components/ui/primitives';
import { PageHeader } from '@/components/app/page-parts';
import { TimeClock } from '@/features/portal/time-clock';
import { JobWorkspace } from '@/features/portal/job-workspace';

export const metadata: Metadata = {
  title: 'Einsatz',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function PortalJobPage({ params }: { params: Promise<{ id: string }> }) {
  const { session, employeeId } = await requireEmployeeId();

  const { id } = await params;
  const organizationId = await getOrganizationId();

  // Mitarbeitende sehen nur zugeteilte Einsätze; Disponierende alle.
  const job = await getJobDetail({
    organizationId,
    jobId: id,
    employeeId: session.role === 'EMPLOYEE' ? employeeId : undefined,
  }).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });

  const address = job.address
    ? `${job.address.street} ${job.address.streetNo ?? ''}, ${job.address.postalCode} ${job.address.city}`.replace(
        /\s+/g,
        ' ',
      )
    : null;

  const activeEntry = job.timeEntries.find(
    (entry) => entry.employeeId === employeeId && !entry.endedAt,
  );

  const isAssigned = job.assignments.some((assignment) => assignment.employeeId === employeeId);

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/portal/einsaetze">
          <ArrowLeft aria-hidden />
          Meine Einsätze
        </Link>
      </Button>

      <PageHeader title={job.title} description={`Auftrag ${job.number}`}>
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={job.status} />
          <span className="text-sm text-muted-foreground">
            {formatDateLong(job.scheduledStart)} ·{' '}
            {timeRangeLabel(job.scheduledStart, job.scheduledEnd)} Uhr ·{' '}
            {formatDuration(job.estimatedMin)}
          </span>
        </div>
      </PageHeader>

      {/* Adresse und Navigation zuerst — das braucht man auf dem Weg. */}
      {address ? (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-card p-5">
          <div className="flex items-start gap-3">
            <MapPin className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
            <div>
              <p className="font-medium">{address}</p>
              {job.property?.floor !== undefined && job.property?.floor !== null ? (
                <p className="text-sm text-muted-foreground">
                  {job.property.floor}. Stock
                  {job.property.hasElevator ? ' · Lift vorhanden' : ' · kein Lift'}
                </p>
              ) : null}
            </div>
          </div>

          <div className="flex gap-2">
            {job.customer.phone ? (
              <Button asChild variant="outline">
                <a href={`tel:${job.customer.phone}`}>
                  <Phone aria-hidden />
                  {formatPhone(job.customer.phone)}
                </a>
              </Button>
            ) : null}
            <Button asChild>
              <a href={navigationUrl(address)} target="_blank" rel="noreferrer">
                <Navigation aria-hidden />
                Navigation
              </a>
            </Button>
          </div>
        </div>
      ) : null}

      {/* Zugangshinweise */}
      {job.internalNote || job.property?.keyLocation || job.property?.parkingInfo ? (
        <Alert variant="info" title="Zugang und Hinweise">
          <ul className="space-y-1.5">
            {job.property?.keyLocation ? (
              <li className="flex items-start gap-2">
                <KeyRound className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {job.property.keyLocation}
              </li>
            ) : null}
            {job.property?.parkingInfo ? (
              <li className="flex items-start gap-2">
                <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {job.property.parkingInfo}
              </li>
            ) : null}
            {job.internalNote ? (
              <li className="flex items-start gap-2">
                <StickyNote className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span className="whitespace-pre-line">{job.internalNote}</span>
              </li>
            ) : null}
          </ul>
        </Alert>
      ) : null}

      {/* Wunsch der Kundschaft */}
      {job.customerNote ? (
        <div className="rounded-2xl border border-border bg-surface p-5">
          <h2 className="mb-2 font-display text-sm font-semibold">Anmerkung der Kundschaft</h2>
          <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
            {job.customerNote}
          </p>
        </div>
      ) : null}

      {/* Zeiterfassung */}
      {isAssigned && !['COMPLETED', 'VERIFIED', 'CANCELLED'].includes(job.status) ? (
        <TimeClock
          jobId={job.id}
          activeEntry={
            activeEntry ? { id: activeEntry.id, startedAt: activeEntry.startedAt.toISOString() } : null
          }
        />
      ) : null}

      {/* Team */}
      {job.assignments.length > 1 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-card p-4">
          <span className="text-sm text-muted-foreground">Heute mit dir im Einsatz:</span>
          {job.assignments
            .filter((assignment) => assignment.employeeId !== employeeId)
            .map((assignment) => (
              <span key={assignment.id} className="flex items-center gap-2">
                <PersonAvatar
                  firstName={assignment.employee.user.firstName}
                  lastName={assignment.employee.user.lastName}
                  src={assignment.employee.user.avatarUrl}
                  color={assignment.employee.color}
                  size="sm"
                />
                <span className="text-sm font-medium">
                  {assignment.employee.user.firstName} {assignment.employee.user.lastName}
                </span>
                {assignment.employee.user.phone ? (
                  <a
                    href={`tel:${assignment.employee.user.phone}`}
                    className="text-muted-foreground transition-colors hover:text-foreground"
                    aria-label={`${assignment.employee.user.firstName} anrufen`}
                  >
                    <Phone className="size-3.5" aria-hidden />
                  </a>
                ) : null}
              </span>
            ))}
        </div>
      ) : null}

      {/* Checkliste, Fotos, Abschluss */}
      <JobWorkspace
        jobId={job.id}
        status={job.status}
        canComplete={isAssigned}
        checklist={job.checklist.map((item) => ({
          id: item.id,
          label: item.label,
          room: item.room,
          required: item.required,
          done: item.done,
          note: item.note,
        }))}
        photos={job.photos.map((photo) => ({
          id: photo.id,
          type: photo.type,
          url: photo.url,
          thumbnailUrl: photo.thumbnailUrl,
          caption: photo.caption,
          room: photo.room,
        }))}
      />
    </div>
  );
}
