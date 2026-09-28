import { z } from 'zod';

import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { idParam } from '@/lib/validation/queries';
import { cancelContract } from '@/server/services/contract.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/contracts/{id}/cancel — einen Entwurf stornieren.
 *
 * Der Unterschied zum Löschen: Stornieren behält die Zeile. Gedacht für den
 * Fall, der im Verkauf der häufigere ist — die Kundschaft springt ab, nachdem
 * der Vertrag schon vorlag. Dass es einen Vertrag gab und woran er scheiterte,
 * ist eine Auskunft; ein gelöschter Entwurf ist keine.
 *
 * Nur aus `DRAFT`, `IN_REVIEW` und `OFFERED`. Ein Vertrag, der in Kraft war,
 * wird beendet und nicht storniert — das ist die Regel des Zustandsautomaten,
 * nicht eine Höflichkeit der Oberfläche.
 */
export const POST = defineRoute({
  permissions: ['contract:delete_draft'],
  params: idParam,
  body: z.object({ reason: z.string().trim().max(2000).optional() }),
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(
      await cancelContract({
        organizationId: await getOrganizationId(),
        contractId: params.id,
        actorId: session.id,
        ip,
        reason: body.reason,
      }),
    ),
});
