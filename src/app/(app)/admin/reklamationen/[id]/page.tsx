import type { Metadata } from 'next';
import Link from 'next/link';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { formatDate, formatDateTime } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { STATUS_BESCHRIFTUNG, getComplaint } from '@/server/services/complaint.service';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/primitives';
import { DetailRow, DetailSection, PageHeader } from '@/components/app/page-parts';
import { ActionButton } from '@/components/app/action-button';
import { FormDialog } from '@/components/app/resource-form';
import { ART_OPTIONEN, KANAL_OPTIONEN, LABEL, SCHWERE_OPTIONEN, correctiveActionFields } from '@/features/admin/betrieb-fields';

export const metadata: Metadata = {
  title: 'Reklamation',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

type Aktion = { action: 'ACKNOWLEDGE' | 'START' | 'RESOLVE' | 'CLOSE' | 'REJECT' | 'REOPEN'; label: string; mitText?: boolean };

const AKTIONEN: Record<string, Aktion[]> = {
  OPEN: [
    { action: 'ACKNOWLEDGE', label: 'Bestätigen' },
    { action: 'START', label: 'In Bearbeitung' },
    { action: 'RESOLVE', label: 'Erledigt', mitText: true },
    { action: 'REJECT', label: 'Ablehnen', mitText: true },
  ],
  ACKNOWLEDGED: [
    { action: 'START', label: 'In Bearbeitung' },
    { action: 'RESOLVE', label: 'Erledigt', mitText: true },
    { action: 'REJECT', label: 'Ablehnen', mitText: true },
  ],
  IN_PROGRESS: [
    { action: 'RESOLVE', label: 'Erledigt', mitText: true },
    { action: 'REJECT', label: 'Ablehnen', mitText: true },
  ],
  RESOLVED: [
    { action: 'CLOSE', label: 'Abschliessen' },
    { action: 'REOPEN', label: 'Wieder öffnen' },
  ],
};

/**
 * Eine Reklamation: Stand, Frist, Beteiligte, Schritte. Die Frist ist aus
 * der Vertragsfassung am Meldetag gerechnet und hier nicht änderbar.
 */
export default async function ComplaintDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('complaint:read');
  const { id } = await params;
  const c = await getComplaint({ organizationId: await getOrganizationId(), id });
  const darf = can(session.role, 'complaint:update');

  return (
    <div className="space-y-8">
      <PageHeader
        title={`${c.number} — ${c.title}`}
        description={`${LABEL(ART_OPTIONEN)[c.kind]} · ${LABEL(SCHWERE_OPTIONEN)[c.severity]} · über ${LABEL(KANAL_OPTIONEN)[c.channel]}`}
        actions={
          darf ? (
            <>
              {(AKTIONEN[c.status] ?? []).map((a) => (
                <ActionButton
                  key={a.action}
                  endpoint={`/api/complaints/${c.id}/transition`}
                  body={{ action: a.action }}
                  label={a.label}
                  confirm={a.mitText ? 'Die Begründung ist für die Kundschaft sichtbar.' : undefined}
                  withNote={a.mitText}
                  noteField="resolution"
                  noteLabel="Was wurde getan bzw. warum wird abgelehnt?"
                  variant={a.action === 'REJECT' ? 'outline' : 'default'}
                  size="sm"
                />
              ))}
            </>
          ) : null
        }
      />

      {c.frist === 'VERPASST' ? <Alert variant="warning">Die zugesagte Reaktionszeit wurde nicht eingehalten.</Alert> : null}

      <DetailSection title="Stand" body="list">
        <DetailRow label="Status">
          <Badge variant="outline">{STATUS_BESCHRIFTUNG[c.status]}</Badge>
        </DetailRow>
        <DetailRow label="Gemeldet">{formatDateTime(c.reportedAt)}</DetailRow>
        <DetailRow label="Zugesagte Reaktion">
          {c.responseHours ? `${c.responseHours} Stunden — bis ${formatDateTime(c.responseDueAt!)}` : 'Keine vertragliche Zusage'}
        </DetailRow>
        <DetailRow label="Reagiert">{c.acknowledgedAt ? formatDateTime(c.acknowledgedAt) : '—'}</DetailRow>
        {c.resolvedAt ? <DetailRow label="Erledigt">{formatDateTime(c.resolvedAt)}</DetailRow> : null}
        {c.resolution ? <DetailRow label="Antwort an die Kundschaft">{c.resolution}</DetailRow> : null}
      </DetailSection>

      <DetailSection title="Meldung" body="list">
        <DetailRow label="Kundschaft">
          <Link href={`/admin/kunden/${c.customer.id}`} className="hover:text-primary">
            {c.customer.companyName ?? `${c.customer.firstName ?? ''} ${c.customer.lastName ?? ''}`} ({c.customer.number})
          </Link>
        </DetailRow>
        {c.property ? <DetailRow label="Objekt">{c.property.label}</DetailRow> : null}
        {c.contract ? (
          <DetailRow label="Vertrag">
            <Link href={`/admin/vertraege/${c.contract.id}`} className="hover:text-primary">
              {c.contract.number ?? c.contract.title}
            </Link>
          </DetailRow>
        ) : null}
        {c.job ? <DetailRow label="Einsatz">{c.job.number}</DetailRow> : null}
        <DetailRow label="Zuständig">{c.assignee ? `${c.assignee.firstName} ${c.assignee.lastName}` : 'Niemand zugewiesen'}</DetailRow>
        <DetailRow label="Beschreibung">
          <span className="whitespace-pre-line">{c.description}</span>
        </DetailRow>
        {c.internalNote ? <DetailRow label="Interne Notiz">{c.internalNote}</DetailRow> : null}
      </DetailSection>

      <DetailSection
        title="Korrekturmassnahme"
        body="list"
        action={
          darf && !c.correctiveAction ? (
            <FormDialog
              title="Massnahme ableiten"
              description="Die Massnahme erscheint in den Massnahmen der Unternehmensführung."
              triggerLabel="Massnahme"
              triggerVariant="outline"
              triggerSize="sm"
              endpoint={`/api/complaints/${c.id}/corrective-action`}
              successMessage="Massnahme angelegt."
              fields={correctiveActionFields()}
            />
          ) : null
        }
      >
        {c.correctiveAction ? (
          <DetailRow label={c.correctiveAction.title}>
            {c.correctiveAction.completedAt ? `erledigt ${formatDate(c.correctiveAction.completedAt)}` : c.correctiveAction.dueOn ? `fällig ${formatDate(c.correctiveAction.dueOn)}` : 'offen'}
          </DetailRow>
        ) : (
          <DetailRow label="Massnahme">Keine abgeleitet.</DetailRow>
        )}
      </DetailSection>
    </div>
  );
}
