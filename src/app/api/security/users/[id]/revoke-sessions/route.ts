import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { getOrganizationId } from '@/server/services/organization.service';
import { beendeSitzungen } from '@/server/services/security.service';

export const runtime = 'nodejs';

/**
 * POST /api/security/users/:id/revoke-sessions — alle Sitzungen beenden.
 *
 * Die Handlung, für die das Sicherheitszentrum vor allem da ist: Ein Gerät ist
 * weg, ein Passwort ist abgeflossen, jemand hat gekündigt. Bis hierher liess
 * sich das nur über Umwege erreichen — Passwort zurücksetzen, zweiten Faktor
 * zurücksetzen —, und beides tut mehr, als man will.
 *
 * Der Dienst dahinter macht zwei Dinge zusammen (Erneuerungstokens widerrufen
 * **und** `sessionsRevokedAt` setzen); die Begründung, warum das Erste allein
 * nicht genügt, steht dort.
 *
 * **Keine Ausnahme für die eigene Sitzung.** Wer sich selbst aussperrt, meldet
 * sich neu an — das ist zumutbar. Eine Ausnahme wäre die Lücke, durch die ein
 * übernommenes Konto seine eigene Sitzung behält, während es alle anderen
 * hinauswirft.
 */
export const POST = defineRoute({
  permissions: ['security:manage'],
  params: idParam,
  rateLimit: 'apiWrite',
  handler: async ({ params, session, ip }) => {
    const ergebnis = await beendeSitzungen({
      organizationId: await getOrganizationId(),
      userId: params.id,
      actorId: session.id,
      ip,
    });

    return ok({ id: params.id, ...ergebnis });
  },
});
