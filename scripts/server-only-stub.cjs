/**
 * Ersatz für `server-only` ausserhalb von Next.js.
 *
 * Die Dienste beginnen mit `import 'server-only'`, damit Next sie nie in ein
 * Client-Bundle zieht. Das Modul ist innerhalb von Next ein Alias, ausserhalb
 * existiert es nicht — und das npm-Paket gleichen Namens wirft beim Laden
 * absichtlich einen Fehler. Skripte wie die Rückwärtsfüllung biegen den
 * Namen deshalb auf diese leere Datei um.
 */
module.exports = {};
