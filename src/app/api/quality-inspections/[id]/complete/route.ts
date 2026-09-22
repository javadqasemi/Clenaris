import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { qualityInspectionCompleteSchema } from '@/lib/validation/quality';
import { idParam } from '@/lib/validation/queries';
import { getOrganizationId } from '@/server/services/organization.service';
import { completeInspection } from '@/server/services/quality.service';

export const runtime = 'nodejs';

/**
 * POST /api/quality-inspections/{id}/complete — die Begehung abschliessen.
 *
 * Ab hier ist sie ein **Beleg**: Nummer aus dem Nummernkreis,
 * Abschlusszeitpunkt, und danach weder änderbar noch löschbar. Beides
 * entsteht in *einer* Transaktion mit dem Zustand — dieselbe Regel wie bei
 * Rechnung und Vertrag. Die Nummer erst hier, damit ein verworfener Entwurf
 * keine Lücke hinterlässt; scheitert der Abschluss, rollt sie mit zurück.
 *
 * Abgewiesen wird (422): eine Begehung ohne Positionen, und eine, bei der
 * **keine** Position beurteilbar war. Die wäre ein Beleg über nichts, und die
 * Zahl darauf liesse sich von „null Punkte" nicht unterscheiden, sobald
 * jemand sie abschreibt.
 *
 * Nicht bestanden löst eine Meldung ans Büro aus — bestanden nicht. Eine
 * Meldung über jede gelungene Kontrolle wäre eine, die man nach einer Woche
 * wegklickt, und dann auch die eine, auf die es ankommt.
 */
export const POST = defineRoute({
  permissions: ['quality:complete'],
  params: idParam,
  body: qualityInspectionCompleteSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(
      await completeInspection({
        organizationId: await getOrganizationId(),
        inspectionId: params.id,
        actorId: session.id,
        ip,
        note: body.note,
      }),
    ),
});
