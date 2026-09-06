import { definePublicRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { destroySession } from '@/lib/auth/session';

export const runtime = 'nodejs';

/**
 * POST /api/auth/logout
 *
 * Widerruft den Refresh-Token in der Datenbank und löscht beide Cookies. Der
 * Access-Token bleibt bis zum Ablauf technisch gültig — er ist aber nach dem
 * Löschen des Cookies nicht mehr erreichbar, und ohne Refresh-Token endet die
 * Sitzung spätestens in 15 Minuten.
 */
export const POST = definePublicRoute({
  handler: async () => {
    await destroySession();
    return ok({ success: true });
  },
});
