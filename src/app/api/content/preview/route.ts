import { draftMode } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';

import { getSession } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { safeReturnPath } from '@/lib/auth/safe-redirect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/content/preview?pfad=/preise — Vorschaumodus einschalten.
 * GET /api/content/preview?aus=1       — wieder ausschalten.
 *
 * **Warum Next's Draft Mode und kein eigener Parameter.** Die öffentlichen
 * Seiten sind statisch vorgerendert. Ein selbstgebauter Vorschauparameter
 * würde entweder aus dem Zwischenspeicher bedient (und zeigte damit den
 * veröffentlichten statt den Entwurfsstand) oder müsste jede Seite dauerhaft
 * dynamisch machen — der Preis dafür wäre eine Datenbankabfrage bei jedem
 * Besuch der Marketingseiten. Draft Mode setzt ein signiertes Cookie, und Next
 * umgeht den Seitencache **nur für Anfragen mit diesem Cookie**. Alle anderen
 * bekommen weiterhin die statische Fassung.
 *
 * **Warum ein Endpunkt und keine Serverfunktion.** Die Vorschau läuft in einem
 * `iframe` innerhalb der Redaktionsmaske. Das Cookie muss also gesetzt sein,
 * *bevor* der Rahmen die Seite lädt — ein Endpunkt, den man einmal anfährt,
 * erledigt genau das.
 *
 * **Warum es die Betriebsart `nur=1` gibt.** Ursprünglich zeigte der Rahmen
 * direkt auf diesen Endpunkt und folgte der Weiterleitung. Das funktioniert bei
 * einem Aufruf im eigenen Tab, im `iframe` aber nicht: Chrome bricht die
 * weitergeleitete Navigation im Rahmen ab und stellt eine Fehlerseite dar, die
 * einem fremden Ursprung angehört — der Rahmen bleibt leer und selbst
 * `contentDocument` ist nicht mehr lesbar. Mit `nur=1` antwortet der Endpunkt
 * ohne Weiterleitung; die Maske schaltet den Vorschaumodus damit vorab per
 * `fetch` ein und lässt den Rahmen anschliessend die Seite *direkt* laden. Eine
 * Navigation, keine Weiterleitung — und damit nichts, woran der Rahmen
 * scheitern könnte.
 *
 * Der Zugang hängt am Schreibrecht für Inhalte: Wer den Vorschaumodus
 * einschaltet, sieht unveröffentlichte Texte. Das ist keine Kleinigkeit —
 * darunter können Preise stehen, die noch nicht gelten sollen.
 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, 'content:update')) {
    return new NextResponse('Nicht berechtigt.', { status: 403 });
  }

  const draft = await draftMode();

  if (request.nextUrl.searchParams.get('aus') === '1') {
    draft.disable();
    return NextResponse.redirect(new URL('/admin/inhalte', request.url));
  }

  draft.enable();

  /**
   * Nur einschalten, nicht weiterleiten. Das Cookie reist auf dieser Antwort
   * mit; wohin es danach geht, entscheidet die Maske selbst.
   *
   * `no-store`, damit ein Zwischenspeicher die Antwort nicht später ohne das
   * `Set-Cookie` ausliefert — der Vorschaumodus wäre dann scheinbar
   * eingeschaltet und die Seite zeigte trotzdem den veröffentlichten Stand.
   */
  if (request.nextUrl.searchParams.get('nur') === '1') {
    return new NextResponse(null, {
      status: 204,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  /**
   * Das Ziel kommt aus der URL und damit von aussen. Ohne Prüfung wäre dies
   * eine offene Weiterleitung — und zwar eine, die vorher noch ein Cookie
   * setzt, das unveröffentlichte Inhalte freischaltet.
   */
  const target = safeReturnPath(request.nextUrl.searchParams.get('pfad')) ?? '/';

  return NextResponse.redirect(new URL(target, request.url));
}
