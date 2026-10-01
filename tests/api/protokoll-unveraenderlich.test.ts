import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type { Prisma } from '@prisma/client';

import { schwaerzenInTransaktion, zeileSchwaerzen } from '../../scripts/security/audit-schwaerzung';
import { freitextSchwaerzen, wertSchwaerzen } from '../../src/lib/sensitive-fields';
import { eigeneOrganisationId, schutzfreiAufraeumen, testDb, testDbAdresse, testDbGrund, testDbSchliessen } from '../helpers/testdb';

/**
 * Das Prüfprotokoll lässt sich nur fortschreiben (Produktion V2, 2026-09-30).
 *
 * Migration `20260930120000_protokoll_nur_anfuegen` legt zwei Trigger auf
 * `audit_logs`: `audit_logs_nur_anfuegen` (je Zeile, UPDATE und DELETE) und
 * `audit_logs_kein_leeren` (je Anweisung, TRUNCATE). Gegen den alten Stand
 * scheitert jeder Fall dieser Datei, der ein „verweigert" erwartet — die
 * Datenbank nahm jede Änderung, jedes Löschen und jedes Leeren an.
 *
 * **Jede Änderung läuft in einer Transaktion, die immer zurückgerollt wird**
 * (`zurueckgerollt`). Das ist keine Bequemlichkeit, sondern die Bedingung,
 * unter der diese Prüfung überhaupt laufen darf: Fehlte der Trigger — genau
 * der Fall, den sie finden soll —, dann leerte `TRUNCATE audit_logs` sonst
 * das ganze Protokoll der Testdatenbank, und jede folgende Datei, die einen
 * Eintrag sucht, scheiterte an einem Schaden, den diese hier angerichtet
 * hätte. Innerhalb der Transaktion trennen Sicherungspunkte die einzelnen
 * Versuche: Ein verweigerter Befehl bricht sonst die ganze Transaktion ab,
 * und jede Zusicherung danach läse „current transaction is aborted" statt
 * des Bestands.
 *
 * Eine einzige Ausnahme schreibt wirklich: „audit-bereinigung schwärzt über
 * den Schalter" prüft `zeileSchwaerzen`, das seine Transaktion selbst öffnet
 * und abschliesst — nur so zeigt sich, dass der Schalter und die Änderung in
 * **derselben** Transaktion stehen —, und danach das Skript selbst, als
 * eigenen Prozess gegen die Testdatenbank, so wie es betrieben wird. Beides
 * schreibt eigene, markierte Zeilen; das Skript zusätzlich seinen
 * Abschlusseintrag. Diese Zeilen räumt die Datei vor und nach dem Lauf über
 * `schutzfreiAufraeumen` weg.
 *
 * Keine Prüfung hier braucht den HTTP-Server: Der Trigger ist eine Regel der
 * Datenbank, und einen Weg über die Anwendung, der ihn auslöst, gibt es mit
 * Absicht nicht (`src/` legt Protokollzeilen nur an).
 */

type Tx = Prisma.TransactionClient;

const db = testDb();
/** Markiert jede Zeile dieser Datei — in der Entität oder, wo die Entität eine echte sein muss, in `entityId`. */
const MARKE = 'PruefProtokollUnveraenderlich';
const VERWEIGERT = /Das Prüfprotokoll lässt sich nur fortschreiben/;

let orgId = '';

class Zurueckrollen extends Error {}

/**
 * Arbeit in einer Transaktion, die **immer** zurückgerollt wird — auch wenn
 * alle Zusicherungen bestehen. `lock_timeout`, weil `TRUNCATE` und
 * `ALTER TABLE` eine exklusive Sperre verlangen: Hielte ein anderer Prozess
 * die Tabelle, soll die Prüfung nach fünf Sekunden mit einer klaren Meldung
 * scheitern, statt bis zum Abbruch des ganzen Laufs zu warten.
 */
async function zurueckgerollt<T>(arbeit: (tx: Tx) => Promise<T>): Promise<T> {
  let ergebnis: { wert: T } | undefined;
  try {
    await db!.$transaction(
      async (tx) => {
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

/** SQLSTATE hinter einem Prisma-Fehler — Modell- (P2039) wie Rohabfrage (P2010) tragen ihn unter `driverAdapterError`. */
function sqlZustand(fehler: unknown): string | undefined {
  const meta = (fehler as { meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: string } } } }).meta;
  return typeof meta?.code === 'string' ? meta.code : meta?.driverAdapterError?.cause?.originalCode;
}

/**
 * Ein Versuch, der an der Sperre scheitern muss — mit P0001 und der Meldung
 * des Triggers, nicht bloss „irgendwie". Ein Sicherungspunkt davor, damit die
 * Transaktion danach weiter lesbar ist.
 */
async function verweigert(tx: Tx, versuch: () => Promise<unknown>, was: string): Promise<void> {
  await tx.$executeRawUnsafe('SAVEPOINT pruefung');
  await assert.rejects(
    versuch(),
    (fehler: unknown) => {
      assert.equal(sqlZustand(fehler), 'P0001', `${was}: SQLSTATE ${sqlZustand(fehler) ?? '—'} statt P0001 — ${String(fehler)}`);
      assert.match(String((fehler as Error).message), VERWEIGERT, `${was}: nicht die Meldung des Protokolltriggers`);
      return true;
    },
    `${was}: ging durch — der Trigger fehlt oder lässt es zu`,
  );
  await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT pruefung');
  await tx.$executeRawUnsafe('RELEASE SAVEPOINT pruefung');
}

function eintragAnlegen(tx: Tx, daten: Partial<Prisma.AuditLogUncheckedCreateInput> = {}) {
  return tx.auditLog.create({
    data: {
      organizationId: orgId,
      action: 'UPDATE',
      entity: MARKE,
      entityId: `${MARKE}-${Date.now()}`,
      summary: 'Prüfeintrag vorher',
      changes: { feld: { vorher: 'a', nachher: 'b' } },
      ip: '192.0.2.1',
      userAgent: 'Prüfreihe',
      ...daten,
    },
  });
}

function kontoAnlegen(tx: Tx, organizationId = orgId) {
  return tx.user.create({
    data: {
      organizationId,
      email: `protokoll.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@protokoll-pruef.example.ch`,
      passwordHash: 'kein-echter-hash',
      firstName: 'Protokoll',
      lastName: 'Prüfkonto',
      role: 'CUSTOMER',
      status: 'ACTIVE',
    },
  });
}

/** Die ganze Zeile ohne die genannten Spalten — für „alles andere unverändert". */
function ohne<T extends Record<string, unknown>>(zeile: T, ...spalten: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(zeile).filter(([schluessel]) => !spalten.includes(schluessel)));
}

/** Der Abschlusseintrag, den `scripts/audit-bereinigung.ts --anwenden` schreibt. */
const BEREINIGUNG_ZUSAMMENFASSUNG = 'Altbestand nachträglich geschwärzt';

async function aufraeumen(): Promise<void> {
  /*
    Die Zeilen, die wirklich geschrieben werden (Bereinigungsfall), über
    `schutzfreiAufraeumen`, weil genau das Löschen sonst verweigert wird.

    Dazu der Abschlusseintrag des Bereinigungsskripts. Er trägt keine Marke —
    das Skript schreibt ihn so, wie es ihn in der Produktion schreibt —, und
    wird deshalb an Entität und Zusammenfassung erkannt. Das trifft in der
    Testdatenbank nur Einträge dieser Datei: Niemand sonst führt das Skript
    gegen sie aus. Bliebe er stehen, wüchse das Protokoll der Testdatenbank
    mit jedem Lauf um einen Eintrag, der eine Bereinigung behauptet, die es
    in diesem Bestand nie gab.
  */
  await schutzfreiAufraeumen((tx) =>
    tx.auditLog.deleteMany({
      where: {
        OR: [
          { entity: MARKE },
          { entityId: { startsWith: MARKE } },
          { entity: 'AuditLog', summary: { startsWith: BEREINIGUNG_ZUSAMMENFASSUNG } },
        ],
      },
    }),
  );
}

before(async () => {
  assert.ok(db, `kein Zugang zur Testdatenbank: ${testDbGrund()}`);
  orgId = (await eigeneOrganisationId()) ?? '';
  assert.ok(orgId, 'eigene Organisation nicht gefunden');
  await aufraeumen();
});

after(async () => {
  await aufraeumen();
  await testDbSchliessen();
});

describe('Prüfprotokoll — nur fortschreiben (in zurückgerollten Transaktionen)', { concurrency: 1 }, () => {
  it('ändern: P0001', async () => {
    await zurueckgerollt(async (tx) => {
      const eintrag = await eintragAnlegen(tx);
      await verweigert(tx, () => tx.auditLog.update({ where: { id: eintrag.id }, data: { summary: 'umgeschrieben' } }), 'Zusammenfassung ändern');
      await verweigert(tx, () => tx.auditLog.update({ where: { id: eintrag.id }, data: { changes: {} } }), 'Änderungen leeren');
      await verweigert(tx, () => tx.auditLog.update({ where: { id: eintrag.id }, data: { createdAt: new Date(0) } }), 'Zeitpunkt zurückdatieren');
      await verweigert(tx, () => tx.auditLog.updateMany({ where: { entity: MARKE }, data: { action: 'DELETE' } }), 'Handlung in Menge umschreiben');
      await verweigert(tx, () => tx.$executeRawUnsafe(`UPDATE audit_logs SET "ip" = NULL WHERE id = $1`, eintrag.id), 'rohes UPDATE');

      const nachher = await tx.auditLog.findUniqueOrThrow({ where: { id: eintrag.id } });
      assert.deepEqual(nachher, eintrag, 'die Zeile hat sich trotz Verweigerung verändert');
    });
  });

  it('löschen: P0001', async () => {
    await zurueckgerollt(async (tx) => {
      const eintrag = await eintragAnlegen(tx);
      await verweigert(tx, () => tx.auditLog.delete({ where: { id: eintrag.id } }), 'einzeln löschen');
      await verweigert(tx, () => tx.auditLog.deleteMany({ where: { entity: MARKE } }), 'in Menge löschen');
      await verweigert(tx, () => tx.$executeRawUnsafe(`DELETE FROM audit_logs WHERE id = $1`, eintrag.id), 'rohes DELETE');
      assert.ok(await tx.auditLog.findUnique({ where: { id: eintrag.id } }), 'die Zeile ist weg');
    });
  });

  it('leeren (TRUNCATE): P0001', async () => {
    await zurueckgerollt(async (tx) => {
      await eintragAnlegen(tx);
      const vorher = await tx.auditLog.count();
      await verweigert(tx, () => tx.$executeRawUnsafe('TRUNCATE TABLE audit_logs'), 'TRUNCATE');
      await verweigert(tx, () => tx.$executeRawUnsafe('TRUNCATE TABLE audit_logs RESTART IDENTITY CASCADE'), 'TRUNCATE … CASCADE');
      assert.equal(await tx.auditLog.count(), vorher, 'das Protokoll wurde geleert');
    });
  });

  it('ein gelöschtes Konto löst nur den Verweis (userId → NULL), der Eintrag bleibt', async () => {
    await zurueckgerollt(async (tx) => {
      const konto = await kontoAnlegen(tx);
      const eintrag = await eintragAnlegen(tx, { userId: konto.id, entityId: `${MARKE}-${konto.id}` });

      // Von Hand ist dieselbe Änderung verboten: Nur die Kaskade eines
      // tatsächlich gelöschten Kontos darf den Verweis lösen.
      await verweigert(tx, () => tx.auditLog.update({ where: { id: eintrag.id }, data: { userId: null } }), 'userId von Hand leeren');

      await tx.user.delete({ where: { id: konto.id } });
      const nachher = await tx.auditLog.findUnique({ where: { id: eintrag.id } });
      assert.ok(nachher, 'der Eintrag verschwand mit dem Konto');
      assert.equal(nachher.userId, null, 'ON DELETE SET NULL hat den Verweis nicht gelöst');
      assert.deepEqual(ohne(nachher, 'userId'), ohne(eintrag, 'userId'), 'mit dem Verweis hat sich mehr geändert als der Verweis');
    });
  });

  it('auch verschachtelt ändert oder löscht ein fremder Trigger das Protokoll nicht', async () => {
    /*
      `pg_trigger_depth() > 1` allein wäre die schwache Regel: Jeder Trigger
      auf irgendeiner Tabelle liefe verschachtelt und dürfte dann ändern.
      Hier ein solcher Trigger auf einer Wegwerftabelle — er setzt `userId`
      auf NULL, obwohl das Konto besteht, schreibt die Zusammenfassung um
      oder löscht, obwohl die Organisation besteht. Jeder Versuch muss an
      den Bedingungen hinter der Tiefe scheitern: Konto weg, Organisation
      weg, alles andere unverändert.
    */
    await zurueckgerollt(async (tx) => {
      const konto = await kontoAnlegen(tx);
      const eintrag = await eintragAnlegen(tx, { userId: konto.id });
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE pruef_ausloeser (id text, art text) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`
        CREATE FUNCTION pg_temp.pruef_fremder_trigger() RETURNS trigger AS $$
        BEGIN
          IF NEW.art = 'verweis' THEN UPDATE audit_logs SET "userId" = NULL WHERE id = NEW.id; END IF;
          IF NEW.art = 'inhalt' THEN UPDATE audit_logs SET "summary" = 'umgeschrieben' WHERE id = NEW.id; END IF;
          IF NEW.art = 'loeschen' THEN DELETE FROM audit_logs WHERE id = NEW.id; END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql`);
      await tx.$executeRawUnsafe(
        `CREATE TRIGGER pruef_fremder_trigger AFTER INSERT ON pruef_ausloeser FOR EACH ROW EXECUTE FUNCTION pg_temp.pruef_fremder_trigger()`,
      );
      for (const art of ['verweis', 'inhalt', 'loeschen']) {
        await verweigert(tx, () => tx.$executeRawUnsafe(`INSERT INTO pruef_ausloeser VALUES ($1, $2)`, eintrag.id, art), `fremder Trigger (${art})`);
      }
      assert.deepEqual(await tx.auditLog.findUnique({ where: { id: eintrag.id } }), eintrag);
    });
  });

  it('Schwärzung nur mit Schalter und nur in changes/summary', async () => {
    await zurueckgerollt(async (tx) => {
      const konto = await kontoAnlegen(tx);
      const eintrag = await eintragAnlegen(tx, { userId: konto.id, changes: { monthlySalary: { vorher: 5200, nachher: 5400 } } });
      const geschwaerzt = { monthlySalary: { vorher: '[geschwärzt]', nachher: '[geschwärzt]' } };

      // Ohne Schalter: auch die Schwärzung ist eine verbotene Änderung.
      await verweigert(tx, () => tx.auditLog.update({ where: { id: eintrag.id }, data: { changes: geschwaerzt } }), 'Schwärzung ohne Schalter');

      // Ein anderer Wert als 'on' ist kein Schalter.
      await tx.$executeRawUnsafe('SAVEPOINT schalter');
      await tx.$queryRaw`SELECT set_config('clenaris.audit_schwaerzung', 'true', true)`;
      await verweigert(tx, () => tx.auditLog.update({ where: { id: eintrag.id }, data: { changes: geschwaerzt } }), "Schalter 'true' statt 'on'");
      // Zurück vor den falschen Schalter: Postgres nimmt eine Einstellung
      // mit dem Sicherungspunkt zurück.
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT schalter');
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT schalter');

      // Mit Schalter: `changes` und `summary` ja, alles andere nein.
      await schwaerzenInTransaktion(tx, eintrag.id, { changes: geschwaerzt, summary: 'Lohn geändert' });
      const nachher = await tx.auditLog.findUniqueOrThrow({ where: { id: eintrag.id } });
      assert.deepEqual(nachher.changes, geschwaerzt);
      assert.equal(nachher.summary, 'Lohn geändert');
      assert.deepEqual(ohne(nachher, 'changes', 'summary'), ohne(eintrag, 'changes', 'summary'), 'die Schwärzung hat mehr als changes/summary geändert');

      /*
        Der Schalter gilt für die eine Schwärzung, nicht für den Rest der
        Transaktion (2026-10-01). Bis dahin blieb er an, und ein Aufrufer in
        einer grösseren Transaktion konnte danach jede weitere Zeile in
        `changes` und `summary` umschreiben — gegen den alten Stand scheitert
        genau diese Zusicherung.
      */
      const [{ schalterDanach }] = await tx.$queryRaw<{ schalterDanach: string | null }[]>`
        SELECT current_setting('clenaris.audit_schwaerzung', true) AS "schalterDanach"`;
      assert.notEqual(schalterDanach, 'on', 'der Schalter ist nach der Schwärzung noch an');
      const zweiter = await eintragAnlegen(tx, { entityId: `${MARKE}-zweiter` });
      await verweigert(tx, () => tx.auditLog.update({ where: { id: zweiter.id }, data: { summary: 'nachträglich umgeschrieben' } }), 'nach der Schwärzung, in derselben Transaktion');

      // Auch eine gescheiterte Schwärzung (Zeile gibt es nicht) lässt ihn nicht an.
      await assert.rejects(schwaerzenInTransaktion(tx, `${MARKE}-gibt-es-nicht`, { summary: 'x' }));
      const [{ schalterNachFehler }] = await tx.$queryRaw<{ schalterNachFehler: string | null }[]>`
        SELECT current_setting('clenaris.audit_schwaerzung', true) AS "schalterNachFehler"`;
      assert.notEqual(schalterNachFehler, 'on', 'der Schalter blieb nach einer gescheiterten Schwärzung an');

      // Für die Gegenproben „mit Schalter" ausdrücklich wieder an — die
      // Ausnahme soll an Wer, Wann, Was und am Löschen auch dann scheitern.
      await tx.$queryRaw`SELECT set_config('clenaris.audit_schwaerzung', 'on', true)`;
      await verweigert(tx, () => tx.auditLog.update({ where: { id: eintrag.id }, data: { entity: 'Anders' } }), 'Entität mit Schalter');
      await verweigert(tx, () => tx.auditLog.update({ where: { id: eintrag.id }, data: { action: 'DELETE' } }), 'Handlung mit Schalter');
      await verweigert(tx, () => tx.auditLog.update({ where: { id: eintrag.id }, data: { userId: null } }), 'Person mit Schalter');
      await verweigert(tx, () => tx.auditLog.update({ where: { id: eintrag.id }, data: { summary: 'x', createdAt: new Date(0) } }), 'Zeitpunkt neben der Zusammenfassung');
      await verweigert(tx, () => tx.auditLog.delete({ where: { id: eintrag.id } }), 'Löschen mit Schalter');
      await verweigert(tx, () => tx.$executeRawUnsafe('TRUNCATE TABLE audit_logs'), 'Leeren mit Schalter');
    });

    // Der Schalter gilt nur in seiner Transaktion: In der nächsten — auf
    // derselben oder einer anderen Verbindung des Pools — ist er aus.
    await zurueckgerollt(async (tx) => {
      const eintrag = await eintragAnlegen(tx);
      const [{ schalter }] = await tx.$queryRaw<{ schalter: string | null }[]>`SELECT current_setting('clenaris.audit_schwaerzung', true) AS schalter`;
      assert.notEqual(schalter, 'on', 'der Schalter hat die Transaktion überlebt');
      await verweigert(tx, () => tx.auditLog.update({ where: { id: eintrag.id }, data: { summary: 'danach' } }), 'nach dem Ende der Transaktion');
    });
  });

  it('das Löschen einer ganzen Organisation nimmt ihr Protokoll mit', async () => {
    await zurueckgerollt(async (tx) => {
      const eigeneVorher = await tx.auditLog.count({ where: { organizationId: orgId } });
      const wegwerf = await tx.organization.create({
        data: {
          slug: `pruef-protokoll-wegwerf-${Date.now()}`,
          name: 'Wegwerf-Organisation der Protokollprüfung',
          email: 'wegwerf@protokoll-pruef.example.ch',
          street: 'Prüfweg',
          streetNo: '1',
          postalCode: '3000',
          city: 'Bern',
        },
      });
      const konto = await kontoAnlegen(tx, wegwerf.id);
      await eintragAnlegen(tx, { organizationId: wegwerf.id, userId: konto.id });
      await eintragAnlegen(tx, { organizationId: wegwerf.id });

      // Solange die Organisation besteht, ist ihr Protokoll so geschützt wie jedes.
      await verweigert(tx, () => tx.auditLog.deleteMany({ where: { organizationId: wegwerf.id } }), 'Protokoll einer bestehenden Organisation löschen');

      await tx.organization.delete({ where: { id: wegwerf.id } });
      assert.equal(await tx.auditLog.count({ where: { organizationId: wegwerf.id } }), 0, 'das Protokoll der gelöschten Organisation blieb stehen');
      assert.equal(await tx.auditLog.count({ where: { organizationId: orgId } }), eigeneVorher, 'die Kaskade hat Einträge der eigenen Organisation berührt');
    });
  });

  it('audit-bereinigung schwärzt über den Schalter', async () => {
    // 1. Das Skript nimmt den einen Weg und keinen direkten daneben.
    const wurzel = process.cwd();
    const skript = readFileSync(join(wurzel, 'scripts', 'audit-bereinigung.ts'), 'utf8');
    assert.match(skript, /zeileSchwaerzen\(prisma,/, 'audit-bereinigung.ts schwärzt nicht über zeileSchwaerzen');
    assert.doesNotMatch(skript, /auditLog\.(update|updateMany|delete|deleteMany|upsert)\(/, 'audit-bereinigung.ts ändert das Protokoll direkt');

    // 2. Den Schalter setzt genau eine Stelle — sonst findet eine Suche nach
    //    ihm nicht mehr jeden Weg, der das Protokoll ändern kann.
    const setzend: string[] = [];
    const gehe = (ordner: string) => {
      for (const name of readdirSync(ordner)) {
        const voll = join(ordner, name);
        if (statSync(voll).isDirectory()) gehe(voll);
        else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name) && /set_config\(\s*'clenaris\.audit_schwaerzung'/.test(readFileSync(voll, 'utf8'))) {
          setzend.push(relative(wurzel, voll).split(sep).join('/'));
        }
      }
    };
    for (const ordner of ['src', 'scripts', 'prisma']) gehe(join(wurzel, ordner));
    assert.deepEqual(setzend, ['scripts/security/audit-schwaerzung.ts']);

    // 3. Wirklich geschrieben, in der eigenen Transaktion von `zeileSchwaerzen`:
    //    Stünden Schalter und Änderung nicht in derselben Transaktion, endete
    //    der lokale Schalter vor dem UPDATE, und hier käme P0001.
    const zeile = await db!.auditLog.create({
      data: {
        organizationId: orgId,
        action: 'UPDATE',
        entity: 'Employee',
        entityId: `${MARKE}-bereinigung`,
        summary: 'Personalakte geändert, IBAN CH93 0076 2011 6238 5295 7',
        changes: { monthlySalary: { vorher: 5200, nachher: 5400 }, city: { vorher: 'Bern', nachher: 'Thun' } },
      },
    });
    const neueAenderungen = wertSchwaerzen(zeile.changes, zeile.entity);
    const neueZusammenfassung = freitextSchwaerzen(zeile.summary!);
    assert.notDeepEqual(neueAenderungen, zeile.changes, 'die Schwärzungsregel greift auf den Prüfwert nicht — die Prüfung bewiese nichts');
    assert.notEqual(neueZusammenfassung, zeile.summary);

    await zeileSchwaerzen(db!, zeile.id, { changes: neueAenderungen as Prisma.InputJsonValue, summary: neueZusammenfassung });
    const nachher = await db!.auditLog.findUniqueOrThrow({ where: { id: zeile.id } });
    assert.deepEqual(nachher.changes, neueAenderungen);
    assert.equal(nachher.summary, neueZusammenfassung);
    assert.doesNotMatch(JSON.stringify(nachher.changes), /5200|5400/, 'der Lohn steht nach der Schwärzung noch im Protokoll');
    assert.deepEqual(ohne(nachher, 'changes', 'summary'), ohne(zeile, 'changes', 'summary'));

    /*
      4. Das Skript selbst, wie es betrieben wird: ein eigener Prozess mit
         `DATABASE_URL` auf die Testdatenbank, erst trocken, dann mit
         `--anwenden`. Die Quelltextprüfung in Schritt 1 sagt nur, dass der
         Aufruf dasteht; erst der Lauf zeigt, dass er unter dem Trigger auch
         durchkommt — ein direktes `auditLog.update` daneben, eine
         Transaktion, die der Schalter nicht erreicht, oder ein zusätzlich
         geändertes Feld endeten hier mit P0001 und Exitcode 1.

         Das Skript sieht das ganze Protokoll der Testdatenbank durch, nicht
         nur diese Zeile. Das ist sein Betrieb und hier unschädlich: Seit
         RB-010 schreibt die Anwendung jede Zeile schon geschwärzt
         (`protokoll-schwaerzung.test.ts`), und keine Prüfdatei legt eine
         ungeschwärzte an, auf die sie sich später verliesse.
    */
    const tsx = join(wurzel, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const adresse = testDbAdresse();
    assert.ok(adresse, 'keine Adresse der Testdatenbank');
    const bereinigung = (...argumente: string[]) =>
      spawnSync(process.execPath, [tsx, join(wurzel, 'scripts', 'audit-bereinigung.ts'), ...argumente], {
        cwd: wurzel,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: adresse },
        timeout: 120_000,
      });

    const altbestand = await db!.auditLog.create({
      data: {
        organizationId: orgId,
        action: 'UPDATE',
        entity: 'Employee',
        entityId: `${MARKE}-bereinigung-skript`,
        summary: 'Personalakte geändert',
        changes: { monthlySalary: { vorher: 6100, nachher: 6350 }, hourlyRate: { vorher: 38, nachher: 39.5 } },
        ip: '192.0.2.7',
      },
    });

    const trocken = bereinigung();
    assert.equal(trocken.status, 0, `Trockenlauf: ${trocken.stdout}${trocken.stderr}`);
    assert.match(trocken.stdout, /Trockenlauf — nichts geschrieben/);
    assert.ok(Number(/Betroffen\s*:\s*(\d+)/.exec(trocken.stdout)?.[1] ?? 0) >= 1, `der Trockenlauf findet die ungeschwärzte Zeile nicht: ${trocken.stdout}`);
    assert.deepEqual(await db!.auditLog.findUniqueOrThrow({ where: { id: altbestand.id } }), altbestand, 'der Trockenlauf hat geschrieben');

    const angewendet = bereinigung('--anwenden');
    assert.equal(angewendet.status, 0, `Bereinigung: ${angewendet.stdout}${angewendet.stderr}`);
    assert.doesNotMatch(angewendet.stdout + angewendet.stderr, /P0001|nur fortschreiben/, 'die Bereinigung ist an der Sperre gescheitert');
    const geschwaerzt = await db!.auditLog.findUniqueOrThrow({ where: { id: altbestand.id } });
    assert.doesNotMatch(JSON.stringify(geschwaerzt.changes), /6100|6350|38|39\.5/, 'nach dem Skript stehen Lohn und Stundenansatz noch im Protokoll');
    assert.deepEqual(Object.keys(geschwaerzt.changes as object).sort(), ['hourlyRate', 'monthlySalary'], 'die Schlüssel gehören stehen gelassen — nur die Werte werden geschwärzt');
    assert.deepEqual(ohne(geschwaerzt, 'changes', 'summary'), ohne(altbestand, 'changes', 'summary'), 'das Skript hat mehr als changes/summary geändert');
    assert.ok(
      await db!.auditLog.findFirst({ where: { entity: 'AuditLog', summary: { startsWith: BEREINIGUNG_ZUSAMMENFASSUNG }, createdAt: { gte: altbestand.createdAt } } }),
      'die Bereinigung hat sich nicht selbst protokolliert',
    );
  });
});
