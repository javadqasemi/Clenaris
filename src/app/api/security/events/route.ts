import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { securityEventQuerySchema } from '@/lib/validation/security';
import { getOrganizationId } from '@/server/services/organization.service';
import { listSecurityEvents } from '@/server/services/security.service';

export const runtime = 'nodejs';

/**
 * GET /api/security/events — der Ereignisstrom.
 *
 * Nur `security:read`, und das hat allein die Systemverantwortung. Die
 * Begründung steht bei `SUPER_ADMIN_ONLY` in `rbac.ts`: Diese Liste ist eine
 * Aufsicht über Personen, und wer beaufsichtigt wird, öffnet sie nicht.
 *
 * Die Antwort trägt keine Geheimnisse — das ist beim Schreiben entschieden
 * (`record.ts` redigiert `context`, die auslösenden Stellen halten Tokenwerte
 * ohnehin heraus). Hier wird deshalb nichts nachträglich gefiltert: Ein zweiter
 * Filter beim Lesen erzeugte den Eindruck, das Schreiben dürfe unsauber sein.
 */
export const GET = defineRoute({
  permissions: ['security:read'],
  query: securityEventQuerySchema,
  rateLimit: 'apiRead',
  handler: async ({ query }) => {
    const ergebnis = await listSecurityEvents({
      organizationId: await getOrganizationId(),
      category: query.category,
      severity: query.severity,
      nurOffen: query.nurOffen === 'true',
      userId: query.userId,
      seite: query.seite,
      proSeite: query.proSeite,
    });

    return ok(ergebnis);
  },
});
