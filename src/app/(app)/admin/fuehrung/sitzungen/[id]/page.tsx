import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { NotFoundError } from '@/lib/errors';
import { formatDate, formatDateTime } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { getMeeting } from '@/server/services/meeting.service';
import { listObjectiveOptions, listStaffOptions } from '@/server/services/fuehrung-options.service';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DetailRow, DetailSection, PageHeader } from '@/components/app/page-parts';
import { Markdown } from '@/components/markdown';
import { ActionButton } from '@/features/fuehrung/action-button';
import { MeetingForm } from '@/features/fuehrung/meeting-form';

export const metadata: Metadata = {
  title: 'Sitzung',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function MeetingDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ bearbeiten?: string }> }) {
  const session = await requirePermission('meeting:read');
  const { id } = await params;
  const query = await searchParams;
  const organizationId = await getOrganizationId();
  const meeting = await getMeeting(organizationId, id).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const canEdit = can(session.role, 'meeting:update');
  const editing = canEdit && query.bearbeiten === '1';
  const [staff, objectives] = editing ? await Promise.all([listStaffOptions(organizationId), listObjectiveOptions(organizationId)]) : [[], []];

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/admin/fuehrung/sitzungen">
          <ArrowLeft aria-hidden />
          Alle Sitzungen
        </Link>
      </Button>

      <PageHeader
        title={meeting.title}
        description={`${formatDateTime(meeting.heldAt)}${meeting.location ? ` · ${meeting.location}` : ''}${meeting.objective ? ` · zu „${meeting.objective.title}"` : ''}`}
        actions={
          <>
            {canEdit ? (
              <Button asChild variant={editing ? 'ghost' : 'outline'}>
                <Link href={editing ? `/admin/fuehrung/sitzungen/${id}` : `/admin/fuehrung/sitzungen/${id}?bearbeiten=1`}>{editing ? 'Ansicht' : 'Bearbeiten'}</Link>
              </Button>
            ) : null}
            {can(session.role, 'meeting:delete') ? <ActionButton endpoint={`/api/bi/meetings/${id}`} method="DELETE" label="Löschen" confirm="Die Sitzung wandert in den Papierkorb; erzeugte Aufgaben bleiben." variant="ghost" redirectTo="/admin/fuehrung/sitzungen" /> : null}
          </>
        }
      />

      {editing ? (
        <div className="max-w-4xl">
          <MeetingForm
            mode="edit"
            meetingId={id}
            staff={staff}
            objectives={objectives}
            initial={{
              title: meeting.title,
              heldAt: meeting.heldAt.toISOString(),
              location: meeting.location,
              agenda: meeting.agenda,
              minutes: meeting.minutes,
              decisions: meeting.decisions,
              guestNames: meeting.guestNames,
              participantIds: meeting.participants.map((p) => p.userId),
              objectiveId: meeting.objectiveId,
            }}
          />
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="space-y-6">
            {meeting.agenda ? (
              <DetailSection title="Traktanden" body="form">
                <Markdown content={meeting.agenda} />
              </DetailSection>
            ) : null}
            {meeting.minutes ? (
              <DetailSection title="Protokoll" body="form">
                <Markdown content={meeting.minutes} />
              </DetailSection>
            ) : null}
            {meeting.decisions ? (
              <DetailSection title="Beschlüsse" body="form">
                <Markdown content={meeting.decisions} />
              </DetailSection>
            ) : null}
            <DetailSection title="Pendenzen" description="Als Aufgaben angelegt — Frist, Zuständigkeit und Erinnerung wie überall." body="flush">
              {meeting.tasks.length === 0 ? (
                <p className="px-6 py-8 text-center text-sm text-muted-foreground">Keine Pendenzen.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {meeting.tasks.map((t) => (
                    <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-6 py-3 text-sm">
                      <span className={t.status === 'DONE' ? 'text-muted-foreground line-through' : 'font-medium'}>{t.title}</span>
                      <span className="flex items-center gap-2 text-muted-foreground">
                        {t.assignee ? `${t.assignee.firstName} ${t.assignee.lastName}` : 'Offen'}
                        {t.dueAt ? ` · ${formatDate(t.dueAt)}` : ''}
                        <StatusBadge status={t.status} size="sm" />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </DetailSection>
          </div>
          <DetailSection title="Teilnehmende" body="list">
            <dl className="protocol-list protocol-list--tight">
              <DetailRow label="Aus dem Team">{meeting.participants.length ? meeting.participants.map((p) => `${p.user.firstName} ${p.user.lastName}`).join(', ') : '—'}</DetailRow>
              {meeting.guestNames.length ? <DetailRow label="Gäste">{meeting.guestNames.join(', ')}</DetailRow> : null}
              <DetailRow label="Angelegt">{formatDateTime(meeting.createdAt)}</DetailRow>
            </dl>
          </DetailSection>
        </div>
      )}
    </div>
  );
}
