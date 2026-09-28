import { cookies } from 'next/headers';

import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { SIGNATURE_COOKIE, signatureCookieOptions } from '@/lib/auth/signature-session';
import { currentSessionFamily } from '@/lib/auth/session';
import { BusinessRuleError } from '@/lib/errors';
import { requestContext } from '@/lib/http/request-context';
import { cancelCustomerHandoff, startCustomerHandoff } from '@/server/services/job.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/jobs/:id/handoff — die Kundenabnahme beginnen und das Gerät übergeben.
 *
 * **Was dieser Aufruf tut, in dieser Reihenfolge.** Der Server rendert den
 * Rapport, legt ihn unveränderlich ab und friert seinen SHA-256 ein (Hash A);
 * er legt den Unterzeichnungsvorgang an, stellt eine an den Teilnehmer
 * gebundene Signatursitzung für *dieses* Gerät aus — ohne je einen rohen
 * Zugang preiszugeben — und sperrt zuletzt die Mitarbeitersitzung.
 *
 * **Was er nicht tut: abmelden.** Die Sitzung bleibt bestehen, sie trägt nur
 * ab jetzt die Sperre. Freigegeben wird sie mit dem Passwort der Person, der
 * sie gehört — nicht durch Ablauf, nicht durch die Unterschrift, und nicht
 * durch eine Schaltfläche, die dem Kunden in die Hand fiele.
 *
 * Die Antwort nennt die nicht geheime Kennung des Vorgangs. Das
 * Signaturcookie setzt diese Route direkt; der Browser wechselt danach in
 * den Kundenmodus.
 */
export const POST = defineRoute({
  permissions: ['job:complete_assigned', 'job:update'],
  anyPermission: true,
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, request }) => {
    /**
     * Ohne Rotationsfamilie liesse sich die Sperre an keinen bestimmten
     * Browser binden — und eine Sperre, die nicht weiss, welches Gerät sie
     * meint, ist entweder wirkungslos oder sperrt zu viel.
     */
    const family = await currentSessionFamily();
    if (!family) {
      throw new BusinessRuleError(
        'Diese Sitzung lässt sich keinem Gerät zuordnen. Bitte melden Sie sich neu an und versuchen Sie es erneut.',
      );
    }

    const ergebnis = await startCustomerHandoff({
      organizationId: await getOrganizationId(),
      jobId: params.id,
      userId: session.id,
      employeeId: session.role === 'EMPLOYEE' ? (session.profileId ?? undefined) : undefined,
      sessionFamily: family,
      ctx: requestContext(request),
    });

    const store = await cookies();
    store.set(SIGNATURE_COOKIE, ergebnis.sessionToken, signatureCookieOptions());

    return ok(
      {
        handoffId: ergebnis.handoffId,
        signatureUrl: `/abnahme/${ergebnis.publicId}`,
        publicId: ergebnis.publicId,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  },
});

/**
 * DELETE /api/jobs/:id/handoff — eine begonnene Abnahme abbrechen.
 *
 * Erreichbar erst nach dem Entsperren: Solange das Gerät übergeben ist,
 * schlägt die Sperre in `defineRoute` zu (423). Das ist die Absicht — der
 * Abbruch gehört der Person, die das Gerät zurückbekommen hat, nicht der,
 * die es gerade hält.
 */
export const DELETE = defineRoute({
  permissions: ['job:complete_assigned', 'job:update'],
  anyPermission: true,
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, request }) => {
    const ergebnis = await cancelCustomerHandoff({
      organizationId: await getOrganizationId(),
      jobId: params.id,
      userId: session.id,
      employeeId: session.role === 'EMPLOYEE' ? (session.profileId ?? undefined) : undefined,
      ctx: requestContext(request),
    });
    return ok(ergebnis, { headers: { 'Cache-Control': 'no-store' } });
  },
});
