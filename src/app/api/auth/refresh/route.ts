import { NextResponse } from 'next/server';

import { definePublicRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { safeReturnPath } from '@/lib/auth/safe-redirect';
import { refreshRedirectQuery } from '@/lib/validation/auth';
import { refreshSession } from '@/server/services/session-refresh.service';

export const runtime = 'nodejs';

/**
 * POST /api/auth/refresh — Sitzung erneuern, Antwort als JSON.
 *
 * Für den API-Klienten und den Aktivitätswächter im Browser. Die Regeln
 * (Rotation, Wiederverwendung, Leerlauffenster) stehen im Dienst.
 */
export const POST = definePublicRoute({
  // Jeder Aufruf kostet eine Datenbankabfrage und eine Signatur; ohne Bremse
  // wäre der Endpunkt der billigste Weg, den Server zu beschäftigen.
  rateLimit: 'apiWrite',
  handler: async () => ok(await refreshSession()),
});

/**
 * GET /api/auth/refresh?weiter=/admin/… — Sitzung erneuern und weiterleiten.
 *
 * Der Weg für Seitenaufrufe: Die Middleware läuft auf der Edge und kann den
 * Token nicht selbst erneuern (kein Prisma). Sie schickt den Browser deshalb
 * hierher; diese Route erneuert, setzt die Cookies und leitet an das
 * ursprüngliche Ziel zurück. Scheitert die Erneuerung, geht es zur
 * Anmeldung — mit demselben Rücksprungziel und einem Grund, den die Maske
 * anzeigen kann.
 *
 * `weiter` durchläuft `safeReturnPath`: sonst wäre diese Route eine offene
 * Weiterleitung, und zwar eine, die vor dem Sprung noch Cookies setzt.
 */
export const GET = definePublicRoute({
  query: refreshRedirectQuery,
  rateLimit: 'apiWrite',
  handler: async ({ query, request }) => {
    const target = safeReturnPath(query.weiter) ?? '/';
    try {
      await refreshSession();
      return NextResponse.redirect(new URL(target, request.nextUrl.origin), 303);
    } catch {
      const login = new URL('/auth/anmelden', request.nextUrl.origin);
      login.searchParams.set('weiter', target);
      login.searchParams.set('grund', 'abgelaufen');
      return NextResponse.redirect(login, 303);
    }
  },
});
