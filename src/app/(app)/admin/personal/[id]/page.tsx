import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ExternalLink, FileText, Mail, Phone, ShieldCheck } from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { can, ROLE_LABELS, type ActorRole } from '@/lib/auth/rbac';
import { NotFoundError } from '@/lib/errors';
import { USER_STATUS_LABELS } from '@/lib/validation/users';
import {
  EmployeeAccountActions,
  EmployeeDeactivateButton,
  EmployeeEditDialog,
  EmployeePhotoDialog,
} from '@/features/admin/employee-actions';
import { EMPLOYMENT_LABELS } from '@/features/admin/employee-labels';
import { DocumentUploadDialog } from '@/features/fuehrung/document-upload';
import { DOCUMENT_CATEGORY_LABELS } from '@/lib/bi/labels';
import {
  formatBytes,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatNumber,
  fullName,
} from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { getEmployeeDetail, getVacationBalance } from '@/server/services/employee.service';
import { documentVisibilityWhere } from '@/server/services/document.service';
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

const USER_STATUS_VARIANT: Record<string, 'success' | 'warning' | 'neutral' | 'info'> = {
  ACTIVE: 'success',
  PENDING: 'info',
  SUSPENDED: 'warning',
  DISABLED: 'neutral',
};

const toDateOnly = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null);

/**
 * Personalakte.
 *
 * Aufbau nach dem, was die Personalverwaltung nacheinander braucht: erst die
 * Person, dann die Anstellung, dann das Konto (Zugang, Sperre, Zugangslink),
 * dann Lohn und Lohnhistorie, dann Dokumente, dann die laufenden Dinge
 * (Einsätze, Abwesenheiten, Abrechnungen, Anmeldungen).
 *
 * Architekturentscheid: Lohn, AHV-Nummer und IBAN sieht ausschliesslich, wer
 * Lohnabrechnungen erstellt. Die Einschränkung passiert im Service —
 * `getEmployeeDetail` liefert die Felder gar nicht erst aus, statt sie im
 * Template auszublenden. Ausgeblendetes HTML ist im Netzwerkprotokoll
 * trotzdem sichtbar. Dasselbe gilt für Dokumente: Ihre Sichtbarkeit steht in
 * der Prisma-`where`-Klausel (`documentVisibilityWhere`).
 */
export default async function StaffDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requirePermission('employee:read');
  const { id } = await params;
  const organizationId = await getOrganizationId();

  const canSeeWages = can(session.role, 'payslip:create');
  const canEdit = can(session.role, 'employee:update');
  const canDeactivate = can(session.role, 'employee:delete');
  const canManageAccount = can(session.role, 'user:update');
  const canSeeLogins = can(session.role, 'user:read');
  const canResetTwoFactor = can(session.role, 'role:assign');
  const canUploadDocument = can(session.role, 'document:create');

  let employee;
  try {
    employee = await getEmployeeDetail({
      organizationId,
      employeeId: id,
      includeSensitive: canSeeWages,
    });
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const [vacation, documents, logins] = await Promise.all([
    getVacationBalance(employee.id, new Date().getFullYear()),
    prisma.managedDocument.findMany({
      where: {
        AND: [documentVisibilityWhere(session, organizationId), { subjectEmployeeId: employee.id }],
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        title: true,
        category: true,
        expiresOn: true,
        updatedAt: true,
        currentVersion: {
          select: { file: { select: { filename: true, sizeBytes: true } } },
        },
      },
    }),
    canSeeLogins
      ? prisma.auditLog.findMany({
          where: { userId: employee.user.id, action: 'LOGIN' },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { id: true, createdAt: true, ip: true, userAgent: true },
        })
      : Promise.resolve([]),
  ]);

  const name = fullName(employee.user.firstName, employee.user.lastName);
  const payslips = 'payslips' in employee ? employee.payslips : [];
  const salaryHistory = 'salaryHistory' in employee ? employee.salaryHistory : [];
  const self = employee.user.id === session.id;
  const address = [employee.street, [employee.postalCode, employee.city].filter(Boolean).join(' ')]
    .filter((part) => part && part.length > 0)
    .join(', ');

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
                sensitive={canSeeWages}
                values={{
                  firstName: employee.user.firstName,
                  lastName: employee.user.lastName,
                  email: employee.user.email,
                  phone: employee.user.phone,
                  employeeNumber: employee.employeeNumber,
                  position: employee.position,
                  department: employee.department,
                  employmentType: employee.employmentType,
                  hiredAt: employee.hiredAt.toISOString().slice(0, 10),
                  terminatedAt: toDateOnly(employee.terminatedAt),
                  workloadPct: employee.workloadPct,
                  vacationDaysPerYear: toNumber(employee.vacationDaysPerYear),
                  birthday: toDateOnly(employee.birthday),
                  nationality: employee.nationality,
                  street: employee.street,
                  postalCode: employee.postalCode,
                  city: employee.city,
                  languages: employee.languages,
                  color: employee.color,
                  permitType: employee.permitType,
                  permitValidUntil: toDateOnly(employee.permitValidUntil),
                  driverLicense: employee.driverLicense,
                  vehiclePlate: employee.vehiclePlate,
                  emergencyContact: employee.emergencyContact,
                  emergencyPhone: employee.emergencyPhone,
                  notes: employee.notes,
                  ...(canSeeWages
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

      <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-border bg-card p-5 shadow-soft">
        <PersonAvatar
          firstName={employee.user.firstName}
          lastName={employee.user.lastName}
          src={employee.user.avatarUrl}
          color={employee.color}
          size="lg"
        />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{name}</p>
          <p className="truncate text-sm text-muted-foreground">{employee.user.email}</p>
          <p className="text-meta text-muted-foreground">
            {ROLE_LABELS[employee.user.role as ActorRole] ?? employee.user.role}
            {employee.department ? ` · ${employee.department}` : ''}
          </p>
        </div>
        {canManageAccount ? (
          <EmployeePhotoDialog
            userId={employee.user.id}
            firstName={employee.user.firstName}
            lastName={employee.user.lastName}
            avatarUrl={employee.user.avatarUrl}
            color={employee.color}
          />
        ) : null}
        <span
          className="size-4 shrink-0 rounded-full ring-2 ring-border"
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
        <KpiTile
          label="Eintritt"
          value={formatDate(employee.hiredAt)}
          hint={employee.terminatedAt ? `Austritt ${formatDate(employee.terminatedAt)}` : undefined}
        />
        <KpiTile
          label="Anstellung"
          value={EMPLOYMENT_LABELS[employee.employmentType] ?? employee.employmentType}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <DetailSection title="Person">
          <dl className="protocol-list">
            <DetailRow label="Name">{name}</DetailRow>
            <DetailRow label="Geburtsdatum">
              {employee.birthday ? formatDate(employee.birthday) : '—'}
            </DetailRow>
            <DetailRow label="Adresse">{address || '—'}</DetailRow>
            <DetailRow label="Telefon">{employee.user.phone ?? '—'}</DetailRow>
            <DetailRow label="Nationalität">{employee.nationality ?? '—'}</DetailRow>
            <DetailRow label="Sprachen">{employee.languages.join(', ')}</DetailRow>
            <DetailRow label="Notfallkontakt">
              {employee.emergencyContact
                ? `${employee.emergencyContact}${employee.emergencyPhone ? ` · ${employee.emergencyPhone}` : ''}`
                : '—'}
            </DetailRow>
          </dl>
        </DetailSection>

        <DetailSection title="Anstellung">
          <dl className="protocol-list">
            <DetailRow label="Funktion">{employee.position}</DetailRow>
            <DetailRow label="Abteilung">{employee.department ?? '—'}</DetailRow>
            <DetailRow label="Anstellungsart">
              {EMPLOYMENT_LABELS[employee.employmentType] ?? employee.employmentType}
            </DetailRow>
            <DetailRow label="Eintritt">{formatDate(employee.hiredAt)}</DetailRow>
            <DetailRow label="Austritt">
              {employee.terminatedAt ? formatDate(employee.terminatedAt) : '—'}
            </DetailRow>
            <DetailRow label="Ferienanspruch">
              {formatNumber(toNumber(employee.vacationDaysPerYear), 'de', 1)} Tage pro Jahr
            </DetailRow>
            <DetailRow label="Bewilligung">
              {employee.permitType
                ? `${employee.permitType}${employee.permitValidUntil ? ` · gültig bis ${formatDate(employee.permitValidUntil)}` : ''}`
                : '—'}
            </DetailRow>
            <DetailRow label="Führerausweis">
              {employee.driverLicense
                ? `Ja${employee.vehiclePlate ? ` · ${employee.vehiclePlate}` : ''}`
                : 'Nein'}
            </DetailRow>
          </dl>
        </DetailSection>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <DetailSection
          title="Konto"
          description="Zugang zum Mitarbeiterportal. Rolle und Rechte ändern Sie in der Benutzerverwaltung."
          action={
            can(session.role, 'user:read') ? (
              <Button asChild variant="ghost" size="sm">
                <Link href="/admin/benutzer">
                  <ExternalLink aria-hidden />
                  Benutzerverwaltung
                </Link>
              </Button>
            ) : null
          }
        >
          <dl className="protocol-list">
            <DetailRow label="Login">{employee.user.email}</DetailRow>
            <DetailRow label="Rolle">
              {ROLE_LABELS[employee.user.role as ActorRole] ?? employee.user.role}
            </DetailRow>
            <DetailRow label="Status">
              <span className="flex flex-wrap items-center gap-2">
                <Badge variant={USER_STATUS_VARIANT[employee.user.status] ?? 'neutral'} size="sm">
                  {USER_STATUS_LABELS[employee.user.status as keyof typeof USER_STATUS_LABELS] ??
                    employee.user.status}
                </Badge>
                {employee.user.mustChangePassword ? (
                  <Badge variant="warning" size="sm">
                    Passwortwechsel ausstehend
                  </Badge>
                ) : null}
                {employee.user.twoFactorEnabled ? (
                  <span className="inline-flex items-center gap-1 text-xs text-success">
                    <ShieldCheck className="size-3.5" aria-hidden />
                    Zwei-Faktor aktiv
                  </span>
                ) : null}
              </span>
            </DetailRow>
            <DetailRow label="Letzte Anmeldung">
              {employee.user.lastLoginAt ? formatDateTime(employee.user.lastLoginAt) : 'Nie'}
            </DetailRow>
            <DetailRow label="Konto seit">{formatDate(employee.user.createdAt)}</DetailRow>
          </dl>
          {canManageAccount ? (
            <EmployeeAccountActions
              userId={employee.user.id}
              email={employee.user.email}
              status={employee.user.status}
              twoFactorEnabled={employee.user.twoFactorEnabled}
              mustChangePassword={employee.user.mustChangePassword}
              canResetTwoFactor={canResetTwoFactor}
              self={self}
            />
          ) : null}
        </DetailSection>

        {canSeeWages ? (
          <DetailSection
            title="Lohn und Bank"
            description="Sichtbar nur mit Lohneinblick. Jeder Aufruf steht im Prüfprotokoll."
          >
            <dl className="protocol-list">
              <DetailRow label="Stundenansatz">
                {employee.hourlyRate ? formatCurrency(toNumber(employee.hourlyRate)) : '—'}
              </DetailRow>
              <DetailRow label="Monatslohn (100 %)">
                {employee.monthlySalary ? formatCurrency(toNumber(employee.monthlySalary)) : '—'}
              </DetailRow>
              <DetailRow label="AHV-Nummer">{employee.ahvNumber ?? '—'}</DetailRow>
              <DetailRow label="IBAN">{employee.iban ?? '—'}</DetailRow>
            </dl>

            <div className="border-t border-border pt-3">
              <p className="text-meta font-medium">Lohnhistorie</p>
              {salaryHistory.length === 0 ? (
                <p className="py-3 text-sm text-muted-foreground">
                  Noch keine Einträge — die erste Lohnänderung über &bdquo;Bearbeiten&ldquo; legt
                  einen an.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {salaryHistory.map((record) => (
                    <li
                      key={record.id}
                      className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-sm"
                    >
                      <span className="tabular-nums text-muted-foreground">
                        ab {formatDate(record.validFrom)}
                      </span>
                      <span className="tabular-nums">
                        {record.hourlyRate ? `${formatCurrency(toNumber(record.hourlyRate))}/h` : ''}
                        {record.hourlyRate && record.monthlySalary ? ' · ' : ''}
                        {record.monthlySalary
                          ? `${formatCurrency(toNumber(record.monthlySalary))}/Mt.`
                          : ''}
                        {!record.hourlyRate && !record.monthlySalary ? 'kein Lohn hinterlegt' : ''}
                        {' · '}
                        {record.workloadPct} %
                      </span>
                      {record.reason ? (
                        <span className="w-full text-xs text-muted-foreground">{record.reason}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </DetailSection>
        ) : (
          <DetailSection title="Lohn und Bank">
            <p className="py-6 text-sm leading-relaxed text-muted-foreground">
              Lohn- und Bankdaten sind der Administration vorbehalten.
            </p>
          </DetailSection>
        )}
      </div>

      {employee.notes || canEdit ? (
        <DetailSection title="Interne Notizen" description="Nur für die Personalverwaltung sichtbar.">
          {employee.notes ? (
            <p className="whitespace-pre-line py-4 text-sm leading-relaxed">{employee.notes}</p>
          ) : (
            <p className="py-6 text-sm text-muted-foreground">
              Keine Notizen — über &bdquo;Bearbeiten&ldquo; hinterlegen.
            </p>
          )}
        </DetailSection>
      ) : null}

      <DetailSection
        title={`Dokumente (${documents.length})`}
        description="Verträge, Zeugnisse, Bewilligungen, Ausweise — abgelegt als Personaldokument, sichtbar für Geschäftsleitung und die Person selbst."
        action={
          canUploadDocument ? (
            <DocumentUploadDialog mode="create" employees={[{ id: employee.id, name }]} />
          ) : null
        }
      >
        {documents.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">Noch keine Dokumente abgelegt.</p>
        ) : (
          <ul className="protocol-list">
            {documents.map((document) => (
              <li key={document.id} className="flex flex-wrap items-center gap-3 py-3">
                <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/admin/fuehrung/dokumente/${document.id}`}
                    className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {document.title}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {DOCUMENT_CATEGORY_LABELS[document.category as keyof typeof DOCUMENT_CATEGORY_LABELS] ??
                      document.category}
                    {document.currentVersion?.file
                      ? ` · ${document.currentVersion.file.filename} · ${formatBytes(document.currentVersion.file.sizeBytes)}`
                      : ''}
                    {' · '}
                    {formatDate(document.updatedAt)}
                  </p>
                </div>
                {document.expiresOn ? (
                  <Badge
                    variant={document.expiresOn.getTime() < Date.now() ? 'warning' : 'neutral'}
                    size="sm"
                  >
                    {document.expiresOn.getTime() < Date.now() ? 'abgelaufen' : 'gültig bis'}{' '}
                    {formatDate(document.expiresOn)}
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </DetailSection>

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

        {canSeeWages ? (
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

      {canSeeLogins ? (
        <DetailSection
          title="Anmeldungen"
          description="Die letzten zehn erfolgreichen Anmeldungen aus dem Prüfprotokoll."
        >
          {logins.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">Noch keine Anmeldung.</p>
          ) : (
            <ul className="protocol-list">
              {logins.map((login) => (
                <li key={login.id} className="flex flex-wrap items-baseline justify-between gap-3 py-2.5 text-sm">
                  <span className="tabular-nums">{formatDateTime(login.createdAt)}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {login.ip ?? 'IP unbekannt'}
                    {login.userAgent ? ` · ${login.userAgent.slice(0, 60)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </DetailSection>
      ) : null}
    </div>
  );
}
