import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { post, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { testDb, testDbSchliessen } from '../helpers/testdb';

/**
 * KI-Textassistent über HTTP (2026-09-28) — `POST /api/ai/text-assist`.
 *
 * Die Regeln selbst (Sperre, Markierung, Platzhalter, Auswertung) prüft
 * `text-assist-nutzlast.test.ts` direkt. Hier geht es um den Weg durch die
 * Route: Anmeldung, Recht, Validierung, die Sperre **vor** dem Anbieter und
 * dass das Protokoll nur Metadaten trägt.
 *
 * Die Prüfreihe läuft üblicherweise ohne `ANTHROPIC_API_KEY`. Die Fälle sind
 * so gebaut, dass sie in beiden Betriebsarten etwas beweisen: Die Sperre
 * greift vor der Frage nach dem Anbieter (422 mit und ohne Schlüssel); ein
 * sauberer Text ergibt ohne Anbieter 503 mit klarer Meldung und keinen
 * Protokolleintrag, mit Anbieter 200 und einen Eintrag ohne Text.
 */

const SAUBER = 'Wir reinigen Ihre Wohnung in Bern gruendlich und zuverlässig, auch kurzfristig.';

describe('KI-Textassistent über HTTP', () => {
  let jars: Record<AccountName, string>;

  before(async () => {
    await requireServer();
    jars = await loginAll();
  });

  after(async () => {
    await testDbSchliessen();
  });

  const nutzungen = async () => {
    const db = testDb();
    return db ? db.auditLog.count({ where: { entity: 'KiNutzung' } }) : null;
  };

  it('ohne Anmeldung 401', async () => {
    const r = await post('/api/ai/text-assist', { aktion: 'grammatik', kontext: 'cms-text', text: SAUBER });
    assert.equal(r.status, 401);
  });

  it('Mitarbeitende und Kundschaft 403 — der Assistent gehört zu `ai:use`', async () => {
    for (const rolle of ['employee', 'customer'] as AccountName[]) {
      const r = await post('/api/ai/text-assist', { aktion: 'grammatik', kontext: 'cms-text', text: SAUBER }, { jar: jars[rolle] });
      assert.equal(r.status, 403, `${rolle}: ${r.status}`);
    }
  });

  it('Betriebsleitung darf ihn nutzen (kein 403)', async () => {
    const r = await post('/api/ai/text-assist', { aktion: 'rechtschreibung', kontext: 'quote-text', text: SAUBER }, { jar: jars.manager });
    assert.notEqual(r.status, 403, `manager: ${r.status}`);
    assert.ok([200, 503].includes(r.status), `erwartet 200 oder 503, kam ${r.status}`);
  });

  it('zu langer Text, unbekannte Aktion, unbekannte Feldart und unpassende Kombination: 422', async () => {
    const faelle = [
      { aktion: 'grammatik', kontext: 'cms-text', text: 'x'.repeat(6001) },
      { aktion: 'uebersetzen', kontext: 'cms-text', text: SAUBER },
      { aktion: 'grammatik', kontext: 'lohnabrechnung', text: SAUBER },
      { aktion: 'seo', kontext: 'quote-text', text: SAUBER },
      { aktion: 'grammatik', kontext: 'cms-text', text: '' },
    ];
    for (const body of faelle) {
      const r = await post('/api/ai/text-assist', body, { jar: jars.admin });
      assert.equal(r.status, 422, `${JSON.stringify(body).slice(0, 80)}: ${r.status}`);
    }
  });

  it('AHV-Nummer, IBAN und Passwort: 422 mit Erklärung, nichts gesendet, kein Nutzungsprotokoll', async () => {
    const vorher = await nutzungen();
    const faelle: [string, string][] = [
      ['AHV-Nummer', 'Die Mitarbeiterin mit AHV 756.1234.5678.97 reinigt ab Montag.'],
      ['IBAN', 'Bitte überweisen Sie auf CH93 0076 2011 6238 5295 7, danke.'],
      ['Passwort', 'Das WLAN-Passwort: Sommer2026! hängt beim Empfang.'],
    ];
    for (const [kategorie, text] of faelle) {
      const r = await post<{ error: { message: string } }>(
        '/api/ai/text-assist',
        { aktion: 'professioneller', kontext: 'cms-text', text },
        { jar: jars.admin },
      );
      assert.equal(r.status, 422, `${kategorie}: ${r.status}`);
      const meldung = r.payload?.error?.message ?? '';
      assert.match(meldung, /nicht an die KI gesendet/, meldung);
      // Die Meldung nennt die Art, nie den Wert.
      for (const wert of ['756.1234', 'CH93', 'Sommer2026']) assert.ok(!meldung.includes(wert), meldung);
    }
    if (vorher !== null) assert.equal(await nutzungen(), vorher, 'Eine abgewiesene Anfrage ist keine Nutzung');
  });

  it('ohne Anbieter 503 mit klarer Meldung — mit Anbieter ein Protokolleintrag nur mit Metadaten', async (t) => {
    const db = testDb();
    const vorher = await nutzungen();
    const r = await post<{ data?: { format: string; text?: string }; error?: { message: string } }>(
      '/api/ai/text-assist',
      { aktion: 'grammatik', kontext: 'cms-text', text: SAUBER },
      { jar: jars.admin },
    );

    if (r.status === 503) {
      assert.match(r.payload?.error?.message ?? '', /nicht eingerichtet/);
      if (vorher !== null) assert.equal(await nutzungen(), vorher, 'keine Nutzung ohne Anbieter');
      return;
    }

    assert.equal(r.status, 200, `erwartet 200 oder 503, kam ${r.status}`);
    assert.equal(r.payload?.data?.format, 'text');
    if (!db) return t.skip('Ohne Testdatenbank-Zugang lässt sich das Protokoll nicht einsehen.');
    const eintrag = await db.auditLog.findFirst({ where: { entity: 'KiNutzung' }, orderBy: { createdAt: 'desc' } });
    assert.ok(eintrag, 'Nutzung protokolliert');
    const gespeichert = JSON.stringify(eintrag);
    assert.ok(gespeichert.includes('Textassistent'), gespeichert);
    assert.ok(gespeichert.includes('"aktion":"grammatik"') && gespeichert.includes('"kontext":"cms-text"'), gespeichert);
    // Weder Eingabe noch Ergebnis — auch nicht in Teilen.
    assert.ok(!gespeichert.includes('gruendlich'), 'Eingabetext im Protokoll');
    if (r.payload?.data?.text) assert.ok(!gespeichert.includes(r.payload.data.text.slice(0, 20)), 'Ergebnis im Protokoll');
  });
});
