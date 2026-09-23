import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { withholdingRateImportSchema, withholdingRateQuerySchema } from '@/lib/validation/payroll';
import { getOrganizationId } from '@/server/services/organization.service';
import { importWithholdingRates, listWithholdingRates } from '@/server/services/payroll-stamm.service';

export const runtime = 'nodejs';

/** GET /api/payroll/withholding/rates — eingelesene Tarifzeilen und ihre Stapel. */
export const GET = defineRoute({
  permissions: ['payslip:create'],
  query: withholdingRateQuerySchema,
  rateLimit: 'apiRead',
  handler: async ({ query }) =>
    ok(
      await listWithholdingRates({
        organizationId: await getOrganizationId(),
        canton: query.canton,
        year: query.year,
        tariffCode: query.tariffCode,
      }),
    ),
});

/**
 * POST /api/payroll/withholding/rates — einen Tarifausschnitt einlesen.
 *
 * **Clenaris liefert keine Tarife mit.** Die Zeilen kommen aus der Datei der
 * kantonalen Steuerverwaltung; `source` ist Pflicht, eingelesen wird
 * ungeprüft. Bestehende Stufen werden nicht überschrieben.
 */
export const POST = defineRoute({
  permissions: ['payslip:publish'],
  body: withholdingRateImportSchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) =>
    created(await importWithholdingRates({ organizationId: await getOrganizationId(), actorId: session.id, ip, input: body })),
});
