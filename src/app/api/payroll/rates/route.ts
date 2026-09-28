import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { payrollRateCreateSchema, payrollRateQuerySchema } from '@/lib/validation/payroll';
import { getOrganizationId } from '@/server/services/organization.service';
import { createPayrollRate, listPayrollRates } from '@/server/services/payroll-rates.service';

export const runtime = 'nodejs';

/**
 * GET /api/payroll/rates — die Satzversionen, optional je Jahr oder Art.
 *
 * Ersetzt `/api/payroll/settings` (eine Zeile je Jahr). Jede Version trägt
 * Gültigkeit, Arbeitnehmer- und Arbeitgeberanteil, Herkunft und Prüfstand —
 * und ob schon eine veröffentlichte Abrechnung mit ihr gerechnet wurde
 * (`benutzt`); dann ist sie unveränderlich.
 */
export const GET = defineRoute({
  permissions: ['payslip:create'],
  query: payrollRateQuerySchema,
  rateLimit: 'apiRead',
  handler: async ({ query }) =>
    ok(await listPayrollRates({ organizationId: await getOrganizationId(), year: query.year, code: query.code })),
});

/**
 * POST /api/payroll/rates — eine neue Version anlegen.
 *
 * Eigene Berechtigung (`payslip:publish`): Wer hier eine Zahl ändert, ändert
 * den Nettolohn aller Mitarbeitenden ab dem Beginn der Version. Die
 * Vorgängerin wird am Vortag geschlossen — aber nie so, dass ein bereits
 * veröffentlichter Monat seine Version verlöre.
 */
export const POST = defineRoute({
  permissions: ['payslip:publish'],
  body: payrollRateCreateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) =>
    created(await createPayrollRate({ organizationId: await getOrganizationId(), actorId: session.id, ip, input: body })),
});
