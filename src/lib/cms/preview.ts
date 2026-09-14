import 'server-only';

import { draftMode, headers } from 'next/headers';

import { getSession } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';

/**
 * Läuft dieser Aufruf im Redaktionsrahmen — darf die Seite also
 * Bearbeitungsmarken tragen und den Entwurfsstand zeigen?
 *
 * **Drei Bedingungen, alle zugleich:**
 *
 *  1. Der Vorschaumodus ist eingeschaltet (Next Draft Mode, signiertes
 *     Cookie). Ohne ihn liefert Next die statische Seite aus, und diese
 *     Funktion wird gar nicht erst aufgerufen — der schnelle Weg für alle
 *     Besuchenden bleibt unberührt.
 *  2. Die Anfrage trägt eine Sitzung mit `content:update`. Das Cookie allein
 *     genügt nicht: Es entsteht zwar nur hinter derselben Berechtigung, aber
 *     ein Cookie, das in einem Browser liegt, ist keine Berechtigung — wer
 *     sich am selben Gerät als Kundschaft anmeldet, hätte sonst die Marken.
 *  3. Die Seite wird *im Rahmen der Redaktionsmaske* gerendert
 *     (`Sec-Fetch-Dest: iframe`). Das war die eigentliche Lücke: Das Cookie
 *     bleibt im Browser, nachdem die Maske einmal offen war, und galt danach
 *     für jeden Besuch der Website im selben Browser. Jede Überschrift zeigte
 *     beim Überfahren einen Rahmen und wurde beim Klick beschreibbar — auf
 *     der echten Website, nicht in der Maske. Browser ohne `Sec-Fetch-Dest`
 *     (Safari vor 16.4) erkennt der Rückgriff auf den Verweis: Die erste
 *     Navigation des Rahmens kommt von `/admin/inhalte`.
 *
 * Gekapselt, weil `draftMode()` und `headers()` ausserhalb eines
 * Request-Kontexts werfen — bei der statischen Erzeugung zur Bauzeit gibt es
 * keinen, und dort lautet die Antwort ohnehin „nein". Die Reihenfolge ist
 * bewusst: Erst das Cookie, dann Sitzung und Kopfzeilen. So rührt eine
 * Anfrage ohne Vorschau-Cookie weder Cookies noch Datenbank an.
 */
export async function isPreview(): Promise<boolean> {
  let draft = false;
  try {
    draft = (await draftMode()).isEnabled;
  } catch {
    return false;
  }
  if (!draft) return false;

  const session = await getSession().catch(() => null);
  if (!session || !can(session.role, 'content:update')) return false;

  let requestHeaders: Awaited<ReturnType<typeof headers>>;
  try {
    requestHeaders = await headers();
  } catch {
    return false;
  }

  const destination = requestHeaders.get('sec-fetch-dest');
  if (destination) return destination === 'iframe';

  const referer = requestHeaders.get('referer');
  if (!referer) return false;
  try {
    return new URL(referer).pathname.startsWith('/admin/inhalte');
  } catch {
    return false;
  }
}
