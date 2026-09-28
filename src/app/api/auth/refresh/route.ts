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
 *
 * ---------------------------------------------------------------------------
 *  Warum die Weiterleitung **relativ** ist (Befund aus Gate 4D.1)
 * ---------------------------------------------------------------------------
 *
 * Hier stand `new URL(target, request.nextUrl.origin)`. `nextUrl.origin` folgt
 * aber nicht dem `Host`-Kopf der Anfrage, sondern nennt den Ursprung, unter
 * dem der Next-Server selbst lauscht. Gemessen am 2026-09-20 gegen den
 * Testserver: Eine Anfrage an `http://127.0.0.1:3001/api/auth/refresh`
 * antwortete mit `Location: http://localhost:3001/portal`.
 *
 * Das ist ein **Hostwechsel mitten in der Sitzungserneuerung**, und Cookies
 * sind hostgebunden. Die soeben gesetzten Zugangs- und Refresh-Cookies gelten
 * für den ursprünglichen Host und reisen nicht mit; auf dem neuen Host kommt
 * die Person unangemeldet an und landet auf der Anmeldemaske — obwohl die
 * Erneuerung gerade erfolgreich war. Hinter einem Reverse Proxy (der
 * Normalfall im Betrieb) trifft das jede stille Erneuerung, denn dort ist der
 * Ursprung des Servers nie der Ursprung, den die Person in der Adresszeile
 * sieht.
 *
 * Gefunden hat es die Browserprüfung: Über HTTP war der 303 ein Erfolg, weil
 * niemand ihm folgte. Ein Browser folgt ihm.
 *
 * Ein relativer `Location`-Wert löst das Problem an der Wurzel statt es zu
 * konfigurieren: Der Browser setzt ihn gegen die Adresse ein, die er
 * tatsächlich angefragt hat — welcher Proxy auch immer davorsteht. Zulässig
 * ist das seit RFC 7231 ausdrücklich. Die offene Weiterleitung, die ein
 * ungeprüfter Pfad wäre, verhindert weiterhin `safeReturnPath`: Es lässt nur
 * einen einzelnen führenden Schrägstrich durch, also nie `//fremde.example`.
 */
export const GET = definePublicRoute({
  query: refreshRedirectQuery,
  rateLimit: 'apiWrite',
  handler: async ({ query }) => {
    const target = safeReturnPath(query.weiter) ?? '/';
    try {
      await refreshSession();
      return relativeWeiterleitung(target);
    } catch {
      const login = new URLSearchParams({ weiter: target, grund: 'abgelaufen' });
      return relativeWeiterleitung(`/auth/anmelden?${login.toString()}`);
    }
  },
});

/**
 * 303 mit relativem Ziel.
 *
 * `NextResponse.redirect` verlangt eine absolute Adresse und ist deshalb hier
 * nicht verwendbar; die Antwort wird von Hand gebaut. Die Cookies, die
 * `refreshSession()` über den Cookie-Speicher gesetzt hat, hängt Next
 * unabhängig davon an — sie gehören zur Anfrage, nicht zu diesem Objekt.
 */
function relativeWeiterleitung(ziel: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: ziel } });
}
