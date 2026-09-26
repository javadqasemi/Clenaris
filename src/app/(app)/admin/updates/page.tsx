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
import { sicherheitsupdateLage } from '@/server/services/security-report.service';

const SCHWERE: Record<string, string> = { LOW: 'niedrig', MEDIUM: 'mittel', HIGH: 'hoch', CRITICAL: 'kritisch' };

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
  const organizationId = await getOrganizationId();
  const [{ laufend, releases }, lage] = await Promise.all([listReleases(organizationId), sicherheitsupdateLage(organizationId)]);
  const neuer = releases.filter((r) => r.zustand !== 'INSTALLED' && r.zustand !== 'OLDER');
  // Sicherheitsversionen, über die noch zu entscheiden ist oder die terminiert
  // sind — die Entscheidung selbst fällt auf der Detailseite, wie bei jeder
  // Version.
  const sicherheitsversionen = neuer.filter((r) => r.release.kind === 'SECURITY' || r.release.securitySeverity);

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

      {/*
        Sicherheitsupdates (2026-09-26). Versionen mit Sicherheitskorrekturen
        führen auf ihre Detailseite — dort wird wie immer freigegeben und
        terminiert. Abhängigkeits- und Betriebssystembefunde kommen aus den
        Berichten und sind nur Einsicht: Behoben werden sie mit der nächsten
        Version bzw. vom Betrieb des Servers, nie von hier aus.
      */}
      <DetailSection title="Sicherheitsupdates" body="flush">
        <div className="space-y-4 px-6 py-4 text-sm" data-sicherheitsupdates>
          {sicherheitsversionen.length ? (
            <ul className="space-y-2">
              {sicherheitsversionen.map(({ release, zustand, offenerAuftrag }) => (
                <li key={release.id} className="flex flex-wrap items-center gap-2">
                  <ShieldAlert className="size-4 text-destructive" aria-hidden />
                  <Link href={`/admin/updates/${release.id}`} className="font-medium underline-offset-4 hover:underline">
                    v{release.version}
                  </Link>
                  {release.securitySeverity ? (
                    <Badge size="sm" variant={release.securitySeverity === 'CRITICAL' || release.securitySeverity === 'HIGH' ? 'destructive' : 'warning'}>
                      {SCHWERE[release.securitySeverity]}
                    </Badge>
                  ) : null}
                  <span className="text-muted-foreground">
                    {ZUSTANDSNAMEN[zustand]}
                    {zustand === 'SCHEDULED' && offenerAuftrag?.scheduledFor ? ` · ${formatDateTime(offenerAuftrag.scheduledFor)}` : ' — prüfen, freigeben oder terminieren'}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">Keine offene Clenaris-Version mit Sicherheitskorrekturen.</p>
          )}

          <div>
            <p className="font-medium">Abhängigkeiten der Anwendung</p>
            {!lage.pruefung.letzter ? (
              <p className="text-muted-foreground">
                Noch kein Bericht von <code className="font-mono text-2xs">npm run security:check -- --melden</code>.
              </p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  Stand {formatDateTime(lage.pruefung.letzter.receivedAt)}
                  {lage.pruefung.ausgeblieben ? ' — veraltet, bitte neu prüfen' : ''}. Behoben wird mit der nächsten Version; bewertet in{' '}
                  <code className="font-mono text-2xs">security/akzeptierte-befunde.json</code>.
                </p>
                {lage.advisories.length ? (
                  <ul className="mt-2 space-y-1.5" data-advisories>
                    {lage.advisories.map((a) => (
                      <li key={a.id}>
                        <Badge size="sm" variant={a.schwere === 'hoch' || a.schwere === 'kritisch' ? 'warning' : 'neutral'}>
                          {a.id}
                        </Badge>{' '}
                        {a.titel}
                        {a.details ? <span className="block text-xs text-muted-foreground">{a.details}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-muted-foreground">Keine bekannten Lücken gemeldet.</p>
                )}
              </>
            )}
          </div>

          <div>
            <p className="font-medium">Betriebssystem des Servers</p>
            {lage.server ? (
              <p className="text-muted-foreground">
                {typeof lage.server.sicherheitsupdates === 'number' && lage.server.sicherheitsupdates >= 0
                  ? `${lage.server.sicherheitsupdates} Sicherheitsupdate(s) ausstehend`
                  : 'nicht geprüft'}{' '}
                · Stand {formatDateTime(lage.server.receivedAt)}
                {lage.server.ausgeblieben ? ' (veraltet)' : ''}. Eingespielt vom Betrieb (unattended-upgrades), nicht von dieser Anwendung.
              </p>
            ) : (
              <p className="text-muted-foreground">
                Noch kein Bericht von <code className="font-mono text-2xs">ops/security-monitor/deps_check.sh</code>.
              </p>
            )}
          </div>
        </div>
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
