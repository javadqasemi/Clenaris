import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { contractPauseSchema } from '@/lib/validation/contracts';
import { idParam } from '@/lib/validation/queries';
import { pauseContract } from '@/server/services/contract.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/contracts/{id}/pause — den Vertrag aussetzen.
 *
 * Pausieren ist nicht kündigen: Der Vertrag besteht weiter, es wird nur in
 * einem Zeitraum nicht geleistet — Bauarbeiten, Leerstand, Saison. Wirkung
 * hat es beim Serienplaner, der in diesem Fenster keine Einsätze mehr erzeugt.
 *
 * Ohne diesen Zustand bliebe nur, die Einsatzpläne stillzulegen und später
 * wieder einzuschalten. Das wäre dasselbe in unwiederbringlich: Der Grund der
 * Pause und ihr Zeitraum stünden nirgends, und beim Wiedereinschalten wüsste
 * niemand mehr, welche Pläne vorher aktiv waren.
 */
export const POST = defineRoute({
  permissions: ['contract:activate'],
  params: idParam,
  body: contractPauseSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(
      await pauseContract({
        organizationId: await getOrganizationId(),
        contractId: params.id,
        actorId: session.id,
        ip,
        pausedFrom: body.pausedFrom,
        pausedUntil: body.pausedUntil,
        reason: body.reason,
      }),
    ),
});
