import { NextResponse, type NextRequest } from 'next/server';

import { ACCESS_COOKIE, verifyAccessToken } from '@/lib/auth/jwt';
import { can, guardForPath, homeRouteFor, permissionForPath } from '@/lib/auth/rbac';

/**
 * Middleware: Routenschutz und Sicherheitskopfzeilen.
 *
 * Architekturentscheide:
 *  1. Die Middleware läuft in der Edge-Runtime und darf deshalb weder Prisma
 *     noch Node-APIs verwenden. Sie prüft ausschliesslich die *Signatur* des
 *     Access-Tokens — sie ist ein schneller Vorfilter, keine Autorisierung.
 *     Die verbindliche Prüfung passiert in jedem Route Handler und in jeder
 *     Server Component über `requirePermission()`.
 *  2. Gesperrte oder gelöschte Konten kommen hier durch, solange ihr Token
 *     gültig ist (max. 15 Minuten). Das ist bewusst in Kauf genommen: der
 *     Alternativpreis wäre ein Datenbankzugriff bei *jedem* Request.
 *  3. Bei fehlender Berechtigung wird nicht auf eine Fehlerseite geleitet,
 *     sondern auf die Startseite der eigenen Rolle — das ist die
 *     wahrscheinlichere Absicht der Nutzerin.
 */

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  const guard = guardForPath(pathname);
  if (!guard) return NextResponse.next();

  const token = request.cookies.get(ACCESS_COOKIE)?.value;
  const claims = token ? await verifyAccessToken(token) : null;

  // Nicht angemeldet → zur Anmeldung, mit Rücksprungziel.
  if (!claims) {
    const loginUrl = new URL('/auth/anmelden', request.url);
    loginUrl.searchParams.set('weiter', `${pathname}${search}`);

    const response = NextResponse.redirect(loginUrl);
    // Abgelaufene Cookies gleich entfernen, damit der Browser sie nicht
    // bei jedem weiteren Request mitschickt.
    response.cookies.delete(ACCESS_COOKIE);
    return response;
  }

  // Angemeldet, aber falscher Bereich → in den eigenen Bereich umleiten.
  if (!guard.roles.includes(claims.role)) {
    return NextResponse.redirect(new URL(homeRouteFor(claims.role), request.url));
  }

  // Richtiger Bereich, aber die Unterseite verlangt mehr → zurück an den
  // Bereichsanfang. Hier, vor dem Rendern, statt in der Seite: sobald die
  // Seite streamt, steht der Statuscode fest.
  const required = permissionForPath(pathname);
  if (required && !can(claims.role, required)) {
    return NextResponse.redirect(new URL(homeRouteFor(claims.role), request.url));
  }

  // Interne Bereiche nie indexieren oder zwischenspeichern.
  const response = NextResponse.next();
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  return response;
}

export const config = {
  matcher: [
    /*
     * Nur geschützte Bereiche prüfen. Statische Assets, Bilder und die
     * öffentliche Website laufen ohne Middleware — das spart bei jedem
     * Seitenaufruf einen Edge-Funktionsaufruf.
     */
    '/admin/:path*',
    '/portal/:path*',
    '/konto/:path*',
  ],
};
