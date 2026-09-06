import { defineRoute } from '@/lib/api/handler';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { created, ok } from '@/lib/api/response';
import { ForbiddenError } from '@/lib/errors';
import { absenceRequestSchema } from '@/lib/validation/operations';
import { requestAbsence } from '@/server/services/employee.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/absences
 *
 * Abwesenheitsantrag aus dem Mitarbeitendenportal. Der Service zählt die
 * effektiven Arbeitstage (ohne Wochenenden und Feiertage), prüft
 * Überschneidungen und bei Ferien den Saldo.
 */
export const POST = defineRoute({
  permissions: ['absence:request'],
  body: absenceRequestSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session }) => {
    if (!session.profileId) {
      throw new ForbiddenError('Für Ihr Konto ist kein Mitarbeitendenprofil hinterlegt.');
    }

    const organizationId = await getOrganizationId();

    const absence = await requestAbsence({
      organizationId,
      employeeId: session.profileId,
      input: body,
    });

    return created({ id: absence.id, days: absence.days, status: absence.status });
  },
});

const listQuery = z.object({
  status: z.enum(['REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
  employeeId: z.string().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/**
 * GET /api/absences — Abwesenheitsgesuche.
 *
 * Mitarbeitende sehen ausschliesslich die eigenen. Das ist keine
 * Bequemlichkeit: wer wann in den Ferien war, ist eine Personalangabe und
 * geht die Kolleginnen und Kollegen nichts an.
 */
export const GET = defineRoute({
  permissions: ['absence:read_all', 'absence:request'],
  anyPermission: true,
  query: listQuery,
  rateLimit: 'apiRead',
  handler: async ({ query, session }) => {
    const { can } = await import('@/lib/auth/rbac');
    const organizationId = await getOrganizationId();
    const seesAll = can(session.role, 'absence:read_all');

    return ok(
      await prisma.absence.findMany({
        where: {
          employee: { organizationId },
          ...(seesAll
            ? query.employeeId
              ? { employeeId: query.employeeId }
              : {}
            : { employeeId: session.profileId ?? '__keines__' }),
          ...(query.status ? { status: query.status } : {}),
          ...(query.from || query.to
            ? {
                startDate: {
                  ...(query.from ? { gte: query.from } : {}),
                  ...(query.to ? { lte: query.to } : {}),
                },
              }
            : {}),
        },
        orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
        include: {
          employee: {
            select: {
              id: true,
              employeeNumber: true,
              user: { select: { firstName: true, lastName: true } },
            },
          },
        },
      }),
    );
  },
});
