import { defineRoute } from '@/lib/api/handler';
import { created, ok } from '@/lib/api/response';
import { requestContext } from '@/lib/http/request-context';
import { contractVersionParams as versionParams } from '@/lib/validation/contracts';
import { startContractAcceptance, withdrawContractAcceptance } from '@/server/services/contract.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';

/**
 * POST /api/contracts/{id}/versions/{versionId}/acceptance — die Fassung zur
 * elektronischen Annahme an die Kundschaft schicken.
 *
 * **Kein zweiter Signaturweg.** Es entsteht ein gewöhnlicher Vorgang des
 * bestehenden Signaturkerns: unveränderlicher Snapshot, Hash A,
 * versionierter Zustimmungstext, Protokoll, Ablauf. Neu ist allein die
 * vierte Quelle — unterzeichnet wird eine **Vertragsfassung**, nie „der
 * Vertrag": Was angenommen wird, sind konkrete Konditionen, und die stehen
 * in der Version.
 *
 * **Der Link geht nicht an die auslösende Person**, sondern per E-Mail an die
 * Kundschaft. Andernfalls könnte jemand aus dem Betrieb den Vertrag selbst
 * „annehmen", und der Beweis sähe aus wie eine Kundenunterschrift.
 *
 * **Einer, nicht vier.** Mehrfaches Auslösen versendet den bestehenden
 * Vorgang erneut (der alte Link verfällt), statt einen zweiten anzulegen —
 * erzwungen durch einen Teilindex, nicht durch die Oberfläche. In dem Fall
 * lautet die Antwort 200 statt 201.
 *
 * Ab dem Versand ist die Fassung **eingefroren**: Preis, Fristen und
 * Leistungsumfang lassen sich nicht mehr ändern, solange der Vorgang läuft.
 * Wer doch ändern will, zieht ihn zurück (DELETE).
 *
 * **Eigene Berechtigung.** `contract:sign` hat die Betriebsleitung
 * ausdrücklich nicht: Einen Vertrag zur Unterschrift zu geben ist eine Zusage
 * nach aussen, wie das Aktivieren und das Kündigen.
 *
 * Keine Aussage über QES oder ZertES: Der Vorgang belegt den Hergang, nicht
 * eine geprüfte Identität.
 */
export const POST = defineRoute({
  permissions: ['contract:sign'],
  params: versionParams,
  rateLimit: 'apiWrite',
  handler: async ({ params: p, session, request }) => {
    const ergebnis = await startContractAcceptance({
      organizationId: await getOrganizationId(),
      contractId: p.id,
      versionId: p.versionId,
      session,
      ctx: requestContext(request),
    });

    return ergebnis.erneutVersandt ? ok(ergebnis) : created(ergebnis);
  },
});

/**
 * DELETE /api/contracts/{id}/versions/{versionId}/acceptance — einen
 * laufenden Annahmevorgang zurückziehen.
 *
 * Der Weg, den die Einfrierung offenlässt: Wer die Konditionen doch noch
 * ändern will, zieht die Unterzeichnung zurück — sichtbar, protokolliert, mit
 * entwertetem Link. Eine stille Änderung am unterschriebenen Stand gibt es
 * dafür nicht.
 *
 * Eine bereits **angenommene** Fassung lässt sich nicht zurückziehen (422) —
 * dafür gibt es die neue Version. Snapshot und Protokoll bleiben in jedem
 * Fall erhalten; entwertet werden nur Links und Codes.
 */
export const DELETE = defineRoute({
  permissions: ['contract:sign'],
  params: versionParams,
  rateLimit: 'apiWrite',
  handler: async ({ params: p, session, ip, request }) =>
    ok(
      await withdrawContractAcceptance({
        organizationId: await getOrganizationId(),
        contractId: p.id,
        versionId: p.versionId,
        actorId: session.id,
        ip,
        ctx: requestContext(request),
      }),
    ),
});
