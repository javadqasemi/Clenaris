/**
 * Datenbanktor: Gelten die handgeschriebenen Schranken in **dieser**
 * Datenbank? (Produktion V2, Entwurf D8, 2026-09-30)
 *
 *   DATABASE_URL=… npx tsx scripts/datenbank-schranken.ts
 *
 *   Exit 0   BESTANDEN      jede gelistete Schranke vorhanden und wirksam
 *   Exit 1   BEFUND         mindestens eine fehlt, ist abgeschaltet, ungültig,
 *                           nicht validiert oder umgebaut (Trigger anders
 *                           gebunden, Funktionsrumpf geändert) — oder das
 *                           Register passt nicht zu den Migrationen
 *   Exit 2   NICHT GEPRÜFT  keine DATABASE_URL, keine Verbindung, kein
 *                           Register — **kein** Bestehen
 *
 * Jeder Ausgang ausser 0 muss ein Tor anhalten. Aufrufer: `scripts/verify.ts`
 * (nach `prisma migrate deploy` auf der Testdatenbank) und der CI-Auftrag in
 * `.github/workflows/deploy.yml` (unmittelbar nach dem Anwenden des Schemas).
 *
 * ---------------------------------------------------------------------------
 *  Warum ein eigenes Tor neben `security:check --datenbank`
 * ---------------------------------------------------------------------------
 *
 * `security:check` ist der Dirigent aller Sicherheitsprüfungen und läuft
 * statisch, ohne Datenbank. Die Frage „gilt die Regel in der Datenbank, gegen
 * die gleich geprüft oder ausgeliefert wird?" gehört an genau die Stelle, an
 * der diese Datenbank gerade migriert wurde — und sie braucht einen Ausgang,
 * der „nicht geprüft" von „bestanden" unterscheidet. Die Regeln selbst stehen
 * einmal, in `scripts/security/datenbank-schranken.ts`; beide Wege benutzen
 * sie.
 *
 * ---------------------------------------------------------------------------
 *  Welche Datenbank — und warum ausdrücklich nicht `.env`
 * ---------------------------------------------------------------------------
 *
 * Geprüft wird die Datenbank aus `DATABASE_URL` **in der Umgebung dieses
 * Aufrufs**, sonst keine. Die anderen Skripte laden `.env` (über
 * `src/lib/prisma-client.ts`, das `dotenv/config` einbindet); täte dieses es
 * auch, prüfte ein Aufruf ohne Variable still die Entwicklungsdatenbank — und
 * meldete BESTANDEN für eine Datenbank, nach der niemand gefragt hat. Der
 * Prüfweg setzt die Testdatenbank ausdrücklich (`dbEnv` in `verify.ts`), die
 * CI setzt sie im Auftrag; wer von Hand prüft, nennt sie ebenso. Deshalb wird
 * die Adresse gelesen, **bevor** der Prisma-Client geladen wird, und ihm
 * danach ausdrücklich übergeben.
 *
 * Ausgegeben werden Datenbankname und Schema, nie die Adresse: Sie trägt das
 * Passwort.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  livePruefen,
  migrationenLesen,
  REGISTER_DATEI,
  registerLesen,
  registerZusammenfassung,
  schemaAusAdresse,
  statischPruefen,
  type Schrankenbefund,
  type Schrankenregister,
} from './security/datenbank-schranken';

// Vor jedem Import, der `.env` laden könnte — siehe Kopf.
const ADRESSE = process.env.DATABASE_URL?.trim() || undefined;

/** Wie lange die erste Verbindung dauern darf, bevor das Tor „nicht geprüft" meldet. */
const VERBINDUNG_MS = 15_000;

type Ergebnis = 'BESTANDEN' | 'BEFUND' | 'NICHT_GEPRUEFT';
const EXIT: Record<Ergebnis, number> = { BESTANDEN: 0, BEFUND: 1, NICHT_GEPRUEFT: 2 };

/** Eine Verbindungsadresse in einer Fehlermeldung unkenntlich machen. */
function ohneZugangsdaten(text: string): string {
  return text.replace(/(\w+:\/\/)[^@\s/]+@/g, '$1***@');
}

function ende(ergebnis: Ergebnis, grund: string): never {
  const zeichen = ergebnis === 'BESTANDEN' ? '✓' : ergebnis === 'BEFUND' ? '✗' : '○';
  const text = ergebnis === 'NICHT_GEPRUEFT' ? 'NICHT GEPRÜFT' : ergebnis;
  console.log(`\n  ${zeichen} Datenbankschranken: ${text} — ${grund}`);
  if (ergebnis === 'NICHT_GEPRUEFT') console.log('    Nicht geprüft ist nicht bestanden.');
  process.exit(EXIT[ergebnis]);
}

function befundeAusgeben(titel: string, befunde: Schrankenbefund[]): void {
  const blockierend = befunde.filter((b) => b.schwere === 'blockierend');
  const warnungen = befunde.filter((b) => b.schwere === 'warnung');
  console.log(`  ${titel}: ${blockierend.length} blockierend · ${warnungen.length} Warnung`);
  for (const b of blockierend) console.log(`    ✗ ${b.titel}`);
  for (const b of warnungen) console.log(`    ! ${b.titel}`);
}

async function main(): Promise<void> {
  console.log('\n  Datenbankschranken — Register, Migrationen und Datenbank\n');

  let register: Schrankenregister;
  try {
    register = registerLesen();
  } catch (fehler) {
    ende('NICHT_GEPRUEFT', `Register ${REGISTER_DATEI} nicht lesbar: ${fehler instanceof Error ? fehler.message : String(fehler)}`);
  }
  console.log(`  Register: ${registerZusammenfassung(register)}`);

  // Statisch, soweit die Migrationen vorliegen. Ohne sie (etwa in einem
  // Verzeichnis, das nur das Programm trägt) prüft dieses Tor allein die
  // Datenbank; die statische Hälfte hält `security:check` im Repository.
  const befunde: Schrankenbefund[] = [];
  const migrationen = join(process.cwd(), 'prisma', 'migrations');
  if (existsSync(migrationen)) {
    const statisch = statischPruefen(migrationenLesen(migrationen), register);
    befundeAusgeben('Register gegen Migrationen', statisch);
    befunde.push(...statisch);
  } else {
    console.log('  Register gegen Migrationen: übersprungen (kein Verzeichnis prisma/migrations)');
  }

  if (!ADRESSE) ende('NICHT_GEPRUEFT', 'DATABASE_URL ist in dieser Umgebung nicht gesetzt (`.env` wird bewusst nicht gelesen).');

  const { erzeugePrismaClient } = await import('../src/lib/prisma-client');
  const db = erzeugePrismaClient({ url: ADRESSE });
  const schema = schemaAusAdresse(ADRESSE);
  try {
    // `pg` wartet ohne eigene Frist beliebig lange auf eine Verbindung — ein
    // Host, der Pakete verschluckt, hielte das Tor sonst bis zum Abbruch des
    // ganzen Auftrags an, statt „nicht geprüft" zu sagen.
    let name: string;
    let frist: ReturnType<typeof setTimeout> | undefined;
    try {
      const zeit = new Promise<never>((_, ablehnen) => {
        frist = setTimeout(() => ablehnen(new Error(`keine Antwort innerhalb von ${VERBINDUNG_MS / 1000} s`)), VERBINDUNG_MS);
      });
      const [zeile] = await Promise.race([db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`, zeit]);
      clearTimeout(frist);
      name = zeile!.name;
    } catch (fehler) {
      ende('NICHT_GEPRUEFT', `keine Verbindung zur Datenbank: ${ohneZugangsdaten(fehler instanceof Error ? fehler.message.split('\n').pop()! : String(fehler))}`);
    }
    console.log(`  Datenbank: ${name} (Schema ${schema})`);

    let live: Schrankenbefund[];
    try {
      live = await livePruefen(db, register, schema);
    } catch (fehler) {
      // Ein Katalog, der sich nicht lesen lässt (fehlende Rechte, abgerissene
      // Verbindung), ist keine bestandene Prüfung.
      ende('NICHT_GEPRUEFT', `Kataloge nicht lesbar: ${ohneZugangsdaten(fehler instanceof Error ? fehler.message.split('\n').pop()! : String(fehler))}`);
    }
    befundeAusgeben('Datenbank gegen Register', live);
    befunde.push(...live);
  } finally {
    await db.$disconnect().catch(() => undefined);
  }

  const blockierend = befunde.filter((b) => b.schwere === 'blockierend').length;
  if (blockierend > 0) ende('BEFUND', `${blockierend} blockierende(r) Befund(e).`);
  ende('BESTANDEN', 'jede gelistete Schranke ist vorhanden und wirksam.');
}

main().catch((fehler: unknown) => {
  // Ein unerwarteter Abbruch des Werkzeugs selbst: nicht geprüft, nie bestanden.
  console.error(`  Datenbankschranken abgebrochen: ${ohneZugangsdaten(fehler instanceof Error ? fehler.message : String(fehler))}`);
  process.exit(EXIT.NICHT_GEPRUEFT);
});
