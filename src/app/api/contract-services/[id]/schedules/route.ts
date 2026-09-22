import { defineRoute } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { serviceScheduleSchema } from '@/lib/validation/contracts';
import { idParam } from '@/lib/validation/queries';
import { createSchedule } from '@/server/services/contract-schedule.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/contract-services/{id}/schedules — einen Einsatzplan zu einer
 * Vertragsleistung anlegen.
 *
 * Eigener Pfad statt `/contracts/{id}/versions/{v}/services/{s}/schedules`:
 * Fünf Segmente sind vier zu viel, und die Leistung trägt ihre Zugehörigkeit
 * ohnehin. Die Mandantenprüfung läuft trotzdem über die ganze Kette —
 * Leistung → Version → Vertrag → Organisation — und nicht über die
 * Leistungskennung allein.
 *
 * Mehrere Pläne je Leistung sind der Normalfall, nicht die Ausnahme: „Büro
 * Mo/Mi/Fr früh" und „Treppenhaus jeden zweiten Dienstag" sind zwei Serien
 * derselben Position.
 */
export const POST = defineRoute({
  permissions: ['contract:version'],
  params: idParam,
  body: serviceScheduleSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    created(
      await createSchedule({
        organizationId: await getOrganizationId(),
        contractServiceId: params.id,
        actorId: session.id,
        ip,
        input: body,
      }),
    ),
});
