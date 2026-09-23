import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { contractActivateSchema, contractVersionParams } from '@/lib/validation/contracts';
import { activateContractVersion } from '@/server/services/contract.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/contracts/{id}/versions/{versionId}/activate — eine Folgefassung
 * an einem laufenden Vertrag in Kraft setzen („Fassung wechseln").
 *
 * Bis 2026-09-23 gab es diesen Weg nicht: `/activate` am Vertrag kannte nur
 * die erste Inkraftsetzung, und ACTIVE → ACTIVE ist kein Übergang. Nach dem
 * ersten Änderungsantrag liess sich an einem laufenden Vertrag keine Fassung
 * mehr wirksam machen (RB-002).
 *
 * In einer Transaktion hinter der Sperre des Vertragskopfs: bisherige Fassung
 * SUPERSEDED mit Gültigkeitsende = Stichtag, neue ACTIVE. Danach werden die
 * offenen Einsätze ab dem Stichtag auf die neue Fassung umgestellt oder
 * abgesagt und fehlende angelegt; die Antwort nennt die Zahlen.
 *
 * Abgewiesen (422): ein Stichtag vor heute oder nicht nach dem Beginn der
 * geltenden Fassung, eine Fassung in laufender Unterzeichnung, ein
 * abweichender Stichtag an einer angenommenen Fassung, eine Fassung ohne
 * Leistungen, ein Vertrag, der nicht läuft.
 *
 * Dieselbe Berechtigung wie die erste Inkraftsetzung — `contract:activate`,
 * die die Betriebsleitung ausdrücklich nicht hat.
 */
export const POST = defineRoute({
  permissions: ['contract:activate'],
  params: contractVersionParams,
  body: contractActivateSchema,
  rateLimit: 'apiWrite',
  handler: async ({ params, body, session, ip }) =>
    ok(
      await activateContractVersion({
        organizationId: await getOrganizationId(),
        contractId: params.id,
        versionId: params.versionId,
        actorId: session.id,
        ip,
        effectiveFrom: body.effectiveFrom,
        note: body.note,
      }),
    ),
});
