/**
 * Schlüsselrotation für die Feldverschlüsselung.
 *
 *   npx tsx scripts/rotate-encryption-key.ts --status    nur zählen, nichts ändern
 *   npx tsx scripts/rotate-encryption-key.ts             alles umschlüsseln
 *   npx tsx scripts/rotate-encryption-key.ts --feld ahv  nur ein Feld
 *
 * ---------------------------------------------------------------------------
 *  Wofür das da ist
 * ---------------------------------------------------------------------------
 *
 * Bis Wave 4 gab es keine Rotation. Das stand so im Kopf von `crypto.ts` und
 * war ehrlich, aber es hiess auch: Ein Schlüssel, der einmal abgeflossen ist,
 * bleibt für immer der Schlüssel — es sei denn, man nimmt in Kauf, dass alle
 * zweiten Faktoren, AHV-Nummern und Alarmcodes unlesbar werden.
 *
 * Der Weg jetzt, in dieser Reihenfolge:
 *
 *   1. Neuen Schlüssel erzeugen:      openssl rand -hex 32
 *   2. Alten nach ENCRYPTION_KEY_PREVIOUS, neuen nach ENCRYPTION_KEY
 *   3. Anwendung neu starten — sie liest jetzt beide, schreibt nur den neuen
 *   4. `--status` — zeigt, wie viele Werte noch am alten hängen
 *   5. Dieses Skript ohne Schalter — schlüsselt den Bestand um
 *   6. `--status` bis alles auf dem aktiven Schlüssel steht
 *   7. ENCRYPTION_KEY_PREVIOUS entfernen, Anwendung neu starten
 *
 * **Schritt 3 vor Schritt 5 ist nicht vertauschbar.** Umschlüsseln, bevor die
 * Anwendung den neuen Schlüssel kennt, hiesse: Der Bestand ist schon neu, die
 * laufende Anwendung noch alt — und keine Anmeldung mit zweitem Faktor
 * funktioniert mehr. Es gibt keine Reihenfolge, die ohne den doppelten
 * Lesepfad auskommt.
 *
 * ---------------------------------------------------------------------------
 *  Eigenschaften
 * ---------------------------------------------------------------------------
 *
 *  • **Wiederholbar.** Jeder Wert wird einzeln gelesen, entschlüsselt und neu
 *    verschlüsselt. Ein abgebrochener Lauf lässt sich neu starten; was schon
 *    auf dem aktiven Schlüssel steht, wird übersprungen.
 *  • **Ein Wert je Schreibvorgang.** Kein Sammel-Update. Ein fehlerhafter Wert
 *    bringt den Lauf nicht zum Stehen und reisst die anderen nicht mit.
 *  • **Kein Klartext auf der Konsole.** Ausgegeben werden Kennungen und
 *    Zahlen, nie ein entschlüsselter Wert und nie Schlüsselmaterial. Das ist
 *    keine Formsache: Wer ein Rotationsprotokoll aufhebt, hätte sonst eine
 *    Liste aller AHV-Nummern.
 *  • **Klartext-Altbestand wandert mit.** Werte ohne Präfix stammen aus der
 *    Zeit vor der Verschlüsselung. Sie werden verschlüsselt — das ist genau
 *    die Umstellung, die `crypto.ts` bis hierher dem Zufall überliess („beim
 *    nächsten Schreiben").
 *
 * ---------------------------------------------------------------------------
 *  Was dieser Lauf NICHT tut
 * ---------------------------------------------------------------------------
 *
 * Er rührt die **abgeleiteten** Geheimnisse nicht an (Bestätigungscodes,
 * Signatursitzungen). Die hängen am Schlüssel, aber sie stehen nicht als
 * Chiffrat in der Datenbank — sie sind kurzlebig und werden während der
 * Rotation unter beiden Schlüsseln geprüft (`deriveSecretAll`). Nach dem
 * Entfernen von `ENCRYPTION_KEY_PREVIOUS` laufen die letzten offenen
 * Bestätigungscodes ins Leere; bei zehn Minuten Gültigkeit ist das der
 * richtige Preis.
 */
import Module from 'node:module';
import { join } from 'node:path';
import { config } from 'dotenv';

config();

/**
 * `server-only` gibt es nur innerhalb von Next. Die Auflösung wird vor dem
 * ersten Import umgebogen — dasselbe Muster wie in `scripts/backfill-kpi.ts`.
 */
const moduleWithResolver = Module as unknown as {
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};
const originalResolve = moduleWithResolver._resolveFilename;
moduleWithResolver._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'server-only') return join(__dirname, 'server-only-stub.cjs');
  return originalResolve.call(this, request, ...rest);
};

/* eslint-disable no-console */

async function main() {
  const { PrismaClient } = await import('@prisma/client');
  const {
    CRYPTO_CONTEXT,
    decrypt,
    encrypt,
    isEncrypted,
    istAktuellVerschluesselt,
    kidOfValue,
    schluesselUebersicht,
  } = await import('../src/lib/crypto');

  const prisma = new PrismaClient();
  const argv = process.argv.slice(2);
  const nurStatus = argv.includes('--status');

  /**
   * `indexOf` liefert −1, wenn `--feld` fehlt — und `argv[-1 + 1]` ist
   * `argv[0]`, also der erste Schalter. Ein Lauf mit `--status` hätte damit
   * den Feldnamen `--status` gehabt und **jedes** Feld übersprungen: keine
   * Fehlermeldung, keine Zeile, am Ende „alles in Ordnung". Genau so sieht
   * ein Rotationsskript aus, das nichts tut und behauptet, fertig zu sein.
   */
  const feldIndex = argv.indexOf('--feld');
  const nurFeld = feldIndex >= 0 ? argv[feldIndex + 1] : undefined;
  if (feldIndex >= 0 && !nurFeld) {
    console.error('--feld braucht einen Namen: zweitfaktor, ahv oder alarmcode.');
    process.exit(1);
  }

  /**
   * Die drei verschlüsselten Felder, jedes mit seiner Abfrage.
   *
   * Ausgeschrieben statt über eine Schleife über `CRYPTO_CONTEXT`: Die
   * Tabellen heissen verschieden, die Spalten heissen verschieden, und Prisma
   * hat keinen Typ für „irgendein Modell". Eine generische Fassung wäre eine
   * Ansammlung von `any` — und `any` in einem Skript, das Geheimnisse
   * umschreibt, ist die falsche Sparsamkeit.
   */
  const felder = [
    {
      name: 'zweitfaktor',
      beschreibung: 'User.twoFactorSecret',
      kontext: CRYPTO_CONTEXT.twoFactorSecret,
      lies: () =>
        prisma.user.findMany({
          where: { twoFactorSecret: { not: null } },
          select: { id: true, twoFactorSecret: true },
        }),
      wert: (r: { twoFactorSecret: string | null }) => r.twoFactorSecret,
      schreib: (id: string, wert: string) =>
        prisma.user.update({ where: { id }, data: { twoFactorSecret: wert } }),
    },
    {
      name: 'ahv',
      beschreibung: 'Employee.ahvNumber',
      kontext: CRYPTO_CONTEXT.ahvNumber,
      lies: () =>
        prisma.employee.findMany({
          where: { ahvNumber: { not: null } },
          select: { id: true, ahvNumber: true },
        }),
      wert: (r: { ahvNumber: string | null }) => r.ahvNumber,
      schreib: (id: string, wert: string) =>
        prisma.employee.update({ where: { id }, data: { ahvNumber: wert } }),
    },
    {
      name: 'iban',
      beschreibung: 'Employee.iban',
      kontext: CRYPTO_CONTEXT.iban,
      lies: () =>
        prisma.employee.findMany({
          where: { iban: { not: null } },
          select: { id: true, iban: true },
        }),
      wert: (r: { iban: string | null }) => r.iban,
      schreib: (id: string, wert: string) =>
        prisma.employee.update({ where: { id }, data: { iban: wert } }),
    },
    {
      name: 'alarmcode',
      beschreibung: 'Property.alarmCode',
      kontext: CRYPTO_CONTEXT.alarmCode,
      lies: () =>
        prisma.property.findMany({
          where: { alarmCode: { not: null } },
          select: { id: true, alarmCode: true },
        }),
      wert: (r: { alarmCode: string | null }) => r.alarmCode,
      schreib: (id: string, wert: string) =>
        prisma.property.update({ where: { id }, data: { alarmCode: wert } }),
    },
  ] as const;

  const uebersicht = schluesselUebersicht();
  console.log('\nSchlüsselbund');
  for (const k of uebersicht.alle) {
    const marke = k.kid === uebersicht.aktiv ? '  ← aktiv, hiermit wird geschrieben' : '  (nur lesen)';
    console.log(`  ${k.kid}   ${k.herkunft}${marke}`);
  }

  if (uebersicht.alle.length === 1 && !nurStatus) {
    console.log(
      '\nNur ein Schlüssel im Bund. Das ist kein Fehler — ein Lauf hebt dann den\n' +
        'Klartext-Altbestand und die v1-Werte auf die aktuelle Fassung. Für eine\n' +
        'echte Rotation gehört der alte Schlüssel vorher nach ENCRYPTION_KEY_PREVIOUS.',
    );
  }

  let gesamtOffen = 0;
  let gesamtUmgestellt = 0;
  let gesamtFehler = 0;

  for (const feld of felder) {
    if (nurFeld && nurFeld !== feld.name) continue;

    const zeilen = await feld.lies();

    let aktuell = 0;
    let klartext = 0;
    const andereKids = new Map<string, number>();

    for (const zeile of zeilen) {
      const wert = feld.wert(zeile as never);
      if (!wert) continue;

      if (!isEncrypted(wert)) {
        klartext += 1;
      } else if (istAktuellVerschluesselt(wert)) {
        aktuell += 1;
      } else {
        // `null` heisst v1 — die Fassung ohne Schlüsselkennung.
        const kid = kidOfValue(wert) ?? 'v1 (ohne Kennung)';
        andereKids.set(kid, (andereKids.get(kid) ?? 0) + 1);
      }
    }

    const offen = klartext + [...andereKids.values()].reduce((a, b) => a + b, 0);
    gesamtOffen += offen;

    console.log(`\n${feld.beschreibung}  (${zeilen.length} Zeilen mit Wert)`);
    console.log(`  auf dem aktiven Schlüssel: ${aktuell}`);
    if (klartext > 0) console.log(`  Klartext-Altbestand:       ${klartext}`);
    for (const [kid, anzahl] of andereKids) {
      console.log(`  Schlüssel ${kid}:${' '.repeat(Math.max(1, 16 - kid.length))}${anzahl}`);
    }

    if (nurStatus || offen === 0) continue;

    for (const zeile of zeilen) {
      const wert = feld.wert(zeile as never);
      if (!wert || istAktuellVerschluesselt(wert)) continue;

      try {
        /**
         * Entschlüsseln und sofort neu verschlüsseln. Der Klartext lebt für die
         * Dauer dieser zwei Zeilen in einer lokalen Variablen und wird nirgends
         * protokolliert — auch nicht im Fehlerfall.
         */
        const klar = decrypt(wert, feld.kontext);
        await feld.schreib(zeile.id, encrypt(klar, feld.kontext));
        gesamtUmgestellt += 1;
      } catch (fehler) {
        gesamtFehler += 1;
        /**
         * Die Meldung nennt Feld und Zeilenkennung, nicht den Wert. Ein
         * einzelner unlesbarer Wert ist kein Grund, den Lauf abzubrechen — die
         * übrigen sollen durchgehen, und der Fall gehört einzeln angesehen.
         */
        console.error(
          `  ✗ ${feld.beschreibung} ${zeile.id}: ` +
            (fehler instanceof Error ? fehler.message : String(fehler)),
        );
      }
    }

    console.log(`  → ${offen - gesamtFehler > 0 ? 'umgestellt' : 'nichts umgestellt'}`);
  }

  console.log('');
  if (nurStatus) {
    console.log(
      gesamtOffen === 0
        ? '✓ Alle Werte stehen auf dem aktiven Schlüssel. ENCRYPTION_KEY_PREVIOUS kann weg.'
        : `${gesamtOffen} Wert(e) stehen noch nicht auf dem aktiven Schlüssel.`,
    );
  } else {
    console.log(`✓ ${gesamtUmgestellt} Wert(e) umgeschlüsselt.`);
    if (gesamtFehler > 0) {
      console.log(
        `✗ ${gesamtFehler} Wert(e) liessen sich nicht öffnen. Fehlt ein Schlüssel in\n` +
          '  ENCRYPTION_KEY_PREVIOUS? Diese Zeilen bleiben unverändert stehen.',
      );
    }
    console.log('  Zur Kontrolle: npx tsx scripts/rotate-encryption-key.ts --status');
  }

  await prisma.$disconnect();
  process.exitCode = gesamtFehler > 0 ? 1 : 0;
}

main().catch((fehler) => {
  console.error(fehler);
  process.exit(1);
});
