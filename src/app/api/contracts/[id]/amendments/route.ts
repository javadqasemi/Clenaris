import { defineRoute } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { contractAmendmentCreateSchema } from '@/lib/validation/contracts';
import { idParam } from '@/lib/validation/queries';
import { createAmendment } from '@/server/services/contract-amendment.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/contracts/{id}/amendments — eine Vertragsänderung beantragen.
 *
 * **Der Antrag ist nicht die Änderung.** Er durchläuft Prüfung und Freigabe
 * und wird erst dann wirksam, indem er eine neue Vertragsversion erzeugt. Drei
 * Gründe, und der dritte wiegt am schwersten:
 *
 *  1. Eine Änderung braucht eine Zustimmung — ein eigener Vorgang mit eigenem
 *     Zeitpunkt und eigener Person.
 *  2. Zwischen Antrag und Wirksamkeit liegt fast immer ein Stichtag.
 *  3. **Die Version allein sagt nur, *dass* sich etwas geändert hat.** Warum,
 *     auf wessen Wunsch und wer zugestimmt hat, steht im Antrag — und genau
 *     danach wird gefragt, wenn ein halbes Jahr später jemand über den Preis
 *     stolpert.
 *
 * Ein zweiter offener Antrag wird abgewiesen (422): Zwei gleichzeitige
 * Anträge wären zwei Fassungen der Zukunft; wird der eine wirksam, bezieht
 * sich der andere auf eine Version, die es nicht mehr gibt.
 */
export const POST = defineRoute({
  permissions: ['contract:version'],
  params: idParam,
  body: contractAmendmentCreateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    created(
      await createAmendment({
        organizationId: await getOrganizationId(),
        contractId: params.id,
        actorId: session.id,
        ip,
        input: body,
      }),
    ),
});
