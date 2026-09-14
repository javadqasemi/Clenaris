/**
 * Rücksprungziele aus der URL absichern.
 *
 * Nach der Anmeldung soll die Person dort landen, wo sie hinwollte. Das Ziel
 * steht im Abfrageparameter `weiter` — und der stammt damit aus der URL, also
 * von aussen. Ungeprüft weitergereicht ist er eine offene Weiterleitung: ein
 * Link der Form `…/auth/anmelden?weiter=https://…` führt nach erfolgreicher
 * Anmeldung auf eine fremde Seite, und zwar mit dem Vertrauensvorschuss, den
 * die eigene Domain in der Adresszeile erzeugt hat. Das ist der klassische
 * Aufbau einer Anmeldeseiten-Fälschung.
 *
 * Die Prüfung ist bewusst eine Erlaubnisliste, keine Sperrliste:
 *
 *  • Nur ein einzelner Schrägstrich am Anfang. `//example.com` ist für den
 *    Browser eine protokollrelative *absolute* URL, sieht aber wie ein Pfad
 *    aus — das ist der Fehler, den fast jede naive Prüfung macht.
 *  • Kein Backslash an zweiter Stelle: `/\example.com` behandeln mehrere
 *    Browser wie `//example.com`.
 *  • Kein Doppelpunkt vor dem ersten Schrägstrich, damit weder `javascript:`
 *    noch `data:` durchkommen.
 *
 * Welcher *Bereich* erlaubt ist, prüft diese Funktion nicht — das entscheidet
 * die Rolle, und zwar in der Middleware und in jeder Seite. Wer mit einem Ziel
 * ausserhalb seiner Rechte ankommt, wird dort auf die eigene Startseite
 * geleitet. Hier geht es allein darum, die eigene Domain nicht zu verlassen.
 */

/** Steuerzeichen und Leerzeichen — in einer URL immer ein Manipulationsversuch. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u0020\u007f]/;

export function safeReturnPath(value: string | null | undefined): string | null {
  if (!value) return null;

  const path = value.trim();
  if (path.length === 0 || path.length > 512) return null;

  // Muss ein absoluter Pfad auf dieser Domain sein.
  if (!path.startsWith('/')) return null;
  if (path.startsWith('//') || path.startsWith('/\\')) return null;

  // `javascript:`, `data:` und Konsorten — auch mit führendem Schrägstrich.
  const beforeSlash = path.slice(1).split('/')[0] ?? '';
  if (beforeSlash.includes(':')) return null;

  if (FORBIDDEN.test(path)) return null;

  return path;
}

/**
 * Rücksprungziel *oder* die rollenabhängige Startseite.
 *
 * `fallback` liefert der Server mit der Anmeldeantwort (`redirectTo`) — er
 * kennt die Rolle, der Browser nicht.
 */
export function resolveRedirect(returnTo: string | null | undefined, fallback: string): string {
  return safeReturnPath(returnTo) ?? fallback;
}
