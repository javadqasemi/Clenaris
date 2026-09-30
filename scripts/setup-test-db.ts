/**
 * Isolierte Testdatenbank einrichten.
 *
 *   npm run db:test:setup
 *
 * ---------------------------------------------------------------------------
 *  Warum es dieses Skript gibt
 * ---------------------------------------------------------------------------
 *
 * Die Prüfungen dieses Projekts fahren die laufende Anwendung über echtes HTTP
 * an und brauchen deshalb einen Datenbestand — Kundschaft, Buchungen,
 * Rechnungen. Bisher hiess das in der Praxis: `db:seed:demo` gegen die
 * Entwicklungsdatenbank. Das hat zwei Haken, und beide sind teuer:
 *
 *  • **Rechnungsnummern.** Der Demo-Seed stellt Rechnungen aus. Deren Nummern
 *    kommen aus `NumberSequence` und müssen nach Art. 957a OR lückenlos sein.
 *    Eine Testrechnung verbraucht eine Nummer, die kein Storno zurückholt.
 *  • **Die Prüfungen verändern den Bestand.** Sie legen an, ändern, setzen
 *    Rollen herab. Wer daneben im Browser arbeitet, sieht Zustände, die er
 *    nicht erzeugt hat — und sucht Fehler, die keine sind.
 *
 * Deshalb die Trennung, die auch die CI schon kennt: Dort läuft alles gegen
 * eine Wegwerf-Datenbank namens `clenaris_test` in einem Dienstcontainer
 * (`.github/workflows/deploy.yml`). Dieses Skript stellt örtlich dasselbe her,
 * unter demselben Namen — damit die Prüfungen auf der Entwicklungsmaschine
 * und in der CI gegen die gleiche Ausgangslage laufen und nicht gegen zwei.
 *
 * ---------------------------------------------------------------------------
 *  Was es tut — und was ausdrücklich nicht
 * ---------------------------------------------------------------------------
 *
 *  1. Leitet die Adresse der Testdatenbank aus `DATABASE_URL` ab: derselbe
 *     Server, derselbe Benutzer, Name mit angehängtem `_test`. `TEST_DATABASE_URL`
 *     übersteuert das, falls die Testdatenbank woanders steht.
 *  2. Weigert sich, wenn der Zielname nicht als Testdatenbank erkennbar ist.
 *  3. Legt die Datenbank an, falls sie fehlt (`CREATE DATABASE`) — über eine
 *     Verbindung zur Wartungsdatenbank `postgres`. Eine bestehende wird
 *     **nicht** angefasst.
 *  4. Spielt die Migrationen ein (`prisma migrate deploy`).
 *  5. Seedet Konfiguration und Demodaten (mit `--ohne-demo` nur die
 *     Konfiguration, siehe unten) — mit den **Demo-Zugangsdaten**, nicht
 *     mit denen aus der `.env`. Sonst hinge die Reproduzierbarkeit der
 *     Prüfungen an der persönlichen Konfiguration der jeweiligen Maschine.
 *
 * Die Datenbank aus `DATABASE_URL` wird zu keinem Zeitpunkt geschrieben. Das
 * Skript liest sie nur, um Host, Benutzer und Namen abzuleiten.
 *
 * `--frisch` wirft eine bestehende Testdatenbank vorher weg. Auch das trifft
 * ausschliesslich einen Namen, der die Prüfung aus Schritt 2 bestanden hat.
 *
 * `--ohne-demo` (2026-09-30) lässt Schritt 5 beim Konfigurations-Seed
 * enden: Firma, Leistungen, Preise, Gebiet, Konten — keine erfundene
 * Kundschaft, keine Bewertungen, keine Blogartikel. Das braucht
 * `verify.ts voll --frisch`, also der Release-Kern: Er baut die Anwendung
 * **vor** dem Demo-Seed und packt daraus ein Probeartefakt, dessen
 * Demo-Stolperdraht (`scripts/release-artefakt.ts`) nur dann etwas
 * beweist, wenn beim Vorrendern der öffentlichen Seiten noch kein
 * Demobestand in der Datenbank lag. Mit Demodaten hier schlüge der
 * Stolperdraht immer an — oder, schlimmer, man gewöhnte sich daran, ihn zu
 * übergehen. Die Demodaten spielt `verify.ts` danach selbst ein
 * (`npm run db:seed:demo`, idempotent). Ohne den Schalter bleibt alles wie
 * bisher: Wer `npm run db:test:setup` von Hand ruft, will eine Datenbank,
 * gegen die die Prüfreihe sofort läuft.
 */

import { execFileSync } from 'node:child_process';


import { databaseNameOf, istTestdatenbank } from '../prisma/seed-guard';
import { erzeugePrismaClient } from '../src/lib/prisma-client';

/**
 * Die Demokonten aus `prisma/seed.ts`.
 *
 * Fest verdrahtet und nicht aus der Umgebung gelesen: Die Testdatenbank soll
 * auf jeder Maschine gleich aussehen. `tests/helpers/accounts.ts` kennt
 * dieselben Werte als Rückfall.
 */
const DEMO_ZUGAENGE = {
  SEED_ADMIN_EMAIL: 'admin@clenaris.ch',
  SEED_ADMIN_PASSWORD: 'Admin#2026Clenaris',
  SEED_SUPERADMIN_EMAIL: 'system@clenaris.ch',
  SEED_SUPERADMIN_PASSWORD: 'System#2026Clenaris',
} as const;

function testUrlAus(entwicklungsUrl: string): string {
  const url = new URL(entwicklungsUrl);
  const name = url.pathname.replace(/^\//, '');
  url.pathname = `/${name}_test`;
  return url.toString();
}

/** Verbindung zur Wartungsdatenbank desselben Servers. */
function wartungsUrl(testUrl: string): string {
  const url = new URL(testUrl);
  url.pathname = '/postgres';
  url.search = '';
  return url.toString();
}

async function datenbankAnlegen(testUrl: string, name: string, frisch: boolean): Promise<void> {
  // `DROP` und `CREATE DATABASE` vertragen keine Parameterbindung; der Name
  // ist deshalb interpoliert. Er stammt nicht aus einer Anfrage, sondern aus
  // `DATABASE_URL`, und hat die Musterprüfung oben bestanden. Anführungszeichen
  // werden **vor** beiden Anweisungen ausgeschlossen — bis 2026-09-26 stand
  // diese Prüfung erst vor `CREATE`, das `DROP` mit `--frisch` lief ungeprüft
  // (gefunden von `npm run security:check`, Regel `sql-unsafe`).
  if (/["\\]/.test(name)) throw new Error(`Unzulässiger Datenbankname: ${name}`);
  const client = erzeugePrismaClient({ url: wartungsUrl(testUrl) });
  try {
    if (frisch) {
      // `WITH (FORCE)` trennt offene Verbindungen; ohne das scheitert das
      // Verwerfen, sobald irgendwo noch ein Testserver hängt.
      console.log(`   … bestehende Testdatenbank „${name}" wird verworfen (--frisch)`);
      await client.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }

    const vorhanden = await client.$queryRawUnsafe<{ count: bigint }[]>(
      'SELECT count(*)::bigint AS count FROM pg_database WHERE datname = $1',
      name,
    );
    if (Number(vorhanden[0]?.count ?? 0) > 0) {
      console.log(`   … „${name}" gibt es bereits — wird weiterverwendet`);
      return;
    }

    await client.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    console.log(`   ✓ „${name}" angelegt`);
  } finally {
    await client.$disconnect();
  }
}

function lauf(befehl: string, argumente: string[], url: string): void {
  execFileSync(befehl, argumente, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      DATABASE_URL: url,
      // Prisma Migrate braucht eine Direktverbindung. Gegen eine örtliche
      // Datenbank ohne Pooler ist das dieselbe Adresse; stünde hier die
      // Direktverbindung der Entwicklungsdatenbank, liefen die Migrationen in
      // die falsche Datenbank.
      DIRECT_URL: url,
      ...DEMO_ZUGAENGE,
      // Der Schutzschalter in `prisma/seed-guard.ts` prüft denselben Namen
      // noch einmal. Übersteuert wird er hier bewusst nicht — wenn er
      // anschlägt, stimmt etwas an der abgeleiteten Adresse nicht.
    },
  });
}

async function main(): Promise<void> {
  const frisch = process.argv.includes('--frisch');
  const ohneDemo = process.argv.includes('--ohne-demo');

  const entwicklung = process.env.DATABASE_URL;
  if (!entwicklung) {
    console.error('❌  DATABASE_URL fehlt. Ohne sie lässt sich die Testadresse nicht ableiten.');
    process.exit(1);
  }

  const testUrl = process.env.TEST_DATABASE_URL ?? testUrlAus(entwicklung);
  const testName = databaseNameOf(testUrl);
  const entwicklungName = databaseNameOf(entwicklung);

  console.log('');
  console.log('  Entwicklungsdatenbank (wird nicht verändert) : ' + (entwicklungName ?? '?'));
  console.log('  Testdatenbank (Ziel)                         : ' + (testName ?? '?'));
  console.log('');

  if (!testName) {
    console.error('❌  Aus der Testadresse lässt sich kein Datenbankname lesen.');
    process.exit(1);
  }
  if (testName === entwicklungName) {
    console.error('❌  Test- und Entwicklungsdatenbank sind dieselbe. Abbruch.');
    process.exit(1);
  }
  if (!istTestdatenbank(testName)) {
    console.error(
      `❌  „${testName}" ist nicht als Testdatenbank erkennbar.\n` +
        '    Erwartet wird ein Name mit „test", „demo", „scratch" oder „sandbox".\n' +
        '    Mit TEST_DATABASE_URL lässt sich eine andere Adresse angeben.',
    );
    process.exit(1);
  }

  await datenbankAnlegen(testUrl, testName, frisch);

  console.log('\n▸ Migrationen\n');
  lauf('npx', ['prisma', 'migrate', 'deploy'], testUrl);

  if (ohneDemo) {
    console.log('\n▸ Konfiguration (ohne Demodaten, --ohne-demo)\n');
    lauf('npx', ['tsx', 'prisma/seed.ts'], testUrl);
    console.log('');
    console.log('  ✅  Testdatenbank bereit — nur Konfiguration.');
    console.log('');
    // Der Hinweis nennt bewusst **nicht** `npm run db:seed:demo`: Das liest
    // `DATABASE_URL` aus der `.env`, also die Entwicklungsdatenbank. Der
    // Schutz in `prisma/seed-guard.ts` bricht dort ab — oder, folgt man
    // dessen eigenem Hinweis auf `ALLOW_DEMO_SEED`, landen die Demodaten in
    // der Entwicklungsdatenbank statt hier. Dieses Skript ohne `--ohne-demo`
    // leitet dieselbe Testadresse ab, verwendet die bestehende Datenbank
    // weiter und seedet idempotent nach — derselbe Weg, dieselbe Adresse.
    console.log('  Vor der Prüfreihe fehlen noch die Demodaten. `verify.ts voll --frisch` spielt');
    console.log('  sie selbst ein; von Hand ergänzt sie dieselbe Testdatenbank:');
    console.log('');
    console.log('      npm run db:test:setup    # ohne --ohne-demo; die Datenbank wird weiterverwendet');
    if (process.env.TEST_DATABASE_URL) console.log('                               # mit derselben TEST_DATABASE_URL wie eben');
    console.log('');
    return;
  }

  console.log('\n▸ Konfiguration und Demodaten\n');
  lauf('npx', ['tsx', 'prisma/seed.ts'], testUrl);
  lauf('npx', ['tsx', 'prisma/seed-demo.ts'], testUrl);

  console.log('');
  console.log('  ✅  Testdatenbank bereit.');
  console.log('');
  console.log('  Server dagegen starten (zweite Instanz, Port 3001):');
  console.log('');
  console.log('      npm run build          # bei gestopptem Entwicklungsserver');
  console.log('      npm run test:server    # setzt Testdatenbank, Proxy-Modus und Zähler-Verzeichnis');
  console.log('');
  console.log('  Prüfungen dagegen fahren:');
  console.log('');
  console.log("      $env:TEST_BASE_URL = 'http://127.0.0.1:3001'");
  console.log('      npm test');
  console.log('');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
