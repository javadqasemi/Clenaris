import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ausgangsfilter, kuerzel, mitPlatzhaltern, namenErsetzen, platzhalterZurueck, summeErsetzungen } from '../../src/lib/ai/governance';
import { post, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { testDb, testDbSchliessen } from '../helpers/testdb';

/**
 * Wave 15 — KI-Governance und Datensparsamkeit.
 *
 * Direkt geprüft: der Ausgangsfilter, die Platzhalter und die Kürzel — die
 * Regeln, die vor jeder Übermittlung an den KI-Anbieter greifen. Über HTTP:
 * Rollen, und dass ohne konfigurierten Anbieter nichts „halb" passiert (kein
 * Protokolleintrag für eine Nutzung, die nicht stattfand).
 *
 * Der Anbieter selbst wird hier nicht aufgerufen; ob seine Antworten gut
 * sind, ist keine Frage einer automatisierten Prüfreihe.
 */

describe('Ausgangsfilter', () => {
  it('ersetzt E-Mail, Telefon, IBAN, AHV-Nummer und Datenbankkennung', () => {
    const roh =
      'Frau Keller (anna.keller@example.ch, +41 79 123 45 67, 031 555 12 34) zahlt auf CH93 0076 2011 6238 5295 7, ' +
      'AHV 756.1234.5678.97, Akte cmucig2es00nycbikwi5sfz2r.';
    const f = ausgangsfilter(roh);
    for (const verboten of ['anna.keller@example.ch', '79 123 45 67', '031 555 12 34', 'CH93', '756.1234', 'cmucig2es00nycbikwi5sfz2r']) {
      assert.ok(!f.text.includes(verboten), `${verboten} darf das Haus nicht verlassen: ${f.text}`);
    }
    assert.deepEqual(f.ersetzungen, { ahv: 1, iban: 1, email: 1, telefon: 2, kennung: 1 });
    assert.ok(f.text.includes('Frau Keller'), 'Namen im Freitext bleiben — sparsam, nicht anonym');
  });

  it('lässt fachlichen Text, Beträge und Platzhalter unberührt', () => {
    const text = 'Büro 120 m², wöchentlich, CHF 1\'250.00 pro Monat, Termin 24.09.2026 um 07:30. {{EMPFAENGER}}';
    assert.equal(ausgangsfilter(text).text, text);
  });

  it('zählt über mehrere Teile zusammen', () => {
    assert.deepEqual(summeErsetzungen({ email: 1 }, { email: 2, iban: 1 }), { email: 3, iban: 1 });
  });
});

describe('Platzhalter und Kürzel', () => {
  it('Namen verlassen den Prozess nur als Platzhalter und kommen danach zurück', () => {
    const namen = { EMPFAENGER: 'Anna Keller', ABSENDER: 'Beat Meier' };
    const hinaus = mitPlatzhaltern('Liebe Anna Keller, Beat Meier meldet sich wegen Anna Kellers Büro.', namen);
    assert.ok(!hinaus.includes('Anna Keller') && !hinaus.includes('Beat Meier'), hinaus);
    const zurueck = platzhalterZurueck('Guten Tag {{EMPFAENGER}}\nFreundliche Grüsse\n{{ABSENDER}}', namen);
    assert.equal(zurueck, 'Guten Tag Anna Keller\nFreundliche Grüsse\nBeat Meier');
  });

  it('längere Namen zuerst: „Anna Keller" wird nicht als „Anna" zerteilt', () => {
    const hinaus = mitPlatzhaltern('Anna Keller und Anna', { A: 'Anna', B: 'Anna Keller' });
    assert.equal(hinaus, '{{B}} und {{A}}');
  });

  /**
   * `namenErsetzen` (2026-09-27): Der Führungsassistent schickte
   * Bewertungstexte roh hinaus und nannte das „anonymisiert". Jetzt geht jeder
   * Name, den die Datenbank kennt, als `[NAME]` hinaus — ohne Rückweg.
   */
  it('bekannte Namen werden zu [NAME] — ganze Wörter, Umlaute, gross oder klein', () => {
    const r = namenErsetzen('Frau Müller war super, auch müller jun. — Müllerei bleibt. Keller-Team: Anna Keller.', ['Müller', 'Anna Keller', 'Keller']);
    assert.equal(r.text, 'Frau [NAME] war super, auch [NAME] jun. — Müllerei bleibt. [NAME]-Team: [NAME].');
    assert.equal(r.ersetzt, 4);
  });

  it('kurze Namen unter drei Zeichen werden übergangen, Sonderzeichen im Namen brechen nichts', () => {
    const r = namenErsetzen('Al kam mit Li. O. (Hans) half.', ['Al', 'Li', '(Hans)', 'O.']);
    assert.equal(r.text, 'Al kam mit Li. O. [NAME] half.');
  });

  it('Kürzel sind je Anfrage und erfundene werden verworfen', () => {
    const k = kuerzel(['cjob1', 'cjob2'], 'E');
    assert.equal(k.hin('cjob2'), 'E2');
    assert.equal(k.zurueck(' E1 '), 'cjob1');
    assert.equal(k.zurueck('E9'), undefined);
  });
});

describe('KI über HTTP', () => {
  let jars: Record<AccountName, string>;

  before(async () => {
    await requireServer();
    jars = await loginAll();
  });

  after(async () => {
    await testDbSchliessen();
  });

  it('Kundschaft und Mitarbeitende nutzen die KI-Werkzeuge nicht', async () => {
    for (const rolle of ['customer', 'employee'] as AccountName[]) {
      const r = await post('/api/ai/summarize', { text: 'Ein Text zum Zusammenfassen, lang genug.' }, { jar: jars[rolle] });
      assert.equal(r.status, 403, `${rolle}: ${r.status}`);
    }
  });

  it('ohne Anbieter: klare Ablehnung und kein Nutzungsprotokoll für eine Nutzung, die nicht stattfand', async (t) => {
    const db = testDb();
    const vorher = db ? await db.auditLog.count({ where: { entity: 'KiNutzung' } }) : 0;
    const r = await post('/api/ai/summarize', { text: 'Ein Text zum Zusammenfassen, lang genug für die Prüfung.' }, { jar: jars.admin });
    if (r.status === 200) return t.skip('Im Prüfbetrieb ist ein KI-Anbieter konfiguriert — dieser Fall prüft den Betrieb ohne.');
    assert.ok([502, 503].includes(r.status), `erwartet 502/503, kam ${r.status}`);
    if (db) assert.equal(await db.auditLog.count({ where: { entity: 'KiNutzung' } }), vorher);
  });
});
