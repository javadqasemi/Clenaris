import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readdirSync } from 'node:fs';

import { BASE_URL } from '../../helpers/client';
import { resetRateLimits, testCacheDir } from '../../helpers/rate-limit';
import { testDb, testDbGrund } from '../../helpers/testdb';

/**
 * Was vor dem ersten Browser geprüft wird — und warum es hart abbricht.
 *
 * Ein Browsertest sieht aus wie ein Mensch, der die Anwendung bedient. Genau
 * deshalb ist er die gefährlichste Prüfart, die dieses Projekt hat: Er kann
 * Offerten versenden, Rechnungsnummern verbrauchen und Einsätze abnehmen. Was
 * er dabei anfasst, entscheidet allein die Umgebung, in der er läuft.
 *
 * Diese Datei stellt deshalb vor dem Start fest, dass
 *
 *  1. überhaupt ein Server antwortet (sonst sucht man den Fehler in Selektoren,
 *     nicht im vergessenen `npm run build`),
 *  2. die Datenbank als **Testdatenbank** erkennbar ist — dieselbe
 *     Namensprüfung wie in `prisma/seed-guard.ts`, `scripts/setup-test-db.ts`
 *     und `scripts/test-server.ts`,
 *  3. der Postausgang des Testservers bereitsteht (ohne ihn gibt es keinen
 *     tatsächlich versendeten Link, und die Reihe würde einen selbst gelegten
 *     Ersatz fahren — genau das soll sie nicht),
 *  4. **keine** produktive Integration konfiguriert ist. Ohne Anbieter
 *     simuliert `src/lib/email/client.ts` den Versand in den Postausgang; mit
 *     Anbieter ginge eine echte E-Mail an `nicole.wyss@example.ch` hinaus.
 *     Dasselbe gilt für SMS, Stripe und Supabase.
 *
 * Keine Rückfallebene, kein Überspringen: Eine Browserprüfung, die gegen eine
 * unbekannte Umgebung läuft, ist keine Prüfung.
 */

/** Werte aus der Umgebung und aus `.env` — die Datei liest `next start` selbst. */
function konfigurierteWerte(namen: string[]): string[] {
  const gesetzt = new Set<string>();

  for (const name of namen) {
    if ((process.env[name]?.trim() ?? '') !== '') gesetzt.add(name);
  }

  const envDatei = join(process.cwd(), '.env');
  if (existsSync(envDatei)) {
    for (const zeile of readFileSync(envDatei, 'utf8').split(/\r?\n/)) {
      const treffer = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(zeile);
      if (!treffer) continue;
      const name = treffer[1]!;
      if (!namen.includes(name)) continue;
      const wert = treffer[2]!.replace(/^["']|["']$/g, '').trim();
      if (wert !== '') gesetzt.add(name);
    }
  }

  return [...gesetzt];
}

/**
 * Anbieter, deren blosse Konfiguration die Simulation abschaltet.
 *
 * Es steht bewusst nur der jeweils *auslösende* Schlüssel hier — der, an dem
 * `hasIntegration()` in `src/lib/env.ts` entscheidet. Ein gesetzter
 * `EMAIL_FROM` ist harmlos, ein gesetzter `RESEND_API_KEY` nicht.
 */
const PRODUKTIVE_ANBIETER = [
  'RESEND_API_KEY',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_ACCOUNT_SID',
  'STRIPE_SECRET_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'NEXT_PUBLIC_SUPABASE_URL',
  'ANTHROPIC_API_KEY',
];

/**
 * Auf den Server warten statt ihn einmal anzuklopfen.
 *
 * Playwright startet den `webServer` nebenläufig zu diesem Vorlauf; ein
 * Produktionsbau von Next braucht auf einer kalten Maschine gut und gern
 * zwanzig Sekunden bis zur ersten Antwort. Ein einzelner Versuch scheiterte
 * hier deshalb reproduzierbar — und ein festes `sleep` wäre genau das, was
 * § 3 ausschliesst. Gewartet wird auf die tatsächliche Antwort, mit Deckel.
 */
async function aufServerWarten(fristMs: number): Promise<string | null> {
  const bis = Date.now() + fristMs;
  let letzterGrund = 'noch kein Versuch';

  while (Date.now() < bis) {
    try {
      const antwort = await fetch(`${BASE_URL}/api/auth/session`, { signal: AbortSignal.timeout(5_000) });
      if (antwort.ok) return null;
      letzterGrund = `HTTP ${antwort.status}`;
    } catch (error) {
      letzterGrund = error instanceof Error ? error.message : String(error);
    }
    await new Promise((fertig) => setTimeout(fertig, 1_000));
  }

  return (
    `Kein Server unter ${BASE_URL} erreichbar (${letzterGrund}).\n` +
    '    Zuerst `npm run build` (bei gestopptem Server), dann `npm run test:server`.'
  );
}

export default async function globalSetup(): Promise<void> {
  const fehler: string[] = [];

  // 1 — Server
  const serverfehler = await aufServerWarten(150_000);
  if (serverfehler) fehler.push(serverfehler);

  // 2 — Testdatenbank
  const db = testDb();
  if (!db) {
    fehler.push(`Keine erkennbare Testdatenbank: ${testDbGrund()}`);
  } else {
    await db.$disconnect();
  }

  // 3 — Postausgang
  if (!existsSync(testCacheDir())) {
    fehler.push(
      `Kein Postausgang unter ${testCacheDir()}.\n` +
        '    Der Testserver muss mit CLENARIS_TEST_CACHE_DIR laufen — `npm run test:server` setzt das.',
    );
  }

  // 4 — produktive Integrationen
  const anbieter = konfigurierteWerte(PRODUKTIVE_ANBIETER);
  if (anbieter.length > 0) {
    fehler.push(
      `Produktive Integrationen sind konfiguriert: ${anbieter.join(', ')}.\n` +
        '    Diese Reihe versendet Offerten und nimmt Einsätze ab. Mit Anbieter ginge das\n' +
        '    an echte Empfänger. Die Schlüssel für den Lauf leeren oder entfernen.',
    );
  }

  // 5 — Zählerverzeichnis: schreibt der antwortende Server wirklich hierhin?
  if (fehler.length === 0) {
    const zaehlerfehler = await zaehlerverzeichnisPruefen();
    if (zaehlerfehler) fehler.push(zaehlerfehler);
  }

  if (fehler.length > 0) {
    throw new Error(`\n\nBrowser-Prüfreihe nicht startbar:\n\n  • ${fehler.join('\n\n  • ')}\n`);
  }
}

/** Die Dateinamen der Rate-Limit-Zähler (`rl:…`, base64url über den Schlüssel). */
function zaehlerdateien(): Set<string> {
  const namen = new Set<string>();
  for (const datei of readdirSync(testCacheDir())) {
    if (!datei.endsWith('.json')) continue;
    try {
      if (Buffer.from(datei.slice(0, -5), 'base64url').toString('utf8').startsWith('rl:')) namen.add(datei);
    } catch {
      /* Kein Zähler — Postausgang und andere Einträge liegen im selben Verzeichnis. */
    }
  }
  return namen;
}

/**
 * Nachweisen, dass der antwortende Server **dieses** Zählerverzeichnis
 * benutzt — und die Zähler danach leeren.
 *
 * **Warum das eine eigene Prüfung verdient.** `reuseExistingServer` ist
 * bewusst immer an: Läuft schon ein Testserver, wird er verwendet. Genau
 * daraus entsteht aber die Falle, die in Wave 1 einen halben Tag gekostet hat
 * — ein Server aus einem früheren Lauf, mit einem anderen
 * `CLENARIS_TEST_CACHE_DIR` oder mit erschöpften Kontingenten. Dann leert
 * `basis.ts` vor jedem Fall ein Verzeichnis, das niemand liest, der neunte
 * Fall bekommt einen 429, und der Befund sieht aus wie ein Produktfehler.
 * Damals wurde er als „Hydrationsfehler" gemeldet und war keiner.
 *
 * Die Prüfung ist bewusst ein **Nachweis** und keine Annahme: eine Anmeldung
 * mit einer Adresse, die es nicht gibt, muss im Zählerverzeichnis eine neue
 * Datei hinterlassen. Die Adresse ist erfunden (`.invalid` ist dafür
 * reserviert), also erhöht sie keinen Fehlversuchszähler an einem echten
 * Konto und kann keine Sperre auslösen.
 *
 * Am Ende werden alle Zähler geleert — der Lauf beginnt mit vollem
 * Kontingent, unabhängig davon, was vorher gegen diesen Server lief. Die
 * Limits selbst bleiben unverändert; ihre Semantik prüft
 * `tests/api/rate-limit.test.ts` gegen die echten Werte.
 */
async function zaehlerverzeichnisPruefen(): Promise<string | null> {
  const vorher = zaehlerdateien();

  try {
    await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'zaehlerprobe@nicht-vorhanden.invalid', password: 'x'.repeat(12) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return `Die Zählerprobe gegen ${BASE_URL} schlug fehl: ${error instanceof Error ? error.message : String(error)}`;
  }

  const nachher = zaehlerdateien();
  const neu = [...nachher].filter((datei) => !vorher.has(datei));

  if (neu.length === 0 && vorher.size === 0) {
    return (
      `Der Server unter ${BASE_URL} schreibt seine Rate-Limit-Zähler nicht nach ${testCacheDir()}.\n` +
      '    Wahrscheinlich läuft dort ein Server aus einem früheren Lauf oder ein von Hand\n' +
      '    gestarteter `next start` ohne CLENARIS_TEST_CACHE_DIR. Diesen Prozess beenden und\n' +
      '    `npm run test:server` verwenden — sonst leert die Reihe ein Verzeichnis, das\n' +
      '    niemand liest, und der neunte Fall bekommt einen 429.'
    );
  }

  resetRateLimits();
  return null;
}
