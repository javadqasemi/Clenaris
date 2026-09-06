import { definePublicRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { getSession } from '@/lib/auth/session';
import { homeRouteFor } from '@/lib/auth/rbac';

export const runtime = 'nodejs';

/**
 * GET /api/auth/session — „Bin ich angemeldet, und wohin gehöre ich?"
 *
 * Architekturentscheid: Die öffentliche Website liest die Sitzung *nicht* im
 * Layout. Täte sie es, würde der Cookie-Zugriff jede Marketingseite dynamisch
 * machen — jeder Besuch eine Datenbankabfrage, obwohl sich der Inhalt
 * stündlich ändert. Stattdessen wird die Website statisch vorgerendert und
 * nur die Kopfzeile fragt hier nach.
 *
 * Die Antwort ist absichtlich mager: angemeldet ja/nein, Vorname und das Ziel
 * hinter „Mein Konto". Alles Weitere gehört in die Bereiche, die ohnehin
 * angemeldet sind.
 */
export const GET = definePublicRoute({
  handler: async () => {
    const session = await getSession();

    return ok(
      session
        ? {
            authenticated: true as const,
            firstName: session.firstName,
            role: session.role,
            accountHref: homeRouteFor(session.role),
          }
        : { authenticated: false as const },
      // Privat und kurzlebig: die Antwort hängt am Cookie und darf weder in
      // einem geteilten Cache noch länger als nötig liegen bleiben.
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  },
});
