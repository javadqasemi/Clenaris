import 'server-only';

import { draftMode } from 'next/headers';

/**
 * Läuft dieser Aufruf im Vorschaumodus?
 *
 * Gekapselt, weil `draftMode()` ausserhalb eines Request-Kontexts wirft — bei
 * der statischen Erzeugung zur Bauzeit gibt es keinen, und dort lautet die
 * Antwort ohnehin „nein". Ohne diese Kapselung müsste jede Aufrufstelle den
 * Versuch selbst absichern, und eine vergessene liesse den Seitenbau
 * scheitern.
 */
export async function isPreview(): Promise<boolean> {
  try {
    return (await draftMode()).isEnabled;
  } catch {
    return false;
  }
}
