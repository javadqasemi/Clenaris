import { z } from 'zod';

import { defineRoute } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { contractServiceSchema, contractVersionSchema } from '@/lib/validation/contracts';
import { idParam } from '@/lib/validation/queries';
import { createContractVersion } from '@/server/services/contract.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/contracts/{id}/versions — eine neue Fassung anlegen.
 *
 * Die neue Version entsteht als **Entwurf**. Wirksam wird sie durch das
 * Aktivieren des Vertrags mit dem Stichtag — eine eigene Handlung mit eigenem
 * Recht, weil das Wirksamwerden die Zusage ist und das Verfassen nur der
 * Vorschlag.
 *
 * Ohne `services` wird der Leistungsumfang der geltenden Fassung **kopiert**,
 * samt Einsatzplänen. Das Kopieren ist der Kern der Versionierung: Eine
 * Version, die auf die Leistungen ihrer Vorgängerin zeigte, wäre kein eigener
 * Stand, sondern ein Zeiger — und eine spätere Änderung daran veränderte
 * rückwirkend, was unter der alten Fassung galt.
 *
 * Ein zweiter Entwurf wird abgewiesen (422). Zwei gleichzeitige Entwürfe wären
 * zwei Fassungen der Zukunft, von denen nur eine gelten kann.
 */
export const POST = defineRoute({
  permissions: ['contract:version'],
  params: idParam,
  body: z.object({
    version: contractVersionSchema,
    services: z.array(contractServiceSchema).max(100).optional(),
  }),
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    created(
      await createContractVersion({
        organizationId: await getOrganizationId(),
        contractId: params.id,
        actorId: session.id,
        ip,
        input: body.version,
        services: body.services,
      }),
    ),
});
