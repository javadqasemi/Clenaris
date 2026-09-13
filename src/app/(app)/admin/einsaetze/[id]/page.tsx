import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  Check,
  Clock,
  Download,
  MapPin,
  Navigation,
  Package,
  X,
} from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
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
import { Progress } from '@/components/ui/primitives';
import { DetailRow, DetailSection, PageHeader } from '@/components/app/page-parts';
import { JobActions } from '@/features/admin/job-actions';
import { JobChecklistEditor } from '@/features/admin/job-checklist-editor';
import { JobTeamEditor } from '@/features/admin/job-team-editor';
import { JobCostingEditor } from '@/features/admin/job-costing-editor';
import { JobPhotos } from '@/features/admin/job-photos';

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
  const session = await requirePermission('job:read');

  const { id } = await params;
  const organizationId = await getOrganizationId();

  const job = await getJobDetail({ organizationId, jobId: id }).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });

  /**
   * Was diese Person auf dieser Seite darf.
   *
   * Bewusst hier gebündelt und nicht in den Komponenten verstreut: Wer wissen
   * will, welche Rolle was sieht, soll es an einer Stelle nachlesen können.
   * Die Komponenten bekommen nur noch Ja oder Nein — die verbindliche Prüfung
   * passiert ohnehin in jedem Endpunkt erneut.
   */
  const canEdit = can(session.role, 'job:update');
  const canAssign = can(session.role, 'job:assign');
  const canSeeFinancials = can(session.role, 'dashboard:financials');
  const closed = ['COMPLETED', 'VERIFIED', 'CANCELLED'].includes(job.status);

  // Für die Teamzuteilung: alle aktiven Mitarbeitenden zur Auswahl.
  const employees = canAssign
    ? await prisma.employee.findMany({
        where: { organizationId, active: true },
        orderBy: { user: { lastName: 'asc' } },
        select: {
          id: true,
          color: true,
          user: { select: { firstName: true, lastName: true, avatarUrl: true } },
        },
      })
    : [];

  const address = job.address
    ? `${job.address.street} ${job.address.streetNo ?? ''}, ${job.address.postalCode} ${job.address.city}`.replace(
        /\s+/g,
        ' ',
      )
    : null;

  const doneCount = job.checklist.filter((item) => item.done).length;
  const progress = job.checklist.length > 0 ? (doneCount / job.checklist.length) * 100 : 0;
  const workedMinutes = job.timeEntries.reduce((sum, entry) => sum + entry.minutes, 0);


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
            <JobActions
              jobId={job.id}
              status={job.status}
              canEdit={canEdit}
              canDelete={can(session.role, 'job:delete')}
            />
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
            {canEdit ? (
              <JobChecklistEditor
                jobId={job.id}
                readOnly={closed}
                items={job.checklist.map((item) => ({
                  id: item.id,
                  label: item.label,
                  room: item.room,
                  required: item.required,
                  done: item.done,
                }))}
              />
            ) : job.checklist.length === 0 ? (
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
          {/* Fotos */}
          <DetailSection title={`Fotos (${job.photos.length})`}>
            <JobPhotos
              jobId={job.id}
              readOnly={!canEdit}
              photos={job.photos.map((photo) => ({
                id: photo.id,
                type: photo.type,
                url: photo.url,
                thumbnailUrl: photo.thumbnailUrl,
                caption: photo.caption,
                room: photo.room,
              }))}
            />
          </DetailSection>

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
            <dl className="protocol-list protocol-list--tight">
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

          <DetailSection title={`Team (${job.assignments.length}/${job.crewSize})`}>
            <JobTeamEditor
              jobId={job.id}
              crewSize={job.crewSize}
              readOnly={!canAssign || ['COMPLETED', 'VERIFIED'].includes(job.status)}
              employees={
                // Im Lesemodus genügen die bereits zugeteilten Personen —
                // `employees` ist dann leer, weil die Abfrage übersprungen wurde.
                canAssign
                  ? employees.map((employee) => ({
                      id: employee.id,
                      firstName: employee.user.firstName,
                      lastName: employee.user.lastName,
                      color: employee.color,
                      avatarUrl: employee.user.avatarUrl,
                    }))
                  : job.assignments.map((assignment) => ({
                      id: assignment.employeeId,
                      firstName: assignment.employee.user.firstName,
                      lastName: assignment.employee.user.lastName,
                      color: assignment.employee.color,
                      avatarUrl: assignment.employee.user.avatarUrl,
                    }))
              }
              members={job.assignments.map((assignment) => ({
                employeeId: assignment.employeeId,
                role: assignment.role,
                state: assignment.acceptedAt
                  ? ('accepted' as const)
                  : assignment.declinedAt
                    ? ('declined' as const)
                    : ('open' as const),
              }))}
            />
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

          {/*
            Die Nachkalkulation erscheint nur für Rollen mit Finanzeinblick.
            Wer disponiert, muss nicht wissen, was ein Einsatz einbringt — und
            eine Zahl, die man sieht, aber nicht ändern darf, provoziert genau
            die Rückfrage, die sie ersparen sollte.
          */}
          {canSeeFinancials ? (
            <DetailSection title="Nachkalkulation">
              <JobCostingEditor
                jobId={job.id}
                status={job.status}
                revenue={toNumber(job.revenue)}
                laborCost={toNumber(job.laborCost)}
                materialCost={toNumber(job.materialCost)}
                trackedMinutes={workedMinutes}
              />
            </DetailSection>
          ) : null}

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
