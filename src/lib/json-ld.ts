/**
 * Strukturierte Daten (JSON-LD) sicher in ein `<script>`-Element schreiben.
 *
 * **Warum `JSON.stringify` allein nicht genügt.** Der Inhalt eines
 * `<script>`-Elements wird vom Browser *nicht* als JSON gelesen, sondern als
 * Text bis zum ersten `</script>`. Steht diese Zeichenfolge in einem Wert —
 * etwa in einer Kundenbewertung, die auf `/bewertungen` als Rezension
 * ausgegeben wird — endet das Skript dort, und alles danach läuft als
 * Markup der Seite. Das ist ein gespeicherter XSS-Angriff mit Umweg über die
 * Moderation: Die Bewertung sieht in der Verwaltung harmlos aus, weil dort
 * escaped wird.
 *
 * Die Abhilfe ist, `<`, `>` und `&` als Unicode-Escapes zu schreiben. Für
 * einen JSON-Parser sind `<` und `<` dasselbe Zeichen; für den HTML-Parser
 * kommt die Zeichenfolge `</script>` nie zustande. Die Zeilentrenner U+2028
 * und U+2029 werden mit escaped, weil sie in JavaScript als Zeilenumbruch
 * gelten und ältere Parser daran scheitern — sie stehen hier als Zeichencode,
 * damit kein Editor sie stillschweigend in ein echtes Zeichen verwandelt.
 */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

export function jsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .split(LINE_SEPARATOR)
    .join('\\u2028')
    .split(PARAGRAPH_SEPARATOR)
    .join('\\u2029');
}
