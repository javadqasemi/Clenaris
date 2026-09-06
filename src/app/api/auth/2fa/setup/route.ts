import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { beginTwoFactorSetup } from '@/server/services/two-factor.service';

export const runtime = 'nodejs';

/**
 * POST /api/auth/2fa/setup — Geheimnis erzeugen und QR-Code liefern.
 *
 * Der Schutz wird dabei **nicht** eingeschaltet. Erst der bestätigte Code
 * unter `/api/auth/2fa/confirm` stellt ihn scharf — sonst sperrt sich aus,
 * wer den QR-Code scannt und dann das Telefon zurücksetzt, und niemand merkt
 * es bis zur nächsten Anmeldung.
 *
 * Ein bereits eingeschalteter Faktor wird nicht überschrieben: sonst genügte
 * ein Aufruf dieses Endpunkts, um den Schutz einer übernommenen Sitzung
 * unbrauchbar zu machen.
 */
export const POST = defineRoute({
  rateLimit: 'apiWrite',
  handler: async ({ session }) =>
    ok(await beginTwoFactorSetup({ userId: session.id, issuer: 'Clenaris' })),
});
