import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Prisma } from '@prisma/client';

import {
  ausloeserAusTyp,
  funktionenAusMigrationen,
  livePruefen,
  migrationenLesen,
  registerLesen,
  rumpfPruefsumme,
  schemaAusAdresse,
  schrankenAusMigrationen,
  SCHRANKENARTEN,
  statischPruefen,
  triggerAusMigrationen,
  type Befundart,
  type Schrankenart,
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
 * statische Prüfung. Seit 2026-10-01 dazu: Ein Trigger, dessen Funktion
 * durch ein `RETURN COALESCE(NEW, OLD)` ersetzt, der als `BEFORE INSERT`
 * neu angelegt, auf eine andere Tabelle gehängt oder mit `WHEN (false)`
 * versehen wurde, bestand die Live-Prüfung — sie verglich nur den Namen.
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
const mit = (art: Schrankenart, ...namen: string[]): Schrankenregister => ({ ...register, [art]: [...register[art], ...namen] });
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

  it('jede Triggerbindung und jeder Funktionsrumpf im Register entspricht den Migrationen', () => {
    const definitionen = triggerAusMigrationen(migrationen);
    for (const name of register.trigger) {
      const ist = definitionen.get(name);
      assert.ok(ist, `${name}: in den Migrationen nicht lesbar`);
      const { eingeschraenkt, ...bindung } = ist;
      assert.deepEqual(bindung, register.triggerbindungen[name], `${name}: Bindung weicht ab`);
      assert.equal(eingeschraenkt, false, `${name}: mit WHEN-Bedingung oder Spaltenliste`);
    }
    // Jede Funktion, die eine Migration anlegt — auch die Hilfsfunktionen,
    // auf denen eine Schranke ruht, ohne selbst an einem Trigger zu hängen.
    assert.deepEqual(Object.fromEntries(funktionenAusMigrationen(migrationen)), register.funktionen);
    assert.ok('bereinigung_freigegeben' in register.funktionen && 'vertragsfassung_ist_gesperrt' in register.funktionen, 'die Hilfsfunktionen fehlen im Register');
  });

  it('eine geänderte Schutzfunktion oder ein umgebauter Trigger in einer neuen Migration ist blockierend', () => {
    const befundeZu = (sql: string, reg: Schrankenregister = register) => blockierende(statischPruefen(`${migrationen}\n${sql}\n`, reg));
    const arten = (befunde: Schrankenbefund[]) => befunde.map((b) => [b.art, b.name]);

    // Der billigste Weg, den Protokollschutz auszuhebeln: dieselbe Funktion, wirkungslos.
    const neutral = '\nBEGIN\n  RETURN COALESCE(NEW, OLD);\nEND;\n';
    const ersetzt = befundeZu(`CREATE OR REPLACE FUNCTION audit_logs_nur_anfuegen() RETURNS trigger AS $$${neutral}$$ LANGUAGE plpgsql;`);
    assert.deepEqual(arten(ersetzt), [['funktionen', 'audit_logs_nur_anfuegen']]);
    // Die Meldung nennt die neue Prüfsumme — wer die Änderung durchgesehen hat, trägt sie ein.
    assert.ok(ersetzt[0]!.titel.includes(rumpfPruefsumme(neutral)), ersetzt[0]!.titel);

    // Eine Hilfsfunktion, die eine Schranke öffnet, ohne einen Trigger anzufassen.
    assert.deepEqual(arten(befundeZu('CREATE OR REPLACE FUNCTION bereinigung_freigegeben() RETURNS boolean AS $$ SELECT true $$ LANGUAGE sql STABLE;')), [
      ['funktionen', 'bereinigung_freigegeben'],
    ]);

    // Derselbe Name, anderer Auslöser, andere Tabelle, nur noch bedingt.
    const neuAngelegt = (definition: string) => `DROP TRIGGER audit_logs_nur_anfuegen ON "audit_logs";\nCREATE TRIGGER audit_logs_nur_anfuegen ${definition};`;
    const anderesEreignis = befundeZu(neuAngelegt('BEFORE INSERT ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION audit_logs_nur_anfuegen()'));
    assert.deepEqual(arten(anderesEreignis), [['trigger', 'audit_logs_nur_anfuegen']]);
    assert.match(anderesEreignis[0]!.titel, /Auslöser „BEFORE INSERT FOR EACH ROW" statt „BEFORE UPDATE OR DELETE FOR EACH ROW"/);
    const andereTabelle = befundeZu(neuAngelegt('BEFORE UPDATE OR DELETE ON "stock_movements" FOR EACH ROW EXECUTE FUNCTION audit_logs_nur_anfuegen()'));
    assert.match(andereTabelle[0]?.titel ?? '', /Tabelle stock_movements statt audit_logs/);
    const bedingt = befundeZu(neuAngelegt('BEFORE UPDATE OR DELETE ON "audit_logs" FOR EACH ROW WHEN (false) EXECUTE FUNCTION audit_logs_nur_anfuegen()'));
    assert.match(bedingt[0]?.titel ?? '', /WHEN-Bedingung/);
    // Die Reihenfolge der Ereignisse ist Schreibweise, keine Änderung.
    assert.deepEqual(befundeZu(neuAngelegt('BEFORE DELETE OR UPDATE ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION audit_logs_nur_anfuegen()')), []);

    // Umgekehrt: ein falscher Registereintrag gegen unveränderte Migrationen.
    const falsch: Schrankenregister = {
      ...register,
      triggerbindungen: { ...register.triggerbindungen, audit_logs_kein_leeren: { ...register.triggerbindungen.audit_logs_kein_leeren!, funktion: 'stock_movements_nur_anfuegen' } },
    };
    assert.match(blockierende(statischPruefen(migrationen, falsch))[0]?.titel ?? '', /Funktion audit_logs_nur_anfuegen statt stock_movements_nur_anfuegen/);

    // Ein Kommentar ausserhalb eines Rumpfs definiert nichts.
    assert.deepEqual(befundeZu('-- CREATE OR REPLACE FUNCTION audit_logs_nur_anfuegen() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;'), []);
  });

  it('ein Register mit Trigger ohne Bindung oder Bindung ohne Funktionsrumpf ist ein Formfehler', () => {
    /*
      Ein Formfehler und kein Befund, weil die Bindungsprüfung einen Trigger
      ohne Eintrag sonst schlicht überginge — „nichts vermerkt, nichts
      abweichend". Das Tor meldet einen Formfehler als NICHT GEPRÜFT (Exit 2).
    */
    const roh = JSON.parse(readFileSync(join(WURZEL, 'security', 'datenbank-schranken.json'), 'utf8')) as {
      triggerbindungen: Record<string, Record<string, string>>;
      funktionen: Record<string, string>;
    };
    const ordner = mkdtempSync(join(tmpdir(), 'clenaris-schranken-'));
    try {
      const lesen = (aendern: (r: typeof roh) => void) => {
        const kopie = structuredClone(roh);
        aendern(kopie);
        const datei = join(ordner, 'register.json');
        writeFileSync(datei, JSON.stringify(kopie));
        return () => registerLesen(datei);
      };
      assert.doesNotThrow(lesen(() => undefined));
      assert.throws(lesen((r) => delete r.triggerbindungen.audit_logs_nur_anfuegen), /audit_logs_nur_anfuegen" steht ohne Bindung/);
      assert.throws(lesen((r) => (r.triggerbindungen.gibt_es_nicht = { ...r.triggerbindungen.audit_logs_nur_anfuegen! })), /gehört zu keinem Trigger/);
      assert.throws(lesen((r) => delete r.funktionen.audit_logs_nur_anfuegen), /ruft „audit_logs_nur_anfuegen", die unter „funktionen" fehlt/);
      assert.throws(lesen((r) => (r.triggerbindungen.audit_logs_nur_anfuegen!.ausloeser = 'BEFORE UPDATE')), /braucht tabelle, funktion und ausloeser/);
      assert.throws(lesen((r) => (r.funktionen.audit_logs_nur_anfuegen = 'abc')), /SHA-256/);
      assert.throws(
        lesen((r) => delete (r as Partial<typeof roh>).funktionen),
        /„funktionen" muss ein Objekt/,
      );
    } finally {
      rmSync(ordner, { recursive: true, force: true });
    }
  });

  it('der Auslöser aus pg_trigger.tgtype liest sich wie im Register', () => {
    assert.equal(ausloeserAusTyp(27), 'BEFORE UPDATE OR DELETE FOR EACH ROW');
    assert.equal(ausloeserAusTyp(31), 'BEFORE INSERT OR UPDATE OR DELETE FOR EACH ROW');
    assert.equal(ausloeserAusTyp(19), 'BEFORE UPDATE FOR EACH ROW');
    assert.equal(ausloeserAusTyp(34), 'BEFORE TRUNCATE FOR EACH STATEMENT');
    assert.equal(ausloeserAusTyp(1 | 4), 'AFTER INSERT FOR EACH ROW');
    assert.equal(ausloeserAusTyp(64 | 1 | 4), 'INSTEAD OF INSERT FOR EACH ROW');
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

    // Bindung und Rumpf: Das Register stammt aus dem Text der Migrationen
    // (in Node gehasht), die Datenbank hasht `prosrc` selbst — stimmen beide
    // überein, lesen statische und Live-Prüfung wirklich denselben Rumpf.
    const bindungen = await db!.$queryRaw<{ name: string; tabelle: string; funktion: string }[]>`
      SELECT t.tgname AS name, c.relname AS tabelle, p.proname AS funktion
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid WHERE NOT t.tgisinternal`;
    for (const name of register.trigger) {
      const z = bindungen.find((b) => b.name === name);
      assert.equal(z?.tabelle, register.triggerbindungen[name]!.tabelle, `${name}: Tabelle`);
      assert.equal(z?.funktion, register.triggerbindungen[name]!.funktion, `${name}: Funktion`);
    }
    const ruempfe = await db!.$queryRaw<{ name: string; pruefsumme: string }[]>`
      SELECT p.proname AS name, encode(sha256(convert_to(replace(p.prosrc, chr(13), ''), 'UTF8')), 'hex') AS pruefsumme
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = ${schema()}`;
    for (const [name, pruefsumme] of Object.entries(register.funktionen)) {
      assert.equal(ruempfe.find((r) => r.name === name)?.pruefsumme, pruefsumme, `Funktion ${name}: Rumpf in der Datenbank weicht vom Register ab`);
    }
  });

  it('eine umgebaute Schutzfunktion, ein umgehängter oder eingeschränkter Trigger wird erkannt', async () => {
    /*
      Jeder Fall in einer eigenen, zurückgerollten Transaktion: Ein Trigger,
      der hier umgebaut wird, darf den nächsten Fall nicht beeinflussen —
      und erst recht nicht umgebaut zurückbleiben.
    */
    const fall = async (anweisungen: string[], erwartet: [Befundart, string], muster: RegExp) => {
      await zurueckgerollt(async (tx) => {
        for (const anweisung of anweisungen) await tx.$executeRawUnsafe(anweisung);
        const befunde = blockierende(await livePruefen(tx, register, schema()));
        assert.deepEqual(befunde.map((b) => [b.art, b.name]), [erwartet], JSON.stringify(befunde));
        assert.match(befunde[0]!.titel, muster);
      });
    };
    const neuAngelegt = (definition: string) => ['DROP TRIGGER audit_logs_nur_anfuegen ON audit_logs', `CREATE TRIGGER audit_logs_nur_anfuegen ${definition}`];

    // Trigger da, eingeschaltet, richtig gebunden — die Funktion wirkungslos.
    await fall(
      ['CREATE OR REPLACE FUNCTION audit_logs_nur_anfuegen() RETURNS trigger AS $$ BEGIN RETURN COALESCE(NEW, OLD); END; $$ LANGUAGE plpgsql'],
      ['funktionen', 'audit_logs_nur_anfuegen'],
      /ist geändert/,
    );
    // Die Hilfsfunktion, die alle Rechnungen freigäbe.
    await fall(
      ['CREATE OR REPLACE FUNCTION bereinigung_freigegeben() RETURNS boolean AS $$ SELECT true $$ LANGUAGE sql STABLE'],
      ['funktionen', 'bereinigung_freigegeben'],
      /ist geändert/,
    );
    // Rumpf unverändert, aber der Schwärzungsschalter fest an der Funktion.
    await fall([`ALTER FUNCTION audit_logs_nur_anfuegen() SET clenaris.audit_schwaerzung = 'on'`], ['funktionen', 'audit_logs_nur_anfuegen'], /eigene Einstellungen/);
    // Derselbe Name, aber nur noch beim Anlegen.
    await fall(
      neuAngelegt('BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_logs_nur_anfuegen()'),
      ['trigger', 'audit_logs_nur_anfuegen'],
      /Auslöser „BEFORE INSERT FOR EACH ROW"/,
    );
    // Auf eine andere Tabelle gehängt.
    await fall(
      [
        'DROP TRIGGER audit_logs_kein_leeren ON audit_logs',
        'CREATE TRIGGER audit_logs_kein_leeren BEFORE TRUNCATE ON stock_movements FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_nur_anfuegen()',
      ],
      ['trigger', 'audit_logs_kein_leeren'],
      /Tabelle stock_movements statt audit_logs/,
    );
    // Feuert nie oder nur bei einer Spalte, die niemand ändert.
    await fall(
      neuAngelegt('BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW WHEN (false) EXECUTE FUNCTION audit_logs_nur_anfuegen()'),
      ['trigger', 'audit_logs_nur_anfuegen'],
      /WHEN-Bedingung/,
    );
    await fall(
      neuAngelegt('BEFORE UPDATE OF "userAgent" OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_logs_nur_anfuegen()'),
      ['trigger', 'audit_logs_nur_anfuegen'],
      /Spaltenliste/,
    );
    // Eine gleichnamige, wirkungslose Funktion in einem anderen Schema.
    await fall(
      [
        'CREATE SCHEMA pruef_schranken_fremd',
        'CREATE FUNCTION pruef_schranken_fremd.audit_logs_nur_anfuegen() RETURNS trigger AS $$ BEGIN RETURN COALESCE(NEW, OLD); END; $$ LANGUAGE plpgsql',
        ...neuAngelegt('BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION pruef_schranken_fremd.audit_logs_nur_anfuegen()'),
      ],
      ['trigger', 'audit_logs_nur_anfuegen'],
      /Schema pruef_schranken_fremd statt/,
    );

    // Nach allen Fällen: nichts zurückgeblieben.
    assert.deepEqual(blockierende(await livePruefen(db!, register, schema())), []);
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
