import type { Metadata } from 'next';
import type { FileScope } from '@prisma/client';

import { requirePagePermission, getSession } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { toQueryString } from '@/lib/utils';
import { FilterBar } from '@/components/app/filter-bar';
import { PageHeader, Pagination } from '@/components/app/page-parts';
import { MediaLibrary, type MediaRow } from '@/features/admin/media/media-library';
import { attachmentsOf, listMedia } from '@/server/services/media.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const metadata: Metadata = {
  title: 'Mediathek',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const SCOPE_LABELS: Record<FileScope, string> = {
  BOOKING: 'Buchung',
  QUOTE: 'Offerte',
  INVOICE: 'Rechnung',
  JOB: 'Einsatz',
  CUSTOMER: 'Kundschaft',
  EMPLOYEE: 'Personal',
  PROPERTY: 'Objekt',
  BLOG: 'Blog',
  GALLERY: 'Galerie',
  APPLICATION: 'Bewerbung',
  EXPENSE: 'Ausgabe',
  MESSAGE: 'Nachricht',
  OTHER: 'Übriges',
  OBJECTIVE: 'Ziel',
  INVESTMENT: 'Investition',
  RISK: 'Risiko',
  CONTROL: 'Kontrolle',
  DOCUMENT: 'Dokument',
  ARTICLE: 'Wissensartikel',
  MEETING: 'Sitzung',
  REPORT: 'Bericht',
};

/**
 * Mediathek.
 *
 * Zeigt alles, was je hochgeladen wurde — Baustellenfotos, Bewerbungsdossiers,
 * Belege, Galeriebilder. Der Zweck ist weniger das Stöbern als das Aufräumen:
 * der Objektspeicher kostet Geld, und niemand weiss, was darin liegt, solange
 * es keine Liste gibt.
 */
export default async function MediaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePagePermission('media:read');
  const session = await getSession();
  const params = await searchParams;
  const organizationId = await getOrganizationId();

  const page = Math.max(1, Number(params.seite) || 1);
  const pageSize = 48;

  const { items, total, totalBytes } = await listMedia({
    organizationId,
    q: params.q,
    scope: params.bereich as FileScope | undefined,
    imagesOnly: params.nurBilder === '1',
    page,
    pageSize,
  });

  const rows: MediaRow[] = items.map((file) => ({
    id: file.id,
    filename: file.filename,
    url: file.url,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    scope: file.scope,
    scopeLabel: SCOPE_LABELS[file.scope],
    isPublic: file.isPublic,
    createdAt: file.createdAt.toISOString(),
    attachments: attachmentsOf(file),
  }));

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const baseHref = `/admin/medien${toQueryString({
    q: params.q,
    bereich: params.bereich,
    nurBilder: params.nurBilder,
  })}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Mediathek"
        description={`${total} ${total === 1 ? 'Datei' : 'Dateien'} · ${formatBytes(totalBytes)} belegt. Enthält alles, was je hochgeladen wurde — auch Belege und Bewerbungsdossiers.`}
      >
        <FilterBar
          searchPlaceholder="Dateiname …"
          filters={[
            {
              param: 'bereich',
              label: 'Bereich',
              options: (Object.keys(SCOPE_LABELS) as FileScope[]).map((scope) => ({
                value: scope,
                label: SCOPE_LABELS[scope],
              })),
            },
            {
              param: 'nurBilder',
              label: 'Typ',
              options: [{ value: '1', label: 'Nur Bilder' }],
            },
          ]}
        />
      </PageHeader>

      <MediaLibrary
        files={rows}
        canUpload={can(session!.role, 'media:upload')}
        canUpdate={can(session!.role, 'media:update')}
        canDelete={can(session!.role, 'media:delete')}
      />

      <Pagination page={page} totalPages={totalPages} total={total} baseHref={baseHref} />
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
