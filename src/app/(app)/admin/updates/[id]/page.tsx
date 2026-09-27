import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ShieldAlert } from 'lucide-react';

import { can } from '@/lib/auth/rbac';
import { requirePagePermission } from '@/lib/auth/session';
import { NotFoundError } from '@/lib/errors';
import { formatBytes, formatDate, formatDateTime } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import { DetailRow, DetailSection, PageHeader } from '@/components/app/page-parts';
import { ReleaseActions } from '@/features/admin/system/release-actions';
import { getOrganizationId } from '@/server/services/organization.service';
import { ARTNAMEN, AUFTRAGSNAMEN, ZUSTANDSNAMEN, getReleaseDetail } from '@/server/services/release.service';

export const metadata: Metadata = {
  title: 'Update',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const SCHWERE: Record<string, string> = {
  LOW: 'Niedrig',
  MEDIUM: 'Mittel',
  HIGH: 'Hoch',
  CRITICAL: 'Kritisch',
};

const CI: Record<string, { text: string; variant: 'success' | 'destructive' | 'warning' }> = {
  PASSED: { text: 'Bestanden', variant: 'success' },
  FAILED: { text: 'Fehlgeschlagen', variant: 'destructive' },
  PENDING: { text: 'Ausstehend', variant: 'warning' },
};

/** Farbe je Auftragszustand; die Wörter stehen in `AUFTRAGSNAMEN` (Dienst). */
const AUFTRAGSFARBE: Record<string, 'neutral' | 'info' | 'success' | 'destructive' | 'warning'> = {
  APPROVED: 'info',
  SCHEDULED: 'info',
  CANCELLED: 'neutral',
  DEPLOYING: 'warning',
  SUCCEEDED: 'success',
  FAILED: 'destructive',
  ROLLED_BACK: 'destructive',
};

/** Eine Liste aus dem Änderungsprotokoll — oder ein ehrliches „keine". */
function Liste({ eintraege, leer }: { eintraege: string[]; leer: string }) {
  if (!eintraege.length) return <p className="py-3 text-sm text-muted-foreground">{leer}</p>;
  return (
    <ul className="list-disc space-y-1.5 py-3 pl-5 text-sm leading-relaxed">
      {eintraege.map((e) => (
        <li key={e}>{e}</li>
      ))}
    </ul>
  );
}

/**
 * Eine Version im Detail: alles, was eine Administratorin vor der Freigabe
 * wissen muss — in ihrer Sprache, nicht als Commit-Liste. Die Reihenfolge
 * folgt der Frage, die über die Freigabe entscheidet: Was bringt es, was
 * kann brechen, was muss ich tun, wie lange steht das System?
 */
export default async function UpdateDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePagePermission('release:read');
  const { id } = await params;

  let detail;
  try {
    detail = await getReleaseDetail(await getOrganizationId(), id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const { release, zustand, laufend, offenerAuftrag, auftraege, namen, zurueckgestelltBis } = detail;
  const darfEntscheiden = can(session.role, 'release:manage');
  const ci = CI[release.ciStatus] ?? CI.PENDING!;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Clenaris v${release.version}`}
        description={release.summary}
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link href="/admin/updates">
                <ArrowLeft aria-hidden />
                Alle Versionen
              </Link>
            </Button>
            {darfEntscheiden ? (
              <ReleaseActions
                releaseId={release.id}
                version={release.version}
                zustand={zustand}
                termin={offenerAuftrag?.scheduledFor?.toISOString() ?? null}
              />
            ) : null}
          </>
        }
      />

      {release.kind === 'SECURITY' ? (
        <Alert variant="destructive" title={`Sicherheitsupdate · Schwere ${SCHWERE[release.securitySeverity ?? ''] ?? 'nicht angegeben'}`}>
          Diese Version schliesst mindestens eine Sicherheitslücke der laufenden Version. Zurückstellen heisst, die
          Lücke bewusst offen zu lassen.
        </Alert>
      ) : null}
      {release.ciStatus !== 'PASSED' ? (
        <Alert variant="warning" title="Prüfstufe nicht bestanden">
          Das Release-Artefakt hat die automatische Prüfung {release.ciStatus === 'FAILED' ? 'nicht bestanden' : 'noch nicht abgeschlossen'}. Eine
          Freigabe ist möglich, aber nicht empfohlen.
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <div className="space-y-6">
          <DetailSection title="Neue Funktionen">
            <Liste eintraege={release.features} leer="Keine neuen Funktionen." />
          </DetailSection>
          <DetailSection title="Behobene Fehler">
            <Liste eintraege={release.fixes} leer="Keine Fehlerkorrekturen aufgeführt." />
          </DetailSection>
          <DetailSection title="Sicherheitskorrekturen">
            <Liste eintraege={release.securityFixes} leer="Keine Sicherheitskorrekturen." />
          </DetailSection>
          <DetailSection title="Änderungen an der Oberfläche">
            <Liste eintraege={release.uiChanges} leer="Keine sichtbaren Änderungen an der Oberfläche." />
          </DetailSection>
          <DetailSection title="Breaking Changes" description="Was sich so ändert, dass bestehende Abläufe oder Anbindungen angepasst werden müssen.">
            <Liste eintraege={release.breakingChanges} leer="Keine." />
          </DetailSection>
          <DetailSection title="Manuelle Schritte" description="Was vor oder nach dem Update von Hand zu tun ist.">
            <Liste eintraege={release.manualActions} leer="Keine." />
          </DetailSection>
          <DetailSection title="Datenbankmigrationen">
            <Liste eintraege={release.migrations} leer="Keine Datenbankänderung." />
          </DetailSection>
        </div>

        <div className="space-y-6">
          <DetailSection title="Überblick">
            <dl className="protocol-list">
              <DetailRow label="Zustand">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge variant={zustand === 'AVAILABLE' ? 'warning' : zustand === 'INSTALLED' ? 'success' : 'info'}>
                    {ZUSTANDSNAMEN[zustand]}
                  </Badge>
                  {offenerAuftrag?.scheduledFor ? <span>{formatDateTime(offenerAuftrag.scheduledFor)}</span> : null}
                </span>
              </DetailRow>
              <DetailRow label="Version">
                v{laufend} → v{release.version}
              </DetailRow>
              <DetailRow label="Typ">
                <span className="flex items-center gap-1.5">
                  {release.kind === 'SECURITY' ? <ShieldAlert className="size-3.5 text-destructive" aria-hidden /> : null}
                  {ARTNAMEN[release.kind]}
                </span>
              </DetailRow>
              {release.securitySeverity ? (
                <DetailRow label="Sicherheitsschwere">{SCHWERE[release.securitySeverity]}</DetailRow>
              ) : null}
              <DetailRow label="Veröffentlicht">{formatDate(release.releasedAt)}</DetailRow>
              <DetailRow label="Prüfstufe (CI)">
                <Badge variant={ci.variant} size="sm">
                  {ci.text}
                </Badge>
              </DetailRow>
              <DetailRow label="Erwartete Ausfallzeit">
                {release.expectedDowntimeMinutes === null
                  ? 'Nicht angegeben'
                  : release.expectedDowntimeMinutes === 0
                    ? 'Keine'
                    : `ca. ${release.expectedDowntimeMinutes} Minuten`}
              </DetailRow>
              <DetailRow label="Rückkehr möglich">{release.rollbackAvailable ? 'Ja, auf die vorherige Version' : 'Nein'}</DetailRow>
              <DetailRow label="Grösse">
                {release.artifactSizeBytes !== null ? formatBytes(release.artifactSizeBytes) : 'Nicht angegeben'}
              </DetailRow>
              {release.compatibility ? <DetailRow label="Kompatibilität">{release.compatibility}</DetailRow> : null}
              {release.commit ? (
                <DetailRow label="Stand">
                  <code className="text-xs">{release.commit.slice(0, 12)}</code>
                </DetailRow>
              ) : null}
              {zurueckgestelltBis && zustand === 'AVAILABLE' ? (
                <DetailRow label="Zurückgestellt bis">{formatDate(zurueckgestelltBis)}</DetailRow>
              ) : null}
            </dl>
          </DetailSection>

          <DetailSection title="Entscheidungen">
            {auftraege.length === 0 ? (
              <p className="py-3 text-sm text-muted-foreground">Noch keine Entscheidung.</p>
            ) : (
              <ul className="divide-y divide-border">
                {auftraege.map((a) => (
                  <li key={a.id} className="space-y-1 py-3 text-sm">
                    <p className="flex items-center gap-2 font-medium">
                      <Badge size="sm" variant={AUFTRAGSFARBE[a.status] ?? 'info'}>
                        {AUFTRAGSNAMEN[a.status]}
                      </Badge>
                      v{a.fromVersion} → v{a.toVersion}
                    </p>
                    <p className="text-muted-foreground">
                      Freigegeben {formatDateTime(a.approvedAt)} von {namen[a.approvedById] ?? 'unbekannt'}
                    </p>
                    {a.scheduledFor ? (
                      <p className="text-muted-foreground">
                        Termin {formatDateTime(a.scheduledFor)}
                        {a.scheduledById ? ` · gesetzt von ${namen[a.scheduledById] ?? 'unbekannt'}` : ''}
                      </p>
                    ) : null}
                    {a.cancelledAt ? (
                      <p className="text-muted-foreground">
                        Storniert {formatDateTime(a.cancelledAt)} von {namen[a.cancelledById ?? ''] ?? 'unbekannt'}
                        {a.cancelReason ? ` — ${a.cancelReason}` : ''}
                      </p>
                    ) : null}
                    {/*
                      Die Ausführung — gemeldet vom Ausführer ausserhalb der
                      Anwendung, nie hier ausgelöst. Der CI-Nachweis ist der
                      Beleg, dass genau dieses Artefakt geprüft wurde.
                    */}
                    {a.claimedAt ? (
                      <p className="text-muted-foreground">
                        Übernommen {formatDateTime(a.claimedAt)} von <code className="text-xs">{a.executorId}</code> ({a.environment})
                        {a.verifiedSha256 ? (
                          <>
                            {' · Artefakt '}
                            <code className="text-xs">{a.verifiedSha256.slice(0, 12)}</code>
                          </>
                        ) : null}
                        {a.ciEvidence ? (
                          <>
                            {' · '}
                            <a href={a.ciEvidence} className="underline underline-offset-2" rel="noreferrer noopener" target="_blank">
                              CI-Lauf
                            </a>
                          </>
                        ) : null}
                      </p>
                    ) : null}
                    {a.finishedAt ? (
                      <p className="text-muted-foreground">
                        {AUFTRAGSNAMEN[a.status]} {formatDateTime(a.finishedAt)}
                        {a.rollbackVersion ? ` · zurück auf v${a.rollbackVersion}` : ''}
                        {a.resultMessage ? ` — ${a.resultMessage}` : ''}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </DetailSection>
        </div>
      </div>
    </div>
  );
}
