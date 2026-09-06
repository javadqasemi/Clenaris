import { defineRoute, idParam } from '@/lib/api/handler';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { audit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { noContent, ok } from '@/lib/api/response';
import { can } from '@/lib/auth/rbac';
import { updateEmployeeSchema } from '@/lib/validation/operations';
import { getEmployeeDetail, updateEmployee } from '@/server/services/employee.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/employees/:id — Personalakte.
 *
 * Lohn, AHV-Nummer und Bankverbindung liefert der Dienst nur mit
 * `includeSensitive`. Die Schwelle dafür ist bewusst **nicht** das Lesen der
 * Akte, sondern `payslip:create` — wer Lohnabrechnungen erstellt, braucht die
 * Zahlen; die Betriebsleitung, die Einsätze plant und Ferien bewilligt,
 * braucht sie nicht. Das ist der Unterschied zwischen „darf die Akte sehen"
 * und „darf den Lohn sehen", und er ist nach DSG bedeutsam: es sind besonders
 * schützenswerte Personendaten.
 */
export const GET = defineRoute({
  permissions: ['employee:read'],
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params, session }) =>
    ok(
      await getEmployeeDetail({
        organizationId: await getOrganizationId(),
        employeeId: params.id,
        includeSensitive: can(session.role, 'payslip:create'),
      }),
    ),
});

/**
 * PATCH /api/employees/:id
 *
 * Lohn- und AHV-Angaben stecken im selben Schema. Sie sind besonders
 * schützenswerte Personendaten nach DSG; das Prüfprotokoll redigiert sie
 * bereits beim Schreiben.
 */
export const PATCH = defineRoute({
  permissions: ['employee:update'],
  params: idParam,
  body: updateEmployeeSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session }) => {
    const employee = await updateEmployee({
      organizationId: await getOrganizationId(),
      employeeId: params.id,
      input: body,
      actorId: session.id,
    });
    return ok({ id: employee.id });
  },
});

/**
 * DELETE /api/employees/:id — Mitarbeitende stilllegen.
 *
 * Kein Löschen, sondern `active: false` und ein Austrittsdatum. Eine
 * Personalakte hängt an Zeiterfassung, Lohnabrechnungen und Einsatzrapporten;
 * sie zu entfernen risse dort Lücken, die man Jahre später bei einer
 * Lohnprüfung wiederfindet. Der Zugang wird dabei entzogen — dafür ist die
 * Benutzerverwaltung zuständig, und der Verweis steht in der Antwort.
 */
export const DELETE = defineRoute({
  permissions: ['employee:delete'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    const organizationId = await getOrganizationId();
    const employee = await prisma.employee.findFirst({
      where: { id: params.id, organizationId },
      include: {
        user: { select: { id: true, email: true } },
        _count: { select: { assignments: true, timeEntries: true } },
      },
    });
    if (!employee) throw new NotFoundError('Mitarbeitende');

    const upcoming = await prisma.jobAssignment.count({
      where: { employeeId: params.id, job: { scheduledStart: { gte: new Date() }, deletedAt: null } },
    });
    if (upcoming > 0) {
      throw new BusinessRuleError(
        `Für diese Person sind ${upcoming} Einsätze geplant. Teilen Sie diese zuerst um — ` +
          'sonst steht am Einsatztag niemand vor der Tür.',
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.employee.update({
        where: { id: params.id },
        data: { active: false, terminatedAt: new Date() },
      });
      // Zugang entziehen: eine stillgelegte Person soll sich nicht mehr
      // anmelden können.
      if (employee.user) {
        await tx.user.update({ where: { id: employee.user.id }, data: { status: 'DISABLED' } });
      }
    });

    await audit.deleted({
      organizationId,
      userId: session.id,
      entity: 'Employee',
      entityId: params.id,
      summary:
        `Mitarbeitende ${employee.employeeNumber} stillgelegt ` +
        `(${employee._count.timeEntries} Zeiteinträge, ${employee._count.assignments} Einsätze bleiben erhalten)`,
      ip,
    });

    return noContent();
  },
});
