import { z } from 'zod';

import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { contractVersionSchema } from '@/lib/validation/contracts';
import { updateContractVersion } from '@/server/services/contract.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

const versionParams = z.object({ id: z.string().min(1), versionId: z.string().min(1) });

/**
 * PATCH /api/contracts/{id}/versions/{versionId} — einen Versionsentwurf
 * ändern.
 *
 * **Nur Entwürfe.** Eine geltende Fassung wird abgewiesen (422), und zwar
 * hier im Dienst und nicht in der Oberfläche: Der Preis eines laufenden
 * Vertrags ist die Grundlage ausgestellter Rechnungen. Wer ihn ändern will,
 * legt eine neue Version an — dann bleibt nachvollziehbar, ab wann was galt.
 *
 * `PATCH` mit vollständigem Rumpf: Das Schema verlangt alle Konditionen, nicht
 * eine Teilmenge. Eine Fassung, die nur im Zusammenhang mit ihrer Vorgängerin
 * lesbar wäre, ist keine Fassung.
 */
export const PATCH = defineRoute({
  permissions: ['contract:version'],
  params: versionParams,
  body: contractVersionSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(
      await updateContractVersion({
        organizationId: await getOrganizationId(),
        contractId: params.id,
        versionId: params.versionId,
        actorId: session.id,
        ip,
        input: body,
      }),
    ),
});
