import type { Metadata } from 'next';
import Link from 'next/link';
import { AlertTriangle, Download, FileText, Wallet } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { prisma, toNumber } from '@/lib/db';
import { formatCurrency, formatDate } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { listPayslips } from '@/server/services/payroll.service';
import { ART_BESCHRIFTUNG, listPayrollRates } from '@/server/services/payroll-rates.service';
import { listPayrollItems, listWithholdingProfiles } from '@/server/services/payroll-stamm.service';
import { listSalaryCertificates } from '@/server/services/salary-certificate.service';
import { VERALTET_PRAEFIX } from '@/server/services/payroll-veraltet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import { DetailSection, EmptyState, ListCard, PageHeader, TableScroll } from '@/components/app/page-parts';
import { ActionButton } from '@/components/app/action-button';
import { FormDialog } from '@/components/app/resource-form';
import {
  POSITIONSART_LABEL,
  payrollItemFields,
  payrollRateFields,
  salaryCertificateFields,
  withholdingProfileFields,
} from '@/features/admin/payroll-fields';
import { monatsname } from '@/lib/payroll/monate';

export const metadata: Metadata = {
  title: 'Lohn',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Lohnverwaltung eines Monats.
 *
 * Bis 2026-09-23 gab es für die Lohnabrechnung Endpunkte, aber keine Seite:
 * Rechnen, Prüfen und Veröffentlichen ging nur über die Schnittstelle. Die
 * Seite zeigt den Monat in der Reihenfolge, in der er abgearbeitet wird —
 * Positionen erfassen, rechnen, Prüfungen erledigen, veröffentlichen —, und
 * daneben die Stammdaten, die die Zahlen tragen: Satzversionen mit Prüfstand,
 * Quellensteuerprofile, Lohnausweis-Aufstellungen.
 *
 * Lesen mit `payslip:read_all`; jede Schaltfläche fragt ihre eigene
 * Berechtigung ab, und der Endpunkt prüft noch einmal.
 */
export default async function PayrollPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const session = await requirePermission('payslip:read_all');
  const params = await searchParams;
  const organizationId = await getOrganizationId();

  const vormonat = new Date();
  vormonat.setUTCDate(1);
  vormonat.setUTCMonth(vormonat.getUTCMonth() - 1);
  const jahr = Number(params.jahr) || vormonat.getUTCFullYear();
  const monat = Math.min(12, Math.max(1, Number(params.monat) || vormonat.getUTCMonth() + 1));

  const darfRechnen = can(session.role, 'payslip:create');
  const darfVeroeffentlichen = can(session.role, 'payslip:publish');

  const [abrechnungen, saetze, positionen, qstProfile, ausweise, personal] = await Promise.all([
    listPayslips({ organizationId, year: jahr, month: monat }),
    darfRechnen ? listPayrollRates({ organizationId, year: jahr }) : Promise.resolve([]),
    darfRechnen ? listPayrollItems({ organizationId, year: jahr, month: monat }) : Promise.resolve([]),
    darfRechnen ? listWithholdingProfiles({ organizationId }) : Promise.resolve([]),
    listSalaryCertificates({ organizationId, year: jahr }),
    prisma.employee.findMany({
      where: { organizationId },
      select: { id: true, employeeNumber: true, active: true, user: { select: { firstName: true, lastName: true } } },
      orderBy: { employeeNumber: 'asc' },
    }),
  ]);
  const personen = personal.map((p) => ({
    value: p.id,
    label: `${p.user.firstName} ${p.user.lastName} (${p.employeeNumber})${p.active ? '' : ' — ausgetreten'}`,
  }));

  const offen = abrechnungen.eintraege.filter((p) => !p.published);
  const pruefungOffen = offen.filter((p) => p.reviewRequired && !p.reviewResolvedAt);
  const bereit = offen.filter((p) => !p.reviewRequired || p.reviewResolvedAt);
  const ungeprueft = bereit.some((p) => p.unverifiedRates);
  const ungepruefteSaetze = saetze.filter((s) => s.verification !== 'GEPRUEFT');

  const zurueck = monat === 1 ? { jahr: jahr - 1, monat: 12 } : { jahr, monat: monat - 1 };
  const vor = monat === 12 ? { jahr: jahr + 1, monat: 1 } : { jahr, monat: monat + 1 };

  return (
    <div className="space-y-8">
      <PageHeader
        title={`Lohn ${monatsname(monat)} ${jahr}`}
        description="Positionen erfassen, den Monat rechnen, Prüfungen erledigen, veröffentlichen. Eine veröffentlichte Abrechnung ist unveränderlich; Korrekturen gehören in einen späteren Monat."
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href={`/admin/lohn?jahr=${zurueck.jahr}&monat=${zurueck.monat}`}>← {monatsname(zurueck.monat)}</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/admin/lohn?jahr=${vor.jahr}&monat=${vor.monat}`}>{monatsname(vor.monat)} →</Link>
            </Button>
            {darfRechnen ? (
              <ActionButton
                endpoint="/api/payroll/run"
                body={{ year: jahr, month: monat }}
                label="Monat rechnen"
                confirm="Alle noch nicht veröffentlichten Abrechnungen dieses Monats werden mit dem aktuellen Stand neu gerechnet."
                successMessage="Monat gerechnet."
              />
            ) : null}
            {darfVeroeffentlichen && bereit.length > 0 ? (
              <ActionButton
                endpoint="/api/payroll/publish"
                body={{ payslipIds: bereit.map((p) => p.id), trotzUngepruefterSaetze: ungeprueft }}
                label={`${bereit.length} veröffentlichen`}
                confirmTitle="Abrechnungen veröffentlichen"
                confirm={
                  (ungeprueft
                    ? 'Achtung: Mindestens eine Abrechnung wurde mit ungeprüften Beitragssätzen gerechnet. Mit dem Veröffentlichen bestätigen Sie das ausdrücklich. '
                    : '') +
                  'Veröffentlichte Abrechnungen sind für die Mitarbeitenden sichtbar und lassen sich nicht mehr ändern.'
                }
                successMessage="Veröffentlicht."
              />
            ) : null}
          </>
        }
      />

      {ungepruefteSaetze.length > 0 ? (
        <Alert variant="warning">
          {ungepruefteSaetze.length} Satzversion(en) für {jahr} sind nicht fachlich bestätigt — darunter Vorbelegungen, die
          Clenaris selbst angelegt hat. Bitte mit Police, Kreisschreiben oder Treuhand abgleichen und bestätigen.
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ['Abrechnungen', String(abrechnungen.eintraege.length)],
          ['Bruttolohn', formatCurrency(abrechnungen.summeBrutto)],
          ['Auszahlung', formatCurrency(abrechnungen.summeNetto)],
          ['Beiträge des Betriebs', formatCurrency(abrechnungen.summeArbeitgeber)],
        ].map(([label, wert]) => (
          <div key={label} className="rounded-lg border border-border bg-card p-4 shadow-soft">
            <p className="text-meta text-muted-foreground">{label}</p>
            <p className="font-display text-title tabular-nums">{wert}</p>
          </div>
        ))}
      </div>

      <DetailSection
        title="Abrechnungen"
        description={pruefungOffen.length > 0 ? `${pruefungOffen.length} Abrechnung(en) warten auf eine Prüfung.` : undefined}
        body="flush"
      >
        {abrechnungen.eintraege.length === 0 ? (
          <EmptyState
            className="m-4"
            icon={<Wallet aria-hidden />}
            title="Noch nicht gerechnet"
            description={'Nach dem Monatsende „Monat rechnen" — nur freigegebene Zeiten zählen.'}
          />
        ) : (
          <ListCard>
            <TableScroll>
              <table className="data-table">
                <caption className="sr-only">Abrechnungen {monatsname(monat)} {jahr}</caption>
                <thead>
                  <tr>
                    <th scope="col">Person</th>
                    <th scope="col" className="text-right">Brutto</th>
                    <th scope="col" className="text-right">Quellensteuer</th>
                    <th scope="col" className="text-right">Auszahlung</th>
                    <th scope="col">Stand</th>
                    <th scope="col"><span className="sr-only">Aktionen</span></th>
                  </tr>
                </thead>
                <tbody>
                  {abrechnungen.eintraege.map((p) => {
                    const veraltet = p.reviewReason?.startsWith(VERALTET_PRAEFIX) ?? false;
                    const pruefen = p.reviewRequired && !p.reviewResolvedAt;
                    return (
                      <tr key={p.id}>
                        <td className="font-medium">
                          <Link href={`/admin/lohn/${p.id}`} className="hover:text-primary">
                            {p.employee.user.firstName} {p.employee.user.lastName}
                          </Link>
                          <span className="block text-xs text-muted-foreground">{p.employee.employeeNumber}</span>
                        </td>
                        <td className="num">{formatCurrency(toNumber(p.grossPay))}</td>
                        <td className="num text-muted-foreground">{formatCurrency(toNumber(p.withholdingTax))}</td>
                        <td className="num font-semibold">{formatCurrency(toNumber(p.netPay))}</td>
                        <td>
                          {p.published ? (
                            <Badge size="sm" variant="success">Veröffentlicht</Badge>
                          ) : pruefen ? (
                            <Badge size="sm" variant="warning" title={p.reviewReason ?? undefined}>
                              <AlertTriangle className="size-3" aria-hidden /> {veraltet ? 'Neu rechnen' : 'Prüfung'}
                            </Badge>
                          ) : (
                            <Badge size="sm" variant="neutral">Entwurf</Badge>
                          )}
                          {p.unverifiedRates && !p.published ? (
                            <Badge size="sm" variant="outline" className="ml-1">Sätze ungeprüft</Badge>
                          ) : null}
                        </td>
                        <td className="text-right">
                          {p.published && p.pdfFileId ? (
                            <Button asChild variant="ghost" size="sm">
                              <a href={`/api/payroll/payslips/${p.id}/pdf`} download>
                                <Download aria-hidden /> PDF
                              </a>
                            </Button>
                          ) : null}
                          {pruefen && !veraltet && darfVeroeffentlichen ? (
                            <ActionButton
                              endpoint={`/api/payroll/payslips/${p.id}/review`}
                              label="Prüfung freigeben"
                              confirmTitle="Prüfung freigeben"
                              confirm={p.reviewReason ?? 'Die Abrechnung ist zur Prüfung markiert.'}
                              withNote
                              noteField="note"
                              noteLabel="Was wurde geprüft?"
                              variant="ghost"
                              size="sm"
                            />
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
          </ListCard>
        )}
      </DetailSection>

      {darfRechnen ? (
        <DetailSection
          title="Lohnpositionen"
          description="Überstunden, Zulagen, Spesen, Korrekturen und Abzüge dieses Monats. Eine Änderung macht eine schon gerechnete Abrechnung veraltet."
          body="flush"
          action={
            <FormDialog
              title="Lohnposition erfassen"
              triggerLabel="Position"
              triggerVariant="outline"
              triggerSize="sm"
              endpoint="/api/payroll/items"
              successMessage="Position erfasst."
              fields={payrollItemFields(personen)}
              extra={{ year: jahr, month: monat }}
              values={{ type: 'ALLOWANCE' }}
            />
          }
        >
          {positionen.length === 0 ? (
            <p className="px-6 py-6 text-sm text-muted-foreground">Keine Positionen in diesem Monat.</p>
          ) : (
            <ul className="divide-y divide-border">
              {positionen.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-6 py-3 text-sm">
                  <span className="min-w-0">
                    <span className="font-medium">{i.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {i.employee.user.firstName} {i.employee.user.lastName} · {POSITIONSART_LABEL[i.type] ?? i.type}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums">{formatCurrency(toNumber(i.amount))}</span>
                    {i.payslip?.published ? (
                      <Badge size="sm" variant="success">Abgerechnet</Badge>
                    ) : (
                      <ActionButton endpoint={`/api/payroll/items/${i.id}`} method="DELETE" label="Entfernen" confirm="Position entfernen?" variant="ghost" size="sm" />
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </DetailSection>
      ) : null}

      {darfRechnen ? (
        <DetailSection
          title={`Beitragssätze ${jahr}`}
          description="Versionen mit Gültigkeit, Herkunft und Prüfstand. Gerechnet wird mit der Version, die am Monatsletzten gilt; eine benutzte Version ist unveränderlich."
          body="flush"
          action={
            darfVeroeffentlichen ? (
              <FormDialog
                title="Neue Satzversion"
                description="Die bisherige Version wird am Vortag geschlossen. Für die berufliche Vorsorge (Schwellen und Altersbänder) die Schnittstelle verwenden."
                triggerLabel="Satzversion"
                triggerVariant="outline"
                triggerSize="sm"
                endpoint="/api/payroll/rates"
                successMessage="Satzversion angelegt."
                fields={payrollRateFields()}
              />
            ) : null
          }
        >
          <ListCard>
            <TableScroll>
              <table className="data-table">
                <caption className="sr-only">Satzversionen {jahr}</caption>
                <thead>
                  <tr>
                    <th scope="col">Art</th>
                    <th scope="col">Gültig</th>
                    <th scope="col" className="text-right">Arbeitnehmende</th>
                    <th scope="col" className="text-right">Betrieb</th>
                    <th scope="col">Quelle</th>
                    <th scope="col">Prüfstand</th>
                  </tr>
                </thead>
                <tbody>
                  {saetze.map((s) => (
                    <tr key={s.id}>
                      <td className="font-medium">{ART_BESCHRIFTUNG[s.code]}</td>
                      <td className="text-muted-foreground">
                        {formatDate(s.validFrom)} – {s.validUntil ? formatDate(s.validUntil) : 'offen'}
                      </td>
                      <td className="num">{toNumber(s.employeePct).toLocaleString('de-CH', { maximumFractionDigits: 4 })} %</td>
                      <td className="num">{toNumber(s.employerPct).toLocaleString('de-CH', { maximumFractionDigits: 4 })} %</td>
                      <td className="max-w-xs text-xs text-muted-foreground">{s.source}</td>
                      <td>
                        {s.verification === 'GEPRUEFT' ? (
                          <Badge size="sm" variant="success" title={s.verificationNote ?? undefined}>Geprüft</Badge>
                        ) : darfVeroeffentlichen ? (
                          <ActionButton
                            endpoint={`/api/payroll/rates/${s.id}/verify`}
                            label="Bestätigen"
                            confirmTitle={`${ART_BESCHRIFTUNG[s.code]} bestätigen`}
                            confirm="Sie bestätigen, dass dieser Satz mit der massgebenden Quelle übereinstimmt."
                            withNote
                            noteField="note"
                            noteLabel="Worauf stützt sich die Bestätigung?"
                            variant="outline"
                            size="sm"
                          />
                        ) : (
                          <Badge size="sm" variant="warning">Ungeprüft</Badge>
                        )}
                        {s.benutzt ? <Badge size="sm" variant="outline" className="ml-1">benutzt</Badge> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          </ListCard>
        </DetailSection>
      ) : null}

      {darfRechnen ? (
        <DetailSection
          title="Quellensteuer"
          description="Profile je Person. Clenaris liefert keine Tarife mit: Ohne eingelesene Tarifzeile wird keine Quellensteuer gerechnet, sondern eine Prüfung verlangt."
          body="flush"
          action={
            <FormDialog
              title="Quellensteuerprofil erfassen"
              triggerLabel="Profil"
              triggerVariant="outline"
              triggerSize="sm"
              endpoint="/api/payroll/withholding/profiles"
              successMessage="Profil erfasst."
              fields={withholdingProfileFields(personen)}
              values={{ canton: 'BE', children: 0 }}
            />
          }
        >
          {qstProfile.length === 0 ? (
            <p className="px-6 py-6 text-sm text-muted-foreground">Keine quellensteuerpflichtigen Personen erfasst.</p>
          ) : (
            <ul className="divide-y divide-border">
              {qstProfile.map((q) => (
                <li key={q.id} className="flex flex-wrap items-center justify-between gap-2 px-6 py-3 text-sm">
                  <span>
                    {q.employee.user.firstName} {q.employee.user.lastName}
                    <span className="block text-xs text-muted-foreground">
                      {q.canton} · {q.tariffCode} · ab {formatDate(q.validFrom)}
                      {q.validUntil ? ` bis ${formatDate(q.validUntil)}` : ''}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </DetailSection>
      ) : null}

      <DetailSection
        title={`Lohnausweis-Aufstellungen ${jahr}`}
        description="Verdichtung der veröffentlichten Abrechnungen auf die Ziffern des Lohnausweises — nicht das amtliche Formular 11. Die Zuordnung ist fachlich zu prüfen."
        body="flush"
        action={
          darfRechnen ? (
            <FormDialog
              title="Aufstellung verdichten"
              triggerLabel="Aufstellung"
              triggerVariant="outline"
              triggerSize="sm"
              endpoint="/api/payroll/certificates"
              successMessage="Aufstellung erstellt."
              fields={salaryCertificateFields(personen)}
              values={{ year: jahr }}
            />
          ) : null
        }
      >
        {ausweise.length === 0 ? (
          <p className="px-6 py-6 text-sm text-muted-foreground">Keine Aufstellung für {jahr}.</p>
        ) : (
          <ul className="divide-y divide-border">
            {ausweise.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-6 py-3 text-sm">
                <span>
                  <FileText className="mr-2 inline size-4 text-muted-foreground" aria-hidden />
                  {c.employee.user.firstName} {c.employee.user.lastName} · Version {c.version}
                </span>
                <span className="flex items-center gap-2">
                  {c.status === 'FINAL' ? (
                    <>
                      <Badge size="sm" variant="success">Abgeschlossen</Badge>
                      <Button asChild variant="ghost" size="sm">
                        <a href={`/api/payroll/certificates/${c.id}/pdf`} download>
                          <Download aria-hidden /> PDF
                        </a>
                      </Button>
                    </>
                  ) : (
                    <>
                      <Badge size="sm" variant="neutral">Entwurf</Badge>
                      {darfVeroeffentlichen ? (
                        <ActionButton
                          endpoint={`/api/payroll/certificates/${c.id}/finalize`}
                          label="Abschliessen"
                          confirm="Die Aufstellung wird als PDF abgelegt und ist danach unveränderlich; eine Korrektur ist eine neue Version."
                          variant="outline"
                          size="sm"
                        />
                      ) : null}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </DetailSection>
    </div>
  );
}
