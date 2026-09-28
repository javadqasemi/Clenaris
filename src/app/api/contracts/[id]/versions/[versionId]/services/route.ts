import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { contractServicesReplaceSchema, contractVersionParams as versionParams } from '@/lib/validation/contracts';
import { replaceContractServices } from '@/server/services/contract.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * PUT /api/contracts/{id}/versions/{versionId}/services — den
 * Leistungsumfang eines Entwurfs setzen.
 *
 * **`PUT`, nicht `PATCH`, und die Liste als Ganzes.** Dieselbe Entscheidung
 * wie bei Qualifikationen und Arbeitszeiten in Wave 7, und aus demselben
 * Grund: `PATCH` verspricht eine Teiländerung, und wer das erwartet, schickt
 * eine Position und verliert die anderen. Ersetzen ist ausserdem wettlauffrei
 * — kein Abgleich, der beim zweiten Absenden etwas anderes tut als beim
 * ersten.
 *
 * Möglich ist das nur, solange nichts an den Zeilen hängt, das ihre Kennung
 * braucht — und das ist bei einem **Entwurf** der Fall. Ist die Version aktiv,
 * verweigert der Dienst die Änderung ohnehin: An ihren Leistungen hängen dann
 * Einsatzpläne und Einsätze.
 */
export const PUT = defineRoute({
  permissions: ['contract:version'],
  params: versionParams,
  body: contractServicesReplaceSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(
      await replaceContractServices({
        organizationId: await getOrganizationId(),
        contractId: params.id,
        versionId: params.versionId,
        actorId: session.id,
        ip,
        services: body.services,
      }),
    ),
});
