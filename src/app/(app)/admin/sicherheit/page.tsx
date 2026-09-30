import type { Metadata } from 'next';
import type { SecurityCategory, SecuritySeverity } from '@prisma/client';

import { requirePagePermission } from '@/lib/auth/session';
import { ROLE_LABELS } from '@/lib/auth/rbac';
import { laufendeIdentitaet } from '@/lib/release/identitaet';
import { SECURITY_EVENTS } from '@/lib/security/events';
import { formatDateTime, toQueryString } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/primitives';
import { ActionButton } from '@/components/app/action-button';
import { FilterBar } from '@/components/app/filter-bar';
import { KpiTile } from '@/components/app/kpi-tile';
import {
  EmptyState,
  ListCard,
  PageHeader,
  Pagination,
  TableScroll,
} from '@/components/app/page-parts';
import { getOrganizationId } from '@/server/services/organization.service';
import { cronZustand, FEHLER_IN_FOLGE_ALARM } from '@/server/services/cron-monitor.service';
import { berichtsZustand } from '@/server/services/security-report.service';
import { Sicherheitsberichte } from '@/features/admin/sicherheitsberichte';
import {
  getSicherheitsUeberblick,
  listAuffaelligeKonten,
  listSecurityEvents,
} from '@/server/services/security.service';

export const metadata: Metadata = {
  title: 'Sicherheit',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Das Sicherheitszentrum.
 *
 * ---------------------------------------------------------------------------
 *  Wozu es da ist — und wozu ausdrücklich nicht
 * ---------------------------------------------------------------------------
 *
 * Alles, was hier steht, stand vorher schon in der Datenbank: gesperrte Konten
 * an `User.lockedUntil`, offene Sitzungen an `RefreshToken`, Dateien in
 * Quarantäne an `FileAsset.scanStatus`. Was fehlte, war ein Ort, an dem man
 * sie **nebeneinander** sieht und **etwas tun** kann.
 *
 * Diese Seite erfindet nichts dazu. Keine Bewertung „verdächtig", keine
 * Wahrscheinlichkeit, keine Erkennung ungewöhnlicher Anmeldezeiten. Solche
 * Anzeigen werden nach drei Fehlalarmen weggeklickt — und danach auch dann,
 * wenn sie recht haben. Gezeigt wird, was geschehen ist.
 *
 * ---------------------------------------------------------------------------
 *  Warum nur die Systemverantwortung
 * ---------------------------------------------------------------------------
 *
 * Dieselbe Begründung wie beim Prüfprotokoll, eine Stufe schärfer: Diese Seite
 * zeigt, wessen Anmeldungen scheitern und wer seinen zweiten Faktor
 * abgeschaltet hat. Das ist eine Aufsicht über Personen. Wer beaufsichtigt
 * wird, darf sie nicht öffnen — sonst sieht die Administration, die sich zu
 * weit vorgewagt hat, als Erste, dass es aufgefallen ist.
 *
 * `requirePagePermission` antwortet 404 und nicht 403: Für alle anderen Rollen
 * gibt es diese Seite nicht.
 */

const SCHWERE_VARIANTE: Record<SecuritySeverity, 'neutral' | 'warning' | 'destructive'> = {
  INFO: 'neutral',
  WARNING: 'warning',
  CRITICAL: 'destructive',
};

const SCHWERE_LABEL: Record<SecuritySeverity, string> = {
  INFO: 'Normal',
  WARNING: 'Auffällig',
  CRITICAL: 'Entscheidung nötig',
};

const KATEGORIE_LABEL: Record<SecurityCategory, string> = {
  AUTHENTICATION: 'Anmeldung',
  SESSION: 'Sitzungen',
  ACCESS: 'Zugriff',
  PUBLIC_LINK: 'Zugangslinks',
  FILE: 'Dateien',
  SYSTEM: 'Betrieb',
};

export default async function SicherheitPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePagePermission('security:read');

  const params = await searchParams;
  const organizationId = await getOrganizationId();
  const seite = Math.max(1, Number(params.seite) || 1);

  const jetzt = new Date();
  const [ueberblick, ereignisse, konten, laeufe, berichte] = await Promise.all([
    getSicherheitsUeberblick(organizationId),
    listSecurityEvents({
      organizationId,
      category: params.bereich as SecurityCategory | undefined,
      severity: params.schwere as SecuritySeverity | undefined,
      nurOffen: params.offen === 'ja',
      seite,
      proSeite: 50,
    }),
    listAuffaelligeKonten(organizationId),
    cronZustand(organizationId),
    berichtsZustand(organizationId, jetzt),
  ]);

  const seiten = Math.max(1, Math.ceil(ereignisse.gesamt / ereignisse.proSeite));
  const basisHref = `/admin/sicherheit${toQueryString({
    bereich: params.bereich,
    schwere: params.schwere,
    offen: params.offen,
  })}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sicherheit"
        description="Was an Anmeldungen, Sitzungen, Zugriffen und Dateien geschehen ist — und was davon noch eine Entscheidung braucht."
      >
        {/* Ohne Suchfeld: `listSecurityEvents` wertet `q` nicht aus (2026-09-28). */}
        <FilterBar
          search={false}
          filters={[
            {
              param: 'schwere',
              label: 'Schwere',
              options: (Object.keys(SCHWERE_LABEL) as SecuritySeverity[]).map((s) => ({
                value: s,
                label: SCHWERE_LABEL[s],
              })),
            },
            {
              param: 'bereich',
              label: 'Bereich',
              options: (Object.keys(KATEGORIE_LABEL) as SecurityCategory[]).map((k) => ({
                value: k,
                label: KATEGORIE_LABEL[k],
              })),
            },
            {
              param: 'offen',
              label: 'Offen',
              options: [{ value: 'ja', label: 'Nur unbestätigte' }],
            },
          ]}
        />
      </PageHeader>

      {/*
        Die Kachelreihe beantwortet die Frage, mit der jemand diese Seite
        öffnet: Ist gerade etwas? Der erste Wert ist deshalb nicht der
        häufigste, sondern der einzige, der eine Handlung verlangt.
      */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label="Offene Entscheidungen"
          value={String(ueberblick.offeneKritische)}
          hint="Unbestätigte Ereignisse der Stufe „Entscheidung nötig“"
          accent={ueberblick.offeneKritische > 0 ? 'destructive' : 'neutral'}
        />
        <KpiTile
          label="Fehlanmeldungen (24 h)"
          value={String(ueberblick.fehlanmeldungen24h)}
          hint={`${ueberblick.gesperrteKonten} Konto(s) derzeit gesperrt`}
          accent={ueberblick.gesperrteKonten > 0 ? 'warning' : 'neutral'}
        />
        <KpiTile
          label="Offene Sitzungen"
          value={String(ueberblick.aktiveSitzungen)}
          hint={
            ueberblick.offeneGeraeteUebergaben > 0
              ? `${ueberblick.offeneGeraeteUebergaben} Gerät(e) gerade übergeben`
              : 'Keine laufende Geräteübergabe'
          }
        />
        <KpiTile
          label="Zweiter Faktor"
          value={`${ueberblick.zweitfaktorAnteil} %`}
          hint={`${ueberblick.kontenMitZweitfaktor} von ${ueberblick.aktiveKonten} aktiven Konten`}
          accent={ueberblick.zweitfaktorAnteil < 50 ? 'warning' : 'neutral'}
        />
      </div>

      {/*
        Der Betriebszustand der Prüfeinrichtung selbst. Er steht bewusst als
        Meldung und nicht als Kachel: Eine Zahl neben anderen Zahlen liest
        niemand als „die Anwendung nimmt Dateien an und kann keine prüfen".
      */}
      {!ueberblick.scanner.eingerichtet ? (
        <Alert variant="destructive">
          <strong>Kein Schadsoftwareprüfer eingerichtet.</strong> Hochgeladene Dateien werden
          angenommen, bleiben aber gesperrt und lassen sich nicht abrufen. Einzurichten über
          <code className="mx-1 font-mono text-2xs">CLAMAV_HOST</code>; die Betriebsanleitung steht
          in <code className="font-mono text-2xs">docs/MALWARE_PROTECTION.md</code>.
        </Alert>
      ) : ueberblick.scanner.art === 'clamav' && ueberblick.scanner.erreichbar === false ? (
        <Alert variant="destructive">
          <strong>ClamAV ist eingerichtet, antwortet aber nicht.</strong> Neue Dateien bekommen keinen
          Befund und bleiben gesperrt, bis der Dienst wieder erreichbar ist; der Nachtlauf prüft sie
          dann nach. Prüfen: läuft <code className="font-mono text-2xs">clamd</code>, stimmen
          <code className="mx-1 font-mono text-2xs">CLAMAV_HOST</code>/<code className="font-mono text-2xs">CLAMAV_PORT</code>?
        </Alert>
      ) : ueberblick.scanner.art === 'test' ? (
        <Alert variant="warning">
          Es läuft der <strong>Testprüfer</strong>. Er erkennt ausschliesslich die genormte
          EICAR-Testdatei und ist keine Schadsoftwareprüfung. In der Produktion lässt er sich nicht
          starten.
        </Alert>
      ) : null}

      {/*
        Die geplanten Läufe (RB-014). Auf ihnen hängen der Abschluss von
        Signaturvorgängen, die Nachprüfung von Dateien, die Serienplanung und
        die Automatisierungen. Bis 2026-09-23 war nirgends zu sehen, ob sie
        liefen.
      */}
      <ListCard>
        <div className="px-6 pt-5">
          <h2 className="font-display text-title">Geplante Läufe</h2>
          <p className="text-meta text-muted-foreground">
            Stündlich und nächtlich. Von aussen überwachbar über <code className="font-mono text-2xs">/api/cron/status</code>.
          </p>
        </div>
        <TableScroll>
          <table className="data-table">
            <caption className="sr-only">Zustand der geplanten Läufe</caption>
            <thead>
              <tr>
                <th scope="col">Auftrag</th>
                <th scope="col">Zustand</th>
                <th scope="col">Letzter Erfolg</th>
                <th scope="col">Letzter Fehler</th>
                <th scope="col" className="text-right">Dauer</th>
                <th scope="col" className="text-right">Teilaufgaben</th>
                <th scope="col">Nächster erwartet</th>
              </tr>
            </thead>
            <tbody>
              {laeufe.map((lauf) => {
                const problem = lauf.ueberfaellig || lauf.haengt || lauf.fehlerInFolge >= FEHLER_IN_FOLGE_ALARM;
                return (
                  <tr key={lauf.job}>
                    <td className="font-medium">{lauf.job === 'hourly' ? 'Stündlich' : 'Nächtlich'}</td>
                    <td>
                      <Badge variant={problem ? 'destructive' : lauf.fehlerInFolge > 0 ? 'warning' : 'neutral'}>
                        {!lauf.letzterLauf
                          ? 'Noch nie gelaufen'
                          : lauf.ueberfaellig
                            ? 'Ausgeblieben'
                            : lauf.haengt
                              ? 'Hängt'
                              : lauf.fehlerInFolge > 0
                                ? `${lauf.fehlerInFolge} Fehler in Folge`
                                : 'In Ordnung'}
                      </Badge>
                    </td>
                    <td className="tabular-nums text-muted-foreground">
                      {lauf.letzterErfolg ? formatDateTime(lauf.letzterErfolg) : '—'}
                    </td>
                    <td className="tabular-nums text-muted-foreground">
                      {lauf.letzterFehler ? formatDateTime(lauf.letzterFehler) : '—'}
                    </td>
                    <td className="num text-muted-foreground">
                      {lauf.letzteDauerMs !== null ? `${(lauf.letzteDauerMs / 1000).toFixed(1)} s` : '—'}
                    </td>
                    <td className="num text-muted-foreground">
                      {lauf.verarbeitet !== null ? `${lauf.verarbeitet} gelungen · ${lauf.fehlgeschlagen ?? 0} gescheitert` : '—'}
                    </td>
                    <td className="tabular-nums text-muted-foreground">
                      {lauf.naechsterErwartet ? formatDateTime(lauf.naechsterErwartet) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      </ListCard>

      {/*
        Was Prüfungen ausserhalb der Anwendung gemeldet haben — security:check,
        der Überwachungsrechner, ZAP, die Sicherung (2026-09-26). Nur Anzeige:
        Diese Seite startet keine Prüfung und ruft kein Programm auf.

        Der laufende Stand kommt seit 2026-09-30 aus der Identität der Instanz
        (`RELEASE.json` und `BUILD_ID`), nicht mehr aus `APP_VERSION`: Eine
        Variable, die jeder beim Start setzen kann, ist kein Beleg dafür,
        welcher Code hier läuft. Die Systemverantwortung sieht auch den Grund,
        wenn der Stand nicht belegt ist — der öffentliche Gesundheitsendpunkt
        nennt ihn bewusst nicht.
      */}
      <Sicherheitsberichte zustaende={berichte} identitaet={laufendeIdentitaet()} scanner={ueberblick.scanner} jetzt={jetzt} />

      {(ueberblick.dateienInQuarantaene > 0 || ueberblick.dateienOhneBefund > 0) && (
        <Alert variant={ueberblick.dateienInQuarantaene > 0 ? 'destructive' : 'warning'}>
          {ueberblick.dateienInQuarantaene > 0 ? (
            <>
              <strong>{ueberblick.dateienInQuarantaene} Datei(en) in Quarantäne.</strong> Sie sind
              über keinen Weg abrufbar.{' '}
            </>
          ) : null}
          {ueberblick.dateienOhneBefund > 0 ? (
            <>
              {ueberblick.dateienOhneBefund} Datei(en) ohne Prüfbefund — sie bleiben gesperrt, bis
              ein Prüflauf sie freigibt (<code className="font-mono text-2xs">scan-backfill</code>).
            </>
          ) : null}
        </Alert>
      )}

      {konten.length > 0 ? (
        <ListCard>
          <TableScroll minWidth="48rem">
            <table className="data-table">
              <caption className="sr-only">
                Konten mit Fehlversuchen oder aktiver Sperre. {konten.length} Einträge.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Konto</th>
                  <th scope="col">Rolle</th>
                  <th scope="col">Fehlversuche</th>
                  <th scope="col">Gesperrt bis</th>
                  <th scope="col">Letzte Anmeldung</th>
                  <th scope="col">Zweiter Faktor</th>
                  <th scope="col">
                    <span className="sr-only">Handlungen</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {konten.map((konto) => {
                  const gesperrt = Boolean(konto.lockedUntil && konto.lockedUntil > new Date());
                  return (
                    <tr key={konto.id}>
                      <td>
                        <span className="block font-medium">
                          {konto.firstName} {konto.lastName}
                        </span>
                        <span className="block text-xs text-muted-foreground">{konto.email}</span>
                      </td>
                      <td className="whitespace-nowrap">{ROLE_LABELS[konto.role]}</td>
                      <td className="tabular-nums">{konto.failedLoginCount}</td>
                      <td className="whitespace-nowrap tabular-nums">
                        {gesperrt && konto.lockedUntil ? (
                          <Badge variant="destructive" size="sm">
                            {formatDateTime(konto.lockedUntil)}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap tabular-nums text-muted-foreground">
                        {konto.lastLoginAt ? formatDateTime(konto.lastLoginAt) : 'nie'}
                      </td>
                      <td>
                        {konto.twoFactorEnabled ? (
                          <Badge variant="success" size="sm">
                            ein
                          </Badge>
                        ) : (
                          <Badge variant="warning" size="sm">
                            aus
                          </Badge>
                        )}
                      </td>
                      <td className="flex flex-wrap gap-2">
                        {gesperrt ? (
                          <ActionButton
                            endpoint={`/api/security/users/${konto.id}/unlock`}
                            label="Entsperren"
                            confirm={`Die Sperre für ${konto.email} sofort aufheben? Das Passwort bleibt unverändert — die Person meldet sich selbst an.`}
                            confirmTitle="Kontosperre aufheben"
                            successMessage="Die Sperre wurde aufgehoben."
                          />
                        ) : null}
                        <ActionButton
                          endpoint={`/api/security/users/${konto.id}/revoke-sessions`}
                          label="Sitzungen beenden"
                          variant="ghost"
                          confirm={`Alle Sitzungen von ${konto.email} sofort beenden? Die Person wird auf allen Geräten abgemeldet.`}
                          confirmTitle="Alle Sitzungen beenden"
                          successMessage="Alle Sitzungen wurden beendet."
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        </ListCard>
      ) : null}

      {ereignisse.eintraege.length === 0 ? (
        <EmptyState
          title="Keine Ereignisse"
          description="Festgehalten werden Anmeldungen und Fehlversuche, Sperren, Änderungen am zweiten Faktor, Sitzungswiderrufe, Rollenwechsel, ausgestellte Zugangslinks und Dateibefunde."
        />
      ) : (
        <ListCard
          footer={
            <Pagination
              page={ereignisse.seite}
              totalPages={seiten}
              total={ereignisse.gesamt}
              baseHref={basisHref}
            />
          }
        >
          <TableScroll minWidth="62rem">
            <table className="data-table">
              <caption className="sr-only">
                Sicherheitsereignisse. {ereignisse.gesamt} Einträge.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Zeitpunkt</th>
                  <th scope="col">Schwere</th>
                  <th scope="col">Was</th>
                  <th scope="col">Wen</th>
                  <th scope="col">Zusammenhang</th>
                  <th scope="col">Bestätigt</th>
                </tr>
              </thead>
              <tbody>
                {ereignisse.eintraege.map((e) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap tabular-nums text-muted-foreground">
                      {formatDateTime(e.occurredAt)}
                    </td>

                    <td>
                      <Badge variant={SCHWERE_VARIANTE[e.severity]} size="sm">
                        {SCHWERE_LABEL[e.severity]}
                      </Badge>
                      <span className="mt-1 block text-2xs text-muted-foreground">
                        {KATEGORIE_LABEL[e.category]}
                      </span>
                    </td>

                    <td className="cell-wide">
                      <span className="block font-medium">{bezeichnung(e.kind)}</span>
                      <span className="block text-xs leading-relaxed text-muted-foreground">
                        {e.summary}
                      </span>
                    </td>

                    <td>
                      {e.user ? (
                        <>
                          <span className="block">
                            {e.user.firstName} {e.user.lastName}
                          </span>
                          <span className="block text-2xs text-muted-foreground">
                            {e.user.email}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                      {e.ip ? (
                        <span className="block font-mono text-2xs text-muted-foreground">
                          {e.ip}
                        </span>
                      ) : null}
                    </td>

                    <td className="cell-wide">
                      <Zusammenhang context={e.context} />
                    </td>

                    <td>
                      {e.acknowledgedAt ? (
                        <>
                          <span className="block text-xs">
                            {e.acknowledgedBy
                              ? `${e.acknowledgedBy.firstName} ${e.acknowledgedBy.lastName}`
                              : 'bestätigt'}
                          </span>
                          <span className="block text-2xs tabular-nums text-muted-foreground">
                            {formatDateTime(e.acknowledgedAt)}
                          </span>
                          {e.acknowledgedNote ? (
                            <span className="mt-1 block text-2xs leading-relaxed text-muted-foreground">
                              {e.acknowledgedNote}
                            </span>
                          ) : null}
                        </>
                      ) : e.severity === 'CRITICAL' ? (
                        <ActionButton
                          endpoint={`/api/security/events/${e.id}/acknowledge`}
                          label="Bestätigen"
                          withNote
                          noteLabel="Einordnung (freiwillig)"
                          confirmTitle="Ereignis bestätigen"
                          confirm="Das Ereignis wird als angesehen markiert. Es bleibt sichtbar — bestätigen heisst nicht löschen."
                          successMessage="Das Ereignis wurde bestätigt."
                        />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </ListCard>
      )}
    </div>
  );
}

/**
 * Die Bezeichnung zu einer Art.
 *
 * `kind` ist in der Datenbank eine freie Zeichenkette (siehe `events.ts`),
 * eine Zeile kann also eine Art tragen, die es im Code nicht mehr gibt — etwa
 * nach einer Umbenennung. Dann wird die Art selbst gezeigt, statt dass die
 * Zelle leer bleibt.
 */
function bezeichnung(kind: string): string {
  return SECURITY_EVENTS[kind as keyof typeof SECURITY_EVENTS]?.label ?? kind;
}

/**
 * Der Zusammenhang als Liste statt als JSON-Klumpen.
 *
 * Dieselbe Überlegung wie bei den Änderungen im Prüfprotokoll: Die
 * gespeicherte Form ist ehrlich und unlesbar, und unlesbar heisst, dass
 * niemand hinsieht.
 */
function Zusammenhang({ context }: { context: unknown }) {
  if (!context || typeof context !== 'object') {
    return <span className="text-muted-foreground">—</span>;
  }

  const eintraege = Object.entries(context as Record<string, unknown>).slice(0, 6);
  if (eintraege.length === 0) return <span className="text-muted-foreground">—</span>;

  return (
    <dl className="space-y-0.5">
      {eintraege.map(([feld, wert]) => (
        <div key={feld} className="text-2xs leading-relaxed">
          <dt className="inline font-mono text-muted-foreground">{feld}</dt>
          <dd className="inline"> {darstellen(wert)}</dd>
        </div>
      ))}
    </dl>
  );
}

function darstellen(wert: unknown): string {
  if (wert === null || wert === undefined) return 'leer';
  if (typeof wert === 'boolean') return wert ? 'ja' : 'nein';
  if (typeof wert === 'object') return JSON.stringify(wert).slice(0, 60);
  const text = String(wert);
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}
