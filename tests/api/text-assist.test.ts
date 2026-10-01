import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { post, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { rateLimitResetAvailable, resetRateLimits } from '../helpers/rate-limit';
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
 *
 * Dazu seit 2026-09-30 das KI-Kontingent selbst: 30 Aufrufe je Konto und
 * Stunde, gemeinsam über alle KI-Routen.
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

  /*
    Das KI-Kontingent (2026-09-30): `aiGenerate`, 30 Aufrufe je Stunde,
    gezählt je Konto (Schlüssel ist die Kennung der Person, nicht die IP) und
    gemeinsam für alle KI-Routen — wer den Textassistenten ausgeschöpft hat,
    kann nicht auf die Zusammenfassung oder die Übersetzung ausweichen. Das
    ist die Bremse für die Kosten beim Anbieter; bis hier war sie nur als
    Zeile in `rate-limit.ts` belegt.

    **Ohne einen einzigen Aufruf beim Anbieter.** Die Fabrik zählt vor der
    Prüfung des Körpers (`defineRoute`: Rechte → Kontingent → Schema). Ein
    ungültiger Körper zählt also mit und endet mit 422, bevor der Handler
    läuft — die 30 Aufrufe kosten nichts, mit und ohne `ANTHROPIC_API_KEY`.

    `retries: 0`, sonst sässe der Klient den 429 aus. Der Zähler wird vorher
    geleert — die Fälle oben haben das Konto schon belastet — und nachher
    wieder, damit keine spätere Datei eine Stunde lang gesperrt ist. Ohne
    rücksetzbaren Zähler (Prüfserver mit `CLENARIS_TEST_CACHE_DIR`, ohne
    Redis) scheitert der Fall mit dem Grund, statt still übersprungen zu
    werden: „nach 30 Aufrufen" ist nur mit leerem Zähler prüfbar.
  */
  it('nach 30 Aufrufen in der Stunde: 429 mit Retry-After — je Konto, über alle KI-Routen', async () => {
    const limits = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'rate-limit.ts'), 'utf8');
    assert.match(limits, /aiGenerate:\s*\{\s*limit:\s*30,\s*windowSeconds:\s*3600\s*\}/, 'aiGenerate ist nicht mehr 30 je Stunde');
    for (const route of ['text-assist', 'summarize', 'translate']) {
      const quelle = readFileSync(join(__dirname, '..', '..', 'src', 'app', 'api', 'ai', route, 'route.ts'), 'utf8');
      assert.match(quelle, /rateLimit:\s*'aiGenerate'/, `/api/ai/${route} zählt nicht auf aiGenerate`);
    }

    assert.ok(rateLimitResetAvailable(), 'Der Zähler des Prüfservers ist nicht rücksetzbar (CLENARIS_TEST_CACHE_DIR, ohne REDIS_URL).');
    resetRateLimits();
    try {
      // 30 Aufrufe, abwechselnd auf zwei Routen: Keine allein erreicht das
      // Kontingent — gesperrt wird nur, wenn beide auf denselben Zähler gehen.
      for (let i = 0; i < 30; i++) {
        const weg = i % 2 === 0 ? '/api/ai/text-assist' : '/api/ai/summarize';
        const r = await post(weg, {}, { jar: jars.admin, retries: 0 });
        assert.equal(r.status, 422, `Aufruf ${i + 1} (${weg}): ${r.status} — gesperrt vor dem 31.?`);
      }

      const gesperrt = await post<{ error?: { code?: string } }>('/api/ai/text-assist', {}, { jar: jars.admin, retries: 0 });
      assert.equal(gesperrt.status, 429, `der 31. Aufruf: ${gesperrt.status}`);
      assert.equal(gesperrt.payload?.error?.code, 'RATE_LIMITED');
      const warten = Number(gesperrt.headers.get('retry-after'));
      assert.ok(Number.isInteger(warten) && warten >= 1 && warten <= 3600, `Retry-After: ${gesperrt.headers.get('retry-after')}`);

      // Ausweichen auf eine dritte KI-Route hilft nicht — derselbe Zähler.
      const uebersetzen = await post('/api/ai/translate', {}, { jar: jars.admin, retries: 0 });
      assert.equal(uebersetzen.status, 429, `/api/ai/translate: ${uebersetzen.status}`);

      // Je Konto: Die Betriebsleitung ist vom ausgeschöpften Kontingent der
      // Verwaltung nicht betroffen (422 — ihr Aufruf kommt bis zur Prüfung).
      const andere = await post('/api/ai/text-assist', {}, { jar: jars.manager, retries: 0 });
      assert.equal(andere.status, 422, `Betriebsleitung: ${andere.status}`);
    } finally {
      resetRateLimits();
    }
  });
});
