import type { Metadata } from 'next';
import Link from 'next/link';
import { PackageCheck, ScrollText, ShieldAlert } from 'lucide-react';

import { requirePagePermission } from '@/lib/auth/session';
import { formatDate, formatDateTime } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import { DetailSection, EmptyState, PageHeader } from '@/components/app/page-parts';
import { getOrganizationId } from '@/server/services/organization.service';
import { ARTNAMEN, ZUSTANDSNAMEN, listReleases } from '@/server/services/release.service';

export const metadata: Metadata = {
  title: 'Updates',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Update Center — welche Clenaris-Versionen es gibt und was beschlossen ist.
 *
 * Nur die Systemverantwortung (404 für alle anderen, wie Prüfprotokoll und
 * Datenbereinigung). Die Seite zeigt und entscheidet; sie führt nichts aus.
 * Warum, steht ausführlich in `src/server/services/release.service.ts`.
 */
export default async function UpdatesPage() {
  await requirePagePermission('release:read');
  const { laufend, releases } = await listReleases(await getOrganizationId());
  const neuer = releases.filter((r) => r.zustand !== 'INSTALLED' && r.zustand !== 'OLDER');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Updates"
        description="Verfügbare Clenaris-Versionen, ihr Änderungsprotokoll und Ihre Entscheidung darüber."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/protokoll?bereich=ReleaseRequest">
              <ScrollText aria-hidden />
              Entscheidungen im Protokoll
            </Link>
          </Button>
        }
      />

      <Alert title="Freigeben heisst nicht ausrollen">
        Eine Freigabe oder ein Termin legt einen Aktualisierungsauftrag an. Ausgeführt wird er von einem
        separaten, vertrauenswürdigen Deployment-Werkzeug — nie von dieser Anwendung aus. Solange dieses
        Werkzeug (Production V2) nicht in Betrieb ist, bleibt jeder Auftrag eine dokumentierte
        Entscheidung.
      </Alert>

      <DetailSection title="Laufende Version" body="list">
        <dl className="protocol-list protocol-list--columns">
          <div className="protocol-row">
            <div className="protocol-row-head">
              <dt className="protocol-label">Installiert</dt>
            </div>
            <dd className="protocol-value font-display text-lg font-semibold tabular-nums">v{laufend}</dd>
          </div>
          <div className="protocol-row">
            <div className="protocol-row-head">
              <dt className="protocol-label">Status</dt>
            </div>
            <dd className="protocol-value">
              {neuer.length ? (
                <Badge variant="warning">
                  {neuer.length === 1 ? 'Ein Update verfügbar' : `${neuer.length} Updates verfügbar`}
                </Badge>
              ) : (
                <Badge variant="success">Aktuell</Badge>
              )}
            </dd>
          </div>
        </dl>
      </DetailSection>

      {releases.length === 0 ? (
        <EmptyState
          icon={<PackageCheck aria-hidden />}
          title="Keine Versionen bekannt"
          description="Neue Versionen trägt das Release-Werkzeug ein (scripts/release-registrieren.ts). Bis dahin gibt es hier nichts zu entscheiden."
        />
      ) : (
        <DetailSection title="Versionen" body="flush">
          <ul className="divide-y divide-border">
            {releases.map(({ release, zustand, offenerAuftrag, zurueckgestelltBis }) => (
              <li key={release.id}>
                <Link
                  href={`/admin/updates/${release.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 transition-colors hover:bg-muted/50"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      <span className="font-display tabular-nums">v{release.version}</span>
                      <Badge size="sm" variant={release.kind === 'SECURITY' ? 'destructive' : 'outline'}>
                        {release.kind === 'SECURITY' ? <ShieldAlert className="size-3" aria-hidden /> : null}
                        {ARTNAMEN[release.kind]}
                      </Badge>
                      {release.breakingChanges.length ? (
                        <Badge size="sm" variant="warning">
                          Breaking Changes
                        </Badge>
                      ) : null}
                    </p>
                    <p className="line-clamp-1 text-sm text-muted-foreground">{release.summary}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <span className="text-muted-foreground">{formatDate(release.releasedAt)}</span>
                    <Badge
                      variant={
                        zustand === 'AVAILABLE'
                          ? 'warning'
                          : zustand === 'SCHEDULED' || zustand === 'APPROVED'
                            ? 'info'
                            : zustand === 'INSTALLED'
                              ? 'success'
                              : 'neutral'
                      }
                    >
                      {ZUSTANDSNAMEN[zustand]}
                      {zustand === 'SCHEDULED' && offenerAuftrag?.scheduledFor
                        ? ` · ${formatDateTime(offenerAuftrag.scheduledFor)}`
                        : ''}
                    </Badge>
                    {zurueckgestelltBis && zustand === 'AVAILABLE' ? (
                      <span className="text-xs text-muted-foreground">
                        zurückgestellt bis {formatDate(zurueckgestelltBis)}
                      </span>
                    ) : null}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </DetailSection>
      )}
    </div>
  );
}
