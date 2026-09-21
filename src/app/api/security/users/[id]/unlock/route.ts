import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { getOrganizationId } from '@/server/services/organization.service';
import { entsperreKonto } from '@/server/services/security.service';

export const runtime = 'nodejs';

/**
 * POST /api/security/users/:id/unlock — eine Kontosperre aufheben.
 *
 * Die Sperre nach acht Fehlversuchen läuft nach fünfzehn Minuten von selbst
 * ab. Dieser Endpunkt gibt es trotzdem, und zwar für den Fall, für den er
 * gebaut ist: Jemand steht vor einer Schicht und kommt nicht herein, weil die
 * Zwischenablage ein altes Passwort hielt.
 *
 * Er hebt **nur** die Sperre auf — kein neues Passwort, keine Sitzung. Wer
 * entsperrt wird, meldet sich selbst an; alles andere hiesse, dass die
 * Systemverantwortung einen Zugang herstellt, statt eine Sperre aufzuheben.
 */
export const POST = defineRoute({
  permissions: ['security:manage'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    await entsperreKonto({
      organizationId: await getOrganizationId(),
      userId: params.id,
      actorId: session.id,
      ip,
    });

    return ok({ id: params.id, entsperrt: true });
  },
});
