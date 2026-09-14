import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Download } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { NotFoundError } from '@/lib/errors';
import { formatBytes, formatDate, formatDateTime } from '@/lib/utils';
import { DOCUMENT_CATEGORY_LABELS, DOCUMENT_VISIBILITY_LABELS, optionsOf } from '@/lib/bi/labels';
import { getOrganizationId } from '@/server/services/organization.service';
import { getDocument } from '@/server/services/document.service';
import { listEmployeeOptions, listSupplierOptions } from '@/server/services/fuehrung-options.service';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import { DetailRow, DetailSection, PageHeader } from '@/components/app/page-parts';
import { ActionButton } from '@/features/fuehrung/action-button';
import { FormDialog } from '@/features/fuehrung/resource-form';
import { DocumentUploadDialog } from '@/features/fuehrung/document-upload';

export const metadata: Metadata = {
  title: 'Dokument',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function DocumentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission('document:read');
  const { id } = await params;
  const organizationId = await getOrganizationId();
  const document = await getDocument(session, organizationId, id).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const [employees, suppliers] = await Promise.all([listEmployeeOptions(organizationId), listSupplierOptions(organizationId)]);
  const canEdit = can(session.role, 'document:update');
  const expired = document.expiresOn && document.expiresOn < new Date();

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/admin/fuehrung/dokumente">
          <ArrowLeft aria-hidden />
          Alle Dokumente
        </Link>
      </Button>

      <PageHeader
        title={document.title}
        description={`${DOCUMENT_CATEGORY_LABELS[document.category]} · ${DOCUMENT_VISIBILITY_LABELS[document.visibility]}`}
        actions={
          <>
            {document.currentVersion ? (
              <Button asChild variant="default">
                <a href={`/api/bi/documents/${id}/download`}>
                  <Download aria-hidden />
                  Herunterladen
                </a>
              </Button>
            ) : null}
            {can(session.role, 'document:create') ? <DocumentUploadDialog mode="version" documentId={id} /> : null}
            {canEdit ? (
              <FormDialog
                title="Dokument bearbeiten"
                triggerLabel="Bearbeiten"
                triggerVariant="outline"
                plainTrigger
                endpoint={`/api/bi/documents/${id}`}
                method="PATCH"
                successMessage="Dokument gespeichert."
                fields={[
                  { name: 'title', label: 'Titel', required: true },
                  { name: 'category', label: 'Kategorie', type: 'select', required: true, half: true, options: optionsOf(DOCUMENT_CATEGORY_LABELS) },
                  { name: 'visibility', label: 'Sichtbarkeit', type: 'select', required: true, half: true, options: optionsOf(DOCUMENT_VISIBILITY_LABELS) },
                  { name: 'subjectEmployeeId', label: 'Betroffene Person', type: 'select', half: true, options: employees.map((e) => ({ value: e.id, label: e.name })), placeholder: 'Keine', nullable: true },
                  { name: 'supplierId', label: 'Lieferant', type: 'select', half: true, options: suppliers.map((s) => ({ value: s.id, label: s.name })), placeholder: 'Keiner', nullable: true },
                  { name: 'validFrom', label: 'Gültig ab', type: 'date', half: true, nullable: true },
                  { name: 'expiresOn', label: 'Läuft ab am', type: 'date', half: true, nullable: true },
                  { name: 'reminderDaysBefore', label: 'Erinnerung Tage vorher', type: 'number', half: true },
                  { name: 'tags', label: 'Schlagwörter', type: 'tags', half: true },
                  { name: 'description', label: 'Beschreibung', type: 'textarea', rows: 2, nullable: true },
                ]}
                values={{ title: document.title, category: document.category, visibility: document.visibility, subjectEmployeeId: document.subjectEmployeeId, supplierId: document.supplierId, validFrom: document.validFrom, expiresOn: document.expiresOn, reminderDaysBefore: document.reminderDaysBefore, tags: document.tags, description: document.description }}
              />
            ) : null}
            {can(session.role, 'document:delete') ? <ActionButton endpoint={`/api/bi/documents/${id}`} method="DELETE" label="Löschen" confirm="Das Dokument wandert in den Papierkorb; Fassungen bleiben im Speicher." variant="ghost" redirectTo="/admin/fuehrung/dokumente" /> : null}
          </>
        }
      />

      {expired ? <Alert variant="destructive" title="Abgelaufen">Dieses Dokument ist seit {formatDate(document.expiresOn!)} abgelaufen.</Alert> : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <DetailSection title="Fassungen" description="Die neueste Fassung gilt; ältere bleiben zum Nachweis erhalten." body="flush">
          {document.versions.length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-muted-foreground">Noch keine Datei — laden Sie die erste Fassung hoch.</p>
          ) : (
            <ul className="divide-y divide-border">
              {document.versions.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-3 text-sm">
                  <span className="min-w-0">
                    <span className="font-medium">Fassung {v.version}</span>
                    {v.id === document.currentVersionId ? <Badge size="sm" variant="success" className="ml-2">Geltend</Badge> : null}
                    <span className="block text-xs text-muted-foreground">
                      {v.file.filename} · {formatBytes(v.file.sizeBytes)} · {formatDateTime(v.createdAt)}
                      {v.changeNote ? ` · ${v.changeNote}` : ''}
                    </span>
                  </span>
                  <Button asChild variant="ghost" size="sm">
                    <a href={`/api/bi/documents/${id}/download?version=${v.version}`}>
                      <Download aria-hidden />
                      Öffnen
                    </a>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </DetailSection>

        <DetailSection title="Angaben" body="list">
          <dl className="protocol-list protocol-list--tight">
            <DetailRow label="Sichtbarkeit">{DOCUMENT_VISIBILITY_LABELS[document.visibility]}</DetailRow>
            {document.subjectEmployee ? <DetailRow label="Betroffene Person">{document.subjectEmployee.user.firstName} {document.subjectEmployee.user.lastName}</DetailRow> : null}
            {document.supplier ? <DetailRow label="Lieferant">{document.supplier.name}</DetailRow> : null}
            <DetailRow label="Gültig ab">{document.validFrom ? formatDate(document.validFrom) : '—'}</DetailRow>
            <DetailRow label="Läuft ab">{document.expiresOn ? `${formatDate(document.expiresOn)} · Erinnerung ${document.reminderDaysBefore} Tage vorher` : '—'}</DetailRow>
            {document.tags.length ? <DetailRow label="Schlagwörter">{document.tags.join(', ')}</DetailRow> : null}
            {document.description ? <DetailRow label="Beschreibung">{document.description}</DetailRow> : null}
            <DetailRow label="Abgelegt">{formatDateTime(document.createdAt)}</DetailRow>
          </dl>
        </DetailSection>
      </div>
    </div>
  );
}
