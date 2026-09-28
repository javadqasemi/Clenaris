import { defineRoute } from '@/lib/api/handler';
import { created } from '@/lib/api/response';
import { contractAmendmentApplySchema, contractAmendmentParams } from '@/lib/validation/contracts';
import { applyAmendment } from '@/server/services/contract-amendment.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/contracts/{id}/amendments/{amendmentId}/apply — den freigegebenen
 * Antrag in eine Vertragsversion überführen.
 *
 * Das Ergebnis ist eine neue Version **im Entwurf**, nicht die sofortige
 * Umstellung: In Kraft tritt sie über `/activate` mit dem Stichtag. Die
 * Trennung ist dieselbe wie überall in diesem Modul — verfassen und in Kraft
 * setzen sind zwei Entscheidungen mit zwei Rechten.
 *
 * Danach trägt der Antrag beide Versionen, die abgelöste und die neue. Damit
 * ist „was genau hat sich geändert" beantwortbar, ohne zwei Zeilen von Hand
 * nebeneinanderzulegen.
 *
 * Der Rumpf trägt die **vollständigen** neuen Konditionen. Eine Version, die
 * aus „der Vorgängerin plus ein paar Feldern" entstünde, wäre nur im
 * Zusammenhang lesbar — und genau das soll eine Version nicht sein.
 */
export const POST = defineRoute({
  permissions: ['contract:version'],
  params: contractAmendmentParams,
  body: contractAmendmentApplySchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    created(
      await applyAmendment({
        organizationId: await getOrganizationId(),
        contractId: params.id,
        amendmentId: params.amendmentId,
        actorId: session.id,
        ip,
        version: body.version,
        services: body.services,
      }),
    ),
});
