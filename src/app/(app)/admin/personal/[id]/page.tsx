import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Mail, Phone } from 'lucide-react';

import { toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { NotFoundError } from '@/lib/errors';
import { EmployeeDeactivateButton, EmployeeEditDialog } from '@/features/admin/employee-actions';
import { formatCurrency, formatDate, formatNumber, fullName } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { getEmployeeDetail, getVacationBalance } from '@/server/services/employee.service';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PersonAvatar } from '@/components/ui/primitives';
import { KpiTile } from '@/components/app/kpi-tile';
import { DetailRow, DetailSection, PageHeader, TableScroll } from '@/components/app/page-parts';

export const metadata: Metadata = {
  title: 'Mitarbeitende/r',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const EMPLOYMENT_LABELS: Record<string, string> = {
  FULL_TIME: 'Vollzeit',
  PART_TIME: 'Teilzeit',
  HOURLY: 'Im Stundenlohn',
  TEMPORARY: 'Befristet',
  APPRENTICE: 'Lernende/r',
  CONTRACTOR: 'Auf Mandat',
};

const ABSENCE_LABELS: Record<string, string> = {
  VACATION: 'Ferien',
  SICK: 'Krankheit',
  ACCIDENT: 'Unfall',
  MILITARY: 'Militär',
  MATERNITY: 'Mutterschaft',
  PATERNITY: 'Vaterschaft',
  UNPAID: 'Unbezahlt',
  TRAINING: 'Weiterbildung',
  PUBLIC_HOLIDAY: 'Feiertag',
  OTHER: 'Anderes',
};

const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

/**
 * Personalakte.
 *
 * Architekturentscheid: Lohn, AHV-Nummer und IBAN sieht ausschliesslich die
 * Rolle ADMIN. Die Einschränkung passiert im Service — `getEmployeeDetail`
 * liefert die Felder gar nicht erst aus, statt sie im Template auszublenden.
 * Ausgeblendetes HTML ist im Netzwerkprotokoll trotzdem sichtbar.
 */
export default async function StaffDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requirePermission('employee:read');
  const { id } = await params;
  const organizationId = await getOrganizationId();
  /**
   * Lohn und Bank sieht, wer Lohnabrechnungen erstellt — dieselbe Schwelle
   * wie `GET /api/employees/:id`. Zuvor stand hier `role === 'ADMIN'`, womit
   * die Systemverantwortung die Felder nicht sah, obwohl sie alles darf.
   */
  const isAdmin = can(session.role, 'payslip:create');
  const canEdit = can(session.role, 'employee:update');
  const canDeactivate = can(session.role, 'employee:delete');

  let employee;
  try {
    employee = await getEmployeeDetail({
      organizationId,
      employeeId: id,
      includeSensitive: isAdmin,
    });
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const vacation = await getVacationBalance(employee.id, new Date().getFullYear());

  const name = fullName(employee.user.firstName, employee.user.lastName);
  const payslips = 'payslips' in employee ? employee.payslips : [];

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/admin/personal">
          <ArrowLeft aria-hidden />
          Alle Mitarbeitenden
        </Link>
      </Button>

      <PageHeader
        title={name}
        description={`${employee.position} · Personalnummer ${employee.employeeNumber}`}
        actions={
          <>
            {employee.active ? (
              <Badge variant="success">Aktiv</Badge>
            ) : (
              <Badge variant="neutral">Ausgetreten</Badge>
            )}
            <Button asChild variant="outline">
              <a href={`mailto:${employee.user.email}`}>
                <Mail aria-hidden />
                E-Mail
              </a>
            </Button>
            {employee.user.phone ? (
              <Button asChild variant="outline">
                <a href={`tel:${employee.user.phone}`}>
                  <Phone aria-hidden />
                  Anrufen
                </a>
              </Button>
            ) : null}
            {canEdit ? (
              <EmployeeEditDialog
                employeeId={employee.id}
                sensitive={isAdmin}
                values={{
                  position: employee.position,
                  department: employee.department,
                  employmentType: employee.employmentType,
                  hiredAt: employee.hiredAt.toISOString().slice(0, 10),
                  workloadPct: employee.workloadPct,
                  vacationDaysPerYear: toNumber(employee.vacationDaysPerYear),
                  permitType: employee.permitType,
                  permitValidUntil: employee.permitValidUntil
                    ? employee.permitValidUntil.toISOString().slice(0, 10)
                    : null,
                  emergencyContact: employee.emergencyContact,
                  emergencyPhone: employee.emergencyPhone,
                  driverLicense: employee.driverLicense,
                  vehiclePlate: employee.vehiclePlate,
                  languages: employee.languages,
                  color: employee.color,
                  ...('hourlyRate' in employee
                    ? {
                        hourlyRate: employee.hourlyRate ? toNumber(employee.hourlyRate) : null,
                        monthlySalary: employee.monthlySalary
                          ? toNumber(employee.monthlySalary)
                          : null,
                        ahvNumber: employee.ahvNumber,
                        iban: employee.iban,
                      }
                    : {}),
                }}
              />
            ) : null}
            {canDeactivate || (!employee.active && canEdit) ? (
              <EmployeeDeactivateButton
                employeeId={employee.id}
                name={name}
                active={employee.active}
              />
            ) : null}
          </>
        }
      />

      <div className="flex items-center gap-4 rounded-2xl border border-border bg-card p-5 shadow-soft">
        <PersonAvatar
          firstName={employee.user.firstName}
          lastName={employee.user.lastName}
          src={employee.user.avatarUrl}
          color={employee.color}
          size="lg"
        />
        <div className="min-w-0">
          <p className="font-medium">{name}</p>
          <p className="truncate text-sm text-muted-foreground">{employee.user.email}</p>
        </div>
        <span
          className="ml-auto size-4 shrink-0 rounded-full ring-2 ring-border"
          style={{ backgroundColor: employee.color }}
          aria-label="Kalenderfarbe"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label="Ferienguthaben"
          value={`${formatNumber(vacation.remaining, 'de', 1)} Tage`}
          hint={`von ${formatNumber(vacation.entitlement, 'de', 1)} · ${formatNumber(vacation.taken, 'de', 1)} bezogen`}
        />
        <KpiTile label="Pensum" value={`${employee.workloadPct} %`} />
        <KpiTile label="Eintritt" value={formatDate(employee.hiredAt)} />
        <KpiTile
          label="Anstellung"
          value={EMPLOYMENT_LABELS[employee.employmentType] ?? employee.employmentType}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <DetailSection title="Stammdaten">
          <dl className="protocol-list">
            <DetailRow label="Funktion">{employee.position}</DetailRow>
            {employee.department ? (
              <DetailRow label="Abteilung">{employee.department}</DetailRow>
            ) : null}
            <DetailRow label="Telefon">{employee.user.phone ?? '—'}</DetailRow>
            <DetailRow label="Sprachen">{employee.languages.join(', ')}</DetailRow>
            <DetailRow label="Führerausweis">
              {employee.driverLicense ? `Ja${employee.vehiclePlate ? ` · ${employee.vehiclePlate}` : ''}` : 'Nein'}
            </DetailRow>
            {employee.permitType ? (
              <DetailRow label="Bewilligung">
                {employee.permitType}
                {employee.permitValidUntil
                  ? ` · gültig bis ${formatDate(employee.permitValidUntil)}`
                  : ''}
              </DetailRow>
            ) : null}
            {employee.emergencyContact ? (
              <DetailRow label="Notfallkontakt">
                {employee.emergencyContact}
                {employee.emergencyPhone ? ` · ${employee.emergencyPhone}` : ''}
              </DetailRow>
            ) : null}
            <DetailRow label="Letzte Anmeldung">
              {employee.user.lastLoginAt ? formatDate(employee.user.lastLoginAt) : 'Nie'}
            </DetailRow>
          </dl>
        </DetailSection>

        {isAdmin ? (
          <DetailSection title="Lohn und Bank">
            <dl className="protocol-list">
              <DetailRow label="Stundenansatz">
                {employee.hourlyRate ? formatCurrency(toNumber(employee.hourlyRate)) : '—'}
              </DetailRow>
              <DetailRow label="Monatslohn">
                {employee.monthlySalary ? formatCurrency(toNumber(employee.monthlySalary)) : '—'}
              </DetailRow>
              <DetailRow label="AHV-Nummer">{employee.ahvNumber ?? '—'}</DetailRow>
              <DetailRow label="IBAN">{employee.iban ?? '—'}</DetailRow>
            </dl>
            <p className="pb-4 text-xs leading-relaxed text-muted-foreground">
              Diese Angaben sind ausschliesslich für die Rolle Administration sichtbar. Jeder
              Aufruf wird im Prüfprotokoll vermerkt.
            </p>
          </DetailSection>
        ) : (
          <DetailSection title="Lohn und Bank">
            <p className="py-6 text-sm leading-relaxed text-muted-foreground">
              Lohn- und Bankdaten sind der Administration vorbehalten.
            </p>
          </DetailSection>
        )}
      </div>

      {employee.availability.length > 0 ? (
        <DetailSection title="Verfügbarkeit">
          <dl className="protocol-list">
            {employee.availability.map((slot) => (
              <DetailRow key={slot.id} label={WEEKDAYS[slot.weekday] ?? String(slot.weekday)}>
                {slot.startTime}–{slot.endTime}
              </DetailRow>
            ))}
          </dl>
        </DetailSection>
      ) : null}

      {employee.skills.length > 0 ? (
        <DetailSection title="Qualifikationen">
          <div className="flex flex-wrap gap-2 py-4">
            {employee.skills.map((skill) => (
              <Badge key={skill.id} variant="neutral">
                {skill.name}
                {skill.level ? ` · Stufe ${skill.level}` : ''}
              </Badge>
            ))}
          </div>
        </DetailSection>
      ) : null}

      <DetailSection title="Letzte Einsätze">
        {employee.assignments.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">Noch keine Einsätze zugewiesen.</p>
        ) : (
          <TableScroll>
            <table className="data-table">
              <caption className="sr-only">Einsätze</caption>
              <thead>
                <tr>
                  <th scope="col">Nummer</th>
                  <th scope="col">Auftrag</th>
                  <th scope="col">Datum</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {employee.assignments.map((assignment) => (
                  <tr key={assignment.id}>
                    <td>
                      <Link
                        href={`/admin/einsaetze/${assignment.job.id}`}
                        className="tabular-nums text-primary underline-offset-4 hover:underline"
                      >
                        {assignment.job.number}
                      </Link>
                    </td>
                    <td>{assignment.job.title}</td>
                    <td className="text-muted-foreground">
                      {formatDate(assignment.job.scheduledStart)}
                    </td>
                    <td>
                      <StatusBadge status={assignment.job.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </DetailSection>

      <div className="grid gap-6 lg:grid-cols-2">
        <DetailSection title="Abwesenheiten">
          {employee.absences.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">Keine erfassten Abwesenheiten.</p>
          ) : (
            <dl className="protocol-list">
              {employee.absences.slice(0, 12).map((absence) => (
                <DetailRow
                  key={absence.id}
                  label={`${formatDate(absence.startDate)} – ${formatDate(absence.endDate)}`}
                >
                  {ABSENCE_LABELS[absence.type] ?? absence.type} ·{' '}
                  {formatNumber(toNumber(absence.days), 'de', 1)} Tage ·{' '}
                  <StatusBadge status={absence.status} />
                </DetailRow>
              ))}
            </dl>
          )}
        </DetailSection>

        {isAdmin ? (
          <DetailSection title="Lohnabrechnungen">
            {payslips.length === 0 ? (
              <p className="py-6 text-sm text-muted-foreground">
                Noch keine Abrechnungen erstellt.
              </p>
            ) : (
              <dl className="protocol-list">
                {payslips.map((slip) => (
                  <DetailRow key={slip.id} label={`${slip.month}/${slip.year}`}>
                    {formatCurrency(toNumber(slip.grossPay))} brutto ·{' '}
                    {formatCurrency(toNumber(slip.netPay))} netto
                    {slip.published ? '' : ' · Entwurf'}
                  </DetailRow>
                ))}
              </dl>
            )}
          </DetailSection>
        ) : null}
      </div>
    </div>
  );
}
