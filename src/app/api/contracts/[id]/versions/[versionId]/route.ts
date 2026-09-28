import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { contractVersionParams as versionParams, contractVersionSchema } from '@/lib/validation/contracts';
import { discardContractVersion, updateContractVersion } from '@/server/services/contract.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

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

/**
 * DELETE /api/contracts/{id}/versions/{versionId} — einen Versionsentwurf
 * verwerfen.
 *
 * Er wird nicht gelöscht, sondern `DISCARDED`: Ein zurückgezogener
 * Signaturvorgang zeigt auf ihn und ist ein Beleg. Abgewiesen (422): eine
 * Fassung, die gilt oder galt, eine angenommene Fassung, und die erste
 * Fassung eines Entwurfs — dafür wird der Vertragsentwurf verworfen.
 *
 * Ohne diesen Weg blieb ein ungewollter Entwurf für immer stehen und
 * blockierte jede weitere Änderung des Vertrags.
 */
export const DELETE = defineRoute({
  permissions: ['contract:version'],
  params: versionParams,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    await discardContractVersion({
      organizationId: await getOrganizationId(),
      contractId: params.id,
      versionId: params.versionId,
      actorId: session.id,
      ip,
    });
    return ok({ verworfen: true });
  },
});
