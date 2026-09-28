import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { payrollIdParam, payrollItemUpdateSchema } from '@/lib/validation/payroll';
import { getOrganizationId } from '@/server/services/organization.service';
import { deletePayrollItem, updatePayrollItem } from '@/server/services/payroll-stamm.service';

export const runtime = 'nodejs';

/**
 * PATCH /api/payroll/items/:id — eine Position ändern, solange sie in keine
 * veröffentlichte Abrechnung eingeflossen ist.
 */
export const PATCH = defineRoute({
  permissions: ['payslip:create'],
  params: payrollIdParam,
  body: payrollItemUpdateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(
      await updatePayrollItem({
        organizationId: await getOrganizationId(),
        id: params.id,
        actorId: session.id,
        ip,
        input: body,
      }),
    ),
});

/**
 * DELETE /api/payroll/items/:id — ausblenden (`deletedAt`), nicht löschen;
 * nur solange die Position nicht veröffentlicht ist.
 */
export const DELETE = defineRoute({
  permissions: ['payslip:create'],
  params: payrollIdParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) =>
    ok(await deletePayrollItem({ organizationId: await getOrganizationId(), id: params.id, actorId: session.id, ip })),
});
