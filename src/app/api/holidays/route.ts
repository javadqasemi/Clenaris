import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { createHolidaySchema } from '@/lib/validation/settings';
import { createHoliday, listHolidays } from '@/server/services/holiday.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * GET /api/holidays — Feiertage und Betriebsferien.
 *
 * Dieselbe Berechtigung wie die Öffnungszeiten: beides beschreibt, wann der
 * Betrieb arbeitet, und beides fliesst in den Buchungsassistenten ein.
 */
export const GET = defineRoute({
  permissions: ['company:read'],
  rateLimit: 'apiRead',
  handler: async () => ok(await listHolidays(await getOrganizationId())),
});

/** POST /api/holidays — Feiertag erfassen. */
export const POST = defineRoute({
  permissions: ['company:update'],
  body: createHolidaySchema,
  rateLimit: 'apiWrite',
  handler: async ({ body, session, ip }) => {
    const holiday = await createHoliday({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      input: body,
    });
    return created({ id: holiday.id, name: holiday.name, date: holiday.date });
  },
});
