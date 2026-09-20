import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BASE_URL } from '../../helpers/client';
import { testCacheDir } from '../../helpers/rate-limit';
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

  if (fehler.length > 0) {
    throw new Error(`\n\nBrowser-Prüfreihe nicht startbar:\n\n  • ${fehler.join('\n\n  • ')}\n`);
  }
}
