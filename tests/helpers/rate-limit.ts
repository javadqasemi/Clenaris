import { existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Rate-Limit-Zähler des Testservers zurücksetzen — aus dem Testprozess, über
 * das Dateisystem, ohne HTTP.
 *
 * **Warum nicht über einen Endpunkt.** Ein `/api/test/reset` im normalen Bau
 * wäre ein Endpunkt, den es in Produktion gibt und der Sicherheitsregeln
 * aufhebt. Deshalb schreibt der Testserver seine Zähler in ein Verzeichnis
 * (`CLENARIS_TEST_CACHE_DIR`, `src/lib/redis.ts`), und dieser Helfer löscht
 * dort die Dateien mit Präfix `rl:` — das ist alles, was er kann.
 *
 * **Warum überhaupt.** Alle Dateien der Reihe schreiben als dieselbe
 * Verwaltung; ihr Kontingent `apiWrite` (90 je Minute) war nach wenigen
 * Dateien voll, und der Klient wartete pro Lauf rund zwei Minuten auf die
 * nächste Fenstergrenze. Am 2026-09-20 fiel eine solche Wartezeit mit dem
 * Ablauf eines zwischengespeicherten Zugangstokens zusammen: 34 Fehlschläge
 * in `website-ops.test.ts`, alle 401, kein Produktfehler. Der Zähler wird
 * jetzt beim Start jeder Datei geleert (`loginAll`), und die Semantik der
 * Limits prüft `tests/api/rate-limit.test.ts` ausdrücklich — gegen den
 * echten Zähler, mit anschliessendem Aufräumen.
 *
 * Fehlt das Verzeichnis (Server ohne die Variable, entfernter Server), tut
 * der Helfer nichts, und die Reihe verhält sich wie zuvor: Sie wartet.
 */

export function testCacheDir(): string {
  return process.env.CLENARIS_TEST_CACHE_DIR?.trim() || join(tmpdir(), 'clenaris-tests', 'cache');
}

/** Steht der Testserver mit dateibasiertem Zähler bereit? */
export function rateLimitResetAvailable(): boolean {
  return existsSync(testCacheDir());
}

/** Alle `rl:*`-Zähler löschen. Gibt die Zahl der entfernten Einträge zurück. */
export function resetRateLimits(): number {
  const dir = testCacheDir();
  if (!existsSync(dir)) return 0;
  let entfernt = 0;
  for (const datei of readdirSync(dir)) {
    if (!datei.endsWith('.json')) continue;
    let key = '';
    try {
      key = Buffer.from(datei.slice(0, -5), 'base64url').toString('utf8');
    } catch {
      continue;
    }
    if (!key.startsWith('rl:')) continue;
    rmSync(join(dir, datei), { force: true });
    entfernt += 1;
  }
  return entfernt;
}
