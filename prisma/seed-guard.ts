/**
 * Schutzschalter für den Demo-Seed.
 *
 * ---------------------------------------------------------------------------
 *  Wogegen das schützt
 * ---------------------------------------------------------------------------
 *
 * `db:seed:demo` legt erfundene Kundschaft, Buchungen, Offerten und
 * **Rechnungen** an. Rechnungen ziehen Nummern aus `NumberSequence`, und diese
 * Folge ist nach Art. 957a OR lückenlos zu führen: Eine im Spass vergebene
 * `RE-2026-00042` lässt sich nicht zurückgeben. Wer den Demo-Seed versehentlich
 * gegen die falsche Datenbank laufen lässt, hat also nicht bloss Datenmüll,
 * sondern eine Lücke in der Belegnummernfolge — und die fällt erst bei der
 * nächsten Prüfung auf.
 *
 * Dazu kommen erfundene Bewertungen. Auf einer öffentlichen Website sind die
 * nicht bloss unsauber, sondern wettbewerbsrechtlich heikel; der Kopf von
 * `seed-demo.ts` sagt das schon.
 *
 * ---------------------------------------------------------------------------
 *  Wie entschieden wird
 * ---------------------------------------------------------------------------
 *
 * Erlaubt ist der Lauf, wenn **eines** zutrifft:
 *
 *   1. Der Datenbankname weist sie als Testdatenbank aus — er endet auf
 *      `_test`, enthält `test`, `demo` oder `scratch`. Das deckt die CI ab
 *      (`clenaris_test`) und die örtliche Testdatenbank, die
 *      `scripts/setup-test-db.ts` anlegt.
 *   2. `ALLOW_DEMO_SEED=ja` steht in der Umgebung. Der bewusste Übersteuerungs-
 *      weg für den Fall, dass jemand seine Entwicklungsdatenbank schlicht
 *      `clenaris` genannt hat und weiss, was er tut.
 *
 * Alles andere bricht ab — laut, mit dem Namen der Datenbank und beiden Wegen
 * nach vorn. Ein Schutzschalter, der bloss warnt, wird überlesen.
 *
 * Der **Konfigurations**-Seed (`seed.ts`) hat diesen Schalter bewusst nicht:
 * Er legt Firma, Leistungen, Preise und Konten an und gehört genau so auf ein
 * System, das in Betrieb geht. Er hat seine eigene Schranke — in der Produktion
 * verlangt er gesetzte Startpasswörter.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TESTMUSTER = /(^|[_-])test($|[_-])|_test$|test_|demo|scratch|sandbox/i;

/**
 * `DATABASE_URL` notfalls selbst aus `.env` lesen.
 *
 * Die Seeds bekommen sie sonst über den Prisma-Client, der `.env` beim Laden
 * mitnimmt. Dieser Schalter läuft aber *vor* jeder Datenbankverbindung und
 * darf den Client gerade nicht importieren — sonst stünde die Verbindung,
 * bevor entschieden ist, ob sie stehen darf.
 *
 * Ohne diesen Umweg sähe der Schalter örtlich gar keine Adresse, hielte jede
 * Datenbank für unbekannt und bliese jeden Lauf ab. Das sähe aus wie
 * Vorsicht, wäre aber Blindheit: Ein Schalter, der immer auslöst, wird
 * abgeschaltet statt beachtet. In der CI steht die Adresse ohnehin in der
 * Umgebung; dann wird hier nichts gelesen.
 */
function datenbankUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const datei = resolve(process.cwd(), '.env');
  if (!existsSync(datei)) return undefined;

  for (const zeile of readFileSync(datei, 'utf8').split(/\r?\n/)) {
    const treffer = /^\s*DATABASE_URL\s*=\s*(.*)$/.exec(zeile);
    if (!treffer) continue;
    // Anführungszeichen und ein angehängter Kommentar gehören nicht zum Wert.
    return treffer[1]!.trim().replace(/^["']|["']$/g, '');
  }
  return undefined;
}

/** Datenbankname aus einer Postgres-Verbindungszeichenfolge. */
export function databaseNameOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    // `new URL` verträgt `postgresql://` und liefert den Pfad mit führendem
    // Schrägstrich; alles nach `?` gehört zu den Parametern, nicht zum Namen.
    const pfad = new URL(url).pathname.replace(/^\//, '');
    return pfad.length > 0 ? pfad : null;
  } catch {
    // Zeichenketten, die `URL` nicht versteht (etwa ein Passwort mit rohem
    // `@`), werden von hinten gelesen. Lieber ein Treffer über einen
    // Notbehelf als ein Schutzschalter, der bei ungewöhnlichen Passwörtern
    // stillschweigend durchlässt.
    const treffer = /\/([^/?#]+)(\?|$)/.exec(url.replace(/^[a-z+]+:\/\//i, ''));
    return treffer?.[1] ?? null;
  }
}

export function istTestdatenbank(name: string | null): boolean {
  return name !== null && TESTMUSTER.test(name);
}

/**
 * Bricht ab, wenn die Zieldatenbank nicht eindeutig eine Testdatenbank ist.
 * Wird als Erstes in `seed-demo.ts` aufgerufen.
 */
export function assertDemoSeedErlaubt(): void {
  return pruefen();
}

function pruefen(): void {
  if (process.env.ALLOW_DEMO_SEED === 'ja') {
    console.log('⚠️   ALLOW_DEMO_SEED=ja — Schutzschalter übersprungen.\n');
    return;
  }

  const name = databaseNameOf(datenbankUrl());
  if (istTestdatenbank(name)) return;

  console.error(
    [
      '',
      '❌  Demo-Seed abgebrochen — Schutzschalter.',
      '',
      `    Zieldatenbank : ${name ?? '(aus DATABASE_URL nicht lesbar)'}`,
      '',
      '    Dieser Seed legt erfundene Kundschaft, Bewertungen und Rechnungen an.',
      '    Rechnungen verbrauchen Nummern aus einer Folge, die nach Art. 957a OR',
      '    lückenlos sein muss — eine versehentlich vergebene Nummer lässt sich',
      '    nicht zurückgeben.',
      '',
      '    Zwei Wege nach vorn:',
      '',
      '      • Testdatenbank verwenden (empfohlen):',
      '          npm run db:test:setup',
      '        Legt „<name>_test" an, migriert und seedet nur dort.',
      '',
      '      • Bewusst übersteuern, wenn diese Datenbank wirklich zum Wegwerfen ist:',
      '          $env:ALLOW_DEMO_SEED = "ja"; npm run db:seed:demo',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

/**
 * Direkt aufrufbar — `tsx prisma/seed-guard.ts` prüft und beendet sich.
 *
 * `db:seed:demo` verkettet drei Läufe: erst dieser Schalter, dann der
 * Konfigurations-Seed, dann die Demodaten. Der Schalter muss **vor** dem
 * Konfigurations-Seed greifen, denn auch der schreibt schon — Firma, Konten,
 * Leistungen. Ein Schutz, der erst beim dritten Schritt auslöst, hätte die
 * fremde Datenbank bereits angefasst.
 *
 * Beim Import aus `seed-demo.ts` oder `setup-test-db.ts` läuft dieser Block
 * nicht: dort ist `argv[1]` eine andere Datei.
 */
if (process.argv[1] && /seed-guard\.(ts|js)$/.test(process.argv[1])) {
  pruefen();
  console.log(`✓  Zieldatenbank „${databaseNameOf(datenbankUrl()) ?? '?'}" ist zum Seeden freigegeben.`);
}

