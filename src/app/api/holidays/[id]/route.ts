import { defineRoute, idParam } from '@/lib/api/handler';
import { noContent, ok } from '@/lib/api/response';
import { updateHolidaySchema } from '@/lib/validation/settings';
import { deleteHoliday, updateHoliday } from '@/server/services/holiday.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/** PATCH /api/holidays/:id — Name, Datum oder Wiederholung ändern. */
export const PATCH = defineRoute({
  permissions: ['company:update'],
  params: idParam,
  body: updateHolidaySchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) => {
    const holiday = await updateHoliday({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      holidayId: params.id,
      input: body,
    });
    return ok({ id: holiday.id, name: holiday.name, date: holiday.date });
  },
});

/**
 * DELETE /api/holidays/:id
 *
 * Nur künftige Tage. Ein vergangener Feiertag ist Grundlage der Ferien-
 * abrechnung des Jahres und bleibt stehen — die Antwort erklärt das.
 */
export const DELETE = defineRoute({
  permissions: ['company:update'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    await deleteHoliday({
      organizationId: await getOrganizationId(),
      actorId: session.id,
      ip,
      holidayId: params.id,
    });
    return noContent();
  },
});
