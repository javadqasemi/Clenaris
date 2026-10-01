import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import type { Prisma } from '@prisma/client';

import {
  livePruefen,
  migrationenLesen,
  registerLesen,
  schemaAusAdresse,
  schrankenAusMigrationen,
  SCHRANKENARTEN,
  statischPruefen,
  type Schrankenbefund,
  type Schrankenregister,
} from '../../scripts/security/datenbank-schranken';
import { testDb, testDbAdresse, testDbGrund, testDbSchliessen } from '../helpers/testdb';

/**
 * Datenbankschranken: Register, Migrationen und Datenbank (Produktion V2,
 * Entwurf D8, 2026-09-30).
 *
 * `security/datenbank-schranken.json` nennt jede handgeschriebene Schranke —
 * Teilindizes, Trigger, Prüf- und Ausschlussbedingungen, Erweiterungen.
 * `scripts/security/datenbank-schranken.ts` hält die Liste gegen den Endstand
 * der Migrationen (statisch) und gegen die Kataloge einer laufenden
 * Datenbank (live); `scripts/datenbank-schranken.ts` ist das Tor dazu.
 *
 * Gegen den alten Stand scheitert diese Datei an drei Stellen: Die 22 Prüf-
 * und 3 Ausschlussbedingungen standen in keiner Liste; ein abgeschalteter
 * Trigger galt als „vorhanden" (die alte Prüfung fragte nur `tgname`); und
 * ein Name, der nur in einem Kommentar einer Migration stand, bestand die
 * statische Prüfung.
 *
 * Kein HTTP-Server nötig. Was an der Datenbank verändert wird (Trigger
 * abschalten, Index löschen, Bedingung ohne Validierung), geschieht in einer
 * Transaktion, die immer zurückgerollt wird — DDL ist in Postgres
 * transaktional, und eine Prüfung, die einen Schutztrigger abschaltet, darf
 * ihn unter keinen Umständen abgeschaltet zurücklassen.
 */

type Tx = Prisma.TransactionClient;

const WURZEL = process.cwd();
const db = testDb();
const register = registerLesen();
const migrationen = migrationenLesen();

class Zurueckrollen extends Error {}

async function zurueckgerollt<T>(arbeit: (tx: Tx) => Promise<T>): Promise<T> {
  let ergebnis: { wert: T } | undefined;
  try {
    await db!.$transaction(
      async (tx) => {
        // `ALTER TABLE` und `DROP INDEX` verlangen eine exklusive Sperre; hielte
        // ein anderer Prozess die Tabelle, soll die Prüfung klar scheitern statt warten.
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`);
        ergebnis = { wert: await arbeit(tx) };
        throw new Zurueckrollen();
      },
      { timeout: 30_000 },
    );
  } catch (fehler) {
    if (!(fehler instanceof Zurueckrollen)) throw fehler;
  }
  assert.ok(ergebnis, 'die Arbeit in der Transaktion lief nicht zu Ende');
  return ergebnis.wert;
}

const blockierende = (befunde: Schrankenbefund[]) => befunde.filter((b) => b.schwere === 'blockierend');
const mit = (art: keyof Schrankenregister, ...namen: string[]): Schrankenregister => ({ ...register, [art]: [...register[art], ...namen] });
const schema = () => schemaAusAdresse(testDbAdresse() ?? undefined);

before(() => {
  assert.ok(db, `kein Zugang zur Testdatenbank: ${testDbGrund()}`);
});

after(async () => {
  await testDbSchliessen();
});

describe('Datenbankschranken — Register gegen Migrationen', () => {
  it('jede Prüf- und Ausschlussbedingung aus den Migrationen steht im Register', () => {
    const endstand = schrankenAusMigrationen(migrationen);
    // Der Leser findet überhaupt etwas — sonst bestünde der Vergleich zweier leerer Listen.
    assert.ok(endstand.pruefbedingungen.includes('stock_movements_vorzeichen'), 'der Leser findet die Prüfbedingungen nicht');
    assert.ok(endstand.ausschlussbedingungen.includes('invoices_vertragsperiode_ueberlappungsfrei'), 'der Leser findet die Ausschlussbedingungen nicht');

    assert.deepEqual([...register.pruefbedingungen].sort(), endstand.pruefbedingungen, 'Prüfbedingungen: Register und Migrationen weichen ab');
    assert.deepEqual([...register.ausschlussbedingungen].sort(), endstand.ausschlussbedingungen, 'Ausschlussbedingungen: Register und Migrationen weichen ab');
    // Und für alle fünf Arten: weder blockierend noch Warnung.
    assert.deepEqual(statischPruefen(migrationen, register), []);
    // Die Schranken des Prüfprotokolls gehören dazu.
    for (const name of ['audit_logs_nur_anfuegen', 'audit_logs_kein_leeren']) assert.ok(register.trigger.includes(name), `${name} fehlt im Register`);
  });

  it('eine gelistete, aber fehlende Schranke ist blockierend', () => {
    for (const art of SCHRANKENARTEN) {
      const befunde = blockierende(statischPruefen(migrationen, mit(art, 'gibt_es_nicht')));
      assert.equal(befunde.length, 1, `${art}: ${JSON.stringify(befunde)}`);
      assert.equal(befunde[0]!.name, 'gibt_es_nicht');
      assert.equal(befunde[0]!.art, art);
    }

    // Nur im Kommentar erwähnt ist nicht angelegt — die alte Prüfung suchte
    // bloss den Namen im Text und hätte das bestehen lassen.
    const kommentiert = `${migrationen}\n-- ALTER TABLE "x" ADD CONSTRAINT "nur_im_kommentar" CHECK (true);\n/* CREATE TRIGGER nur_im_block_kommentar */\n`;
    const kommentarBefunde = blockierende(statischPruefen(kommentiert, { ...mit('pruefbedingungen', 'nur_im_kommentar'), trigger: [...register.trigger, 'nur_im_block_kommentar'] }));
    assert.deepEqual(kommentarBefunde.map((b) => b.name).sort(), ['nur_im_block_kommentar', 'nur_im_kommentar']);

    // Angelegt und später wieder entfernt zählt nicht mehr.
    const entfernt = `${migrationen}\nALTER TABLE "x" ADD CONSTRAINT "wieder_weg" CHECK (true);\nALTER TABLE "x" DROP CONSTRAINT "wieder_weg";\n`;
    assert.deepEqual(blockierende(statischPruefen(entfernt, mit('pruefbedingungen', 'wieder_weg'))).map((b) => b.name), ['wieder_weg']);

    // Umgekehrt: angelegt, aber nicht gelistet, ist eine Warnung, kein Halt.
    const ohneEinen = { ...register, pruefbedingungen: register.pruefbedingungen.filter((n) => n !== 'stock_movements_vorzeichen') };
    const warnungen = statischPruefen(migrationen, ohneEinen);
    assert.deepEqual(
      warnungen.map((b) => [b.schwere, b.name]),
      [['warnung', 'stock_movements_vorzeichen']],
    );
  });

  it('eine gelistete, aber fehlende Schranke ist auch in der Datenbank blockierend', async () => {
    for (const art of SCHRANKENARTEN) {
      const befunde = blockierende(await livePruefen(db!, mit(art, 'gibt_es_nicht'), schema()));
      assert.deepEqual(befunde.map((b) => [b.art, b.name]), [[art, 'gibt_es_nicht']], `${art}: ${JSON.stringify(befunde)}`);
    }
  });
});

describe('Datenbankschranken — in der Datenbank', { concurrency: 1 }, () => {
  it('in der Testdatenbank: jeder Trigger aktiv, jeder Teilindex gültig, jede Bedingung validiert', async () => {
    assert.deepEqual(blockierende(await livePruefen(db!, register, schema())), []);

    /*
      Unabhängig vom Modul noch einmal direkt in den Katalogen — damit ein
      Fehler in `livePruefen` (etwa ein Schema, das nichts findet, und darum
      „nichts fehlt") hier nicht mit sich selbst übereinstimmt.
    */
    const trigger = await db!.$queryRaw<{ name: string; zustand: string }[]>`
      SELECT tgname AS name, tgenabled::text AS zustand FROM pg_trigger WHERE NOT tgisinternal`;
    for (const name of register.trigger) {
      const zeilen = trigger.filter((t) => t.name === name);
      assert.ok(zeilen.length > 0, `Trigger ${name} fehlt`);
      for (const z of zeilen) assert.equal(z.zustand, 'O', `Trigger ${name} ist nicht eingeschaltet (tgenabled=${z.zustand})`);
    }
    const indizes = await db!.$queryRaw<{ name: string; ok: boolean }[]>`
      SELECT c.relname AS name, (i.indisvalid AND i.indisready AND i.indisunique AND i.indpred IS NOT NULL) AS ok
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid`;
    for (const name of register.teilindizes) assert.equal(indizes.find((i) => i.name === name)?.ok, true, `Teilindex ${name} fehlt oder ist ungültig`);
    const bedingungen = await db!.$queryRaw<{ name: string; art: string; validiert: boolean }[]>`
      SELECT conname AS name, contype::text AS art, convalidated AS validiert FROM pg_constraint WHERE contype IN ('c', 'x')`;
    for (const [liste, art] of [[register.pruefbedingungen, 'c'], [register.ausschlussbedingungen, 'x']] as const) {
      for (const name of liste) {
        const b = bedingungen.find((z) => z.name === name);
        assert.ok(b, `Bedingung ${name} fehlt`);
        assert.equal(b.art, art, `${name}: contype ${b.art}`);
        assert.equal(b.validiert, true, `${name} ist nicht validiert`);
      }
    }
    const erweiterungen = await db!.$queryRaw<{ name: string }[]>`SELECT extname AS name FROM pg_extension`;
    for (const name of register.erweiterungen) assert.ok(erweiterungen.some((e) => e.name === name), `Erweiterung ${name} fehlt`);
  });

  it('ein abgeschalteter Trigger wird erkannt', async () => {
    await zurueckgerollt(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_nur_anfuegen');
      const befunde = blockierende(await livePruefen(tx, register, schema()));
      assert.equal(befunde.length, 1, JSON.stringify(befunde));
      assert.equal(befunde[0]!.name, 'audit_logs_nur_anfuegen');
      assert.match(befunde[0]!.titel, /abgeschaltet/);

      // Nur im Replikationsmodus feuernd ist im Betrieb ebenso aus.
      await tx.$executeRawUnsafe('ALTER TABLE audit_logs ENABLE REPLICA TRIGGER audit_logs_nur_anfuegen');
      const replika = blockierende(await livePruefen(tx, register, schema()));
      assert.deepEqual(replika.map((b) => b.name), ['audit_logs_nur_anfuegen']);
      assert.match(replika[0]!.titel, /Replikationsmodus/);
    });
    // Und nach dem Zurückrollen gilt er wieder — die Prüfung hinterlässt nichts.
    assert.deepEqual(blockierende(await livePruefen(db!, register, schema())), []);
  });

  it('ein fehlender Teilindex und eine nicht validierte Bedingung werden erkannt', async () => {
    await zurueckgerollt(async (tx) => {
      await tx.$executeRawUnsafe('DROP INDEX "time_entries_eine_laufende_je_person"');
      await tx.$executeRawUnsafe('ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_vorzeichen"');
      await tx.$executeRawUnsafe(`ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_vorzeichen" CHECK ("quantity" <> 0) NOT VALID`);
      const befunde = blockierende(await livePruefen(tx, register, schema()));
      assert.deepEqual(befunde.map((b) => b.name).sort(), ['stock_movements_vorzeichen', 'time_entries_eine_laufende_je_person']);
      assert.match(befunde.find((b) => b.name === 'stock_movements_vorzeichen')!.titel, /nicht validiert/);
      assert.match(befunde.find((b) => b.name === 'time_entries_eine_laufende_je_person')!.titel, /fehlt/);
    });
  });
});

describe('Datenbankschranken — Kommandozeile (Exitcodes)', () => {
  /*
    Der Vertrag mit `verify.ts` und dem CI-Auftrag: 0 bestanden, 1 Befund,
    2 nicht geprüft — und jeder Ausgang ausser 0 hält das Tor an. Die Fälle
    ohne Adresse und ohne Verbindung sind die gefährlichen: Ein Tor, das dort
    mit 0 endete, prüfte nur, ob es eine Verbindung gab.
  */
  const tsx = join(WURZEL, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const skript = join(WURZEL, 'scripts', 'datenbank-schranken.ts');
  const lauf = (umgebung: Record<string, string | undefined>) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...umgebung };
    for (const [k, v] of Object.entries(umgebung)) if (v === undefined) delete env[k];
    return spawnSync(process.execPath, [tsx, skript], { cwd: WURZEL, encoding: 'utf8', env, timeout: 90_000 });
  };

  it('0 gegen die Testdatenbank, 2 ohne DATABASE_URL und 2 ohne Verbindung', () => {
    const adresse = testDbAdresse();
    assert.ok(adresse, 'keine Adresse der Testdatenbank');

    const gut = lauf({ DATABASE_URL: adresse });
    assert.equal(gut.status, 0, gut.stdout + gut.stderr);
    assert.match(gut.stdout, /BESTANDEN/);
    assert.doesNotMatch(gut.stdout + gut.stderr, /:\/\/[^@\s]*:[^@\s]*@/, 'die Ausgabe enthält eine Adresse mit Zugangsdaten');

    // Ohne Variable — und ausdrücklich **nicht** aus `.env` nachgeladen, die im
    // Arbeitsverzeichnis liegen kann und auf die Entwicklungsdatenbank zeigt.
    const ohne = lauf({ DATABASE_URL: undefined });
    assert.equal(ohne.status, 2, ohne.stdout + ohne.stderr);
    assert.match(ohne.stdout, /NICHT GEPRÜFT/);

    const unerreichbar = lauf({ DATABASE_URL: 'postgresql://pruef:geheim@127.0.0.1:1/unerreichbar_test?schema=public' });
    assert.equal(unerreichbar.status, 2, unerreichbar.stdout + unerreichbar.stderr);
    assert.match(unerreichbar.stdout, /NICHT GEPRÜFT/);
    assert.doesNotMatch(unerreichbar.stdout + unerreichbar.stderr, /geheim/, 'das Passwort steht in der Ausgabe');
  });
});
