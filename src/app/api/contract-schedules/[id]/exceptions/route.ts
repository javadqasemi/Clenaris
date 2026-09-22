import { defineRoute } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { scheduleExceptionSchema } from '@/lib/validation/contracts';
import { idParam } from '@/lib/validation/queries';
import { addScheduleException } from '@/server/services/contract-schedule.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/contract-schedules/{id}/exceptions — einen einzelnen Termin
 * aussetzen, verschieben oder zusätzlich ansetzen.
 *
 * Getrennt von der Serie, weil eine Ausnahme keine Regeländerung ist: Wer
 * einen Termin wegen einer Betriebsferienwoche verschiebt, will nicht den
 * Vertrag ändern — und eine Regeländerung wäre eine neue Vertragsversion.
 *
 * `contract:update` statt `contract:version`: Einen Termin zu verschieben ist
 * Tagesgeschäft, und die Betriebsleitung muss es können.
 *
 * Eine Ausnahme je Serientag — ein zweiter Eintrag für denselben Tag ersetzt
 * den ersten (`upsert`). Zwei Ausnahmen für denselben Tag wären keine feinere
 * Steuerung, sondern ein Widerspruch; der eindeutige Index in der Datenbank
 * hält das fest.
 */
export const POST = defineRoute({
  permissions: ['contract:update'],
  params: idParam,
  body: scheduleExceptionSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    created(
      await addScheduleException({
        organizationId: await getOrganizationId(),
        scheduleId: params.id,
        actorId: session.id,
        ip,
        input: body,
      }),
    ),
});
