import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { contractNoticeSchema } from '@/lib/validation/contracts';
import { idParam } from '@/lib/validation/queries';
import { giveNotice } from '@/server/services/contract.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/contracts/{id}/notice — eine Kündigung erfassen.
 *
 * ---------------------------------------------------------------------------
 *  Was dieser Endpunkt ausdrücklich **nicht** tut
 * ---------------------------------------------------------------------------
 *
 * Er beurteilt die Kündigung nicht. Ob sie formgerecht, rechtzeitig und
 * wirksam ist, ist eine Rechtsfrage — Clenaris verwaltet Fristen und
 * Vertragsdaten, es legt sie nicht aus.
 *
 * Festgehalten wird: **wer** gekündigt hat (Kundschaft oder Firma), **wann**,
 * und zu welchem Datum es nach der hinterlegten Frist wirken würde. Dieses
 * Datum ist eine **Rechnung**, keine Feststellung: Es entsteht aus
 * Kündigungsfrist, Laufzeit und Verlängerungsart der geltenden
 * Vertragsversion und lässt sich überschreiben, wenn die Parteien sich anders
 * geeinigt haben.
 */
export const POST = defineRoute({
  permissions: ['contract:terminate'],
  params: idParam,
  body: contractNoticeSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(
      await giveNotice({
        organizationId: await getOrganizationId(),
        contractId: params.id,
        actorId: session.id,
        ip,
        noticeGivenBy: body.noticeGivenBy,
        noticeGivenAt: body.noticeGivenAt,
        terminationEffectiveAt: body.terminationEffectiveAt,
        reason: body.reason,
      }),
    ),
});
