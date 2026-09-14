import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { get, post, requireServer } from '../helpers/client';
import { loginAs } from '../helpers/accounts';

/**
 * Datenbereinigung — die Sperren, nicht das Löschen.
 *
 * Ein echter Lauf leerte die Entwicklungsdatenbank, auf der alle anderen
 * Prüfungen aufbauen. Geprüft wird deshalb alles davor: Wer darf die Seite
 * und den Endpunkt sehen, was die Vorschau liefert, und welche Eingaben der
 * Endpunkt zurückweist — falscher Bestätigungssatz, unbekannter Bereich,
 * Kundschaft ohne Finanzen. Jede dieser Sperren steht zwischen einem
 * Tippfehler und einem leeren Betrieb.
 */

describe('Datenbereinigung', { concurrency: 1 }, async () => {
  await requireServer();
  const superAdmin = await loginAs('super');
  const admin = await loginAs('admin');
  const manager = await loginAs('manager');

  it('existiert für die Administration nicht — Seite weg, Endpunkt 403', async () => {
    // Die Middleware leitet ohne das Recht auf die Startseite des Bereichs
    // um, bevor die Seite rendert; deren eigenes 404 ist die zweite Schicht.
    const page = await get('/admin/datenbereinigung', { jar: admin });
    assert.equal(page.status, 307, `HTTP ${page.status}`);
    assert.match(page.headers.get('location') ?? '', /\/admin$/);
    assert.equal((await get('/api/system/purge', { jar: admin })).status, 403);
    assert.equal((await get('/api/system/purge', { jar: manager })).status, 403);
    assert.equal((await get('/api/system/purge')).status, 401);
  });

  it('zeigt der Systemverantwortung die Seite mit dem Bestätigungssatz', async () => {
    const page = await get('/admin/datenbereinigung', { jar: superAdmin });
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('ALLES LÖSCHEN'), 'Bestätigungssatz fehlt');
    assert.ok(page.text.includes('Unumkehrbar'), 'Warnhinweis fehlt');
  });

  it('liefert eine Vorschau je Bereich mit Mengen', async () => {
    const response = await get<{
      data: { key: string; label: string; total: number; counts: { count: number }[] }[];
    }>('/api/system/purge', { jar: superAdmin });
    assert.equal(response.status, 200, response.text);

    const areas = response.payload.data;
    const keys = areas.map((area) => area.key);
    for (const expected of ['finanzen', 'auftraege', 'crm', 'kommunikation', 'website', 'fuehrung', 'personal']) {
      assert.ok(keys.includes(expected), `Bereich ${expected} fehlt in der Vorschau`);
    }
    // Die Demodaten enthalten Kundschaft und Rechnungen — eine Vorschau, die
    // dort Null zählt, zählt falsch (oder greift auf das falsche Modell zu).
    const crm = areas.find((area) => area.key === 'crm');
    assert.ok(crm && crm.total > 0, 'Kundschaft wird nicht gezählt');
    for (const area of areas) {
      for (const entry of area.counts) assert.ok(entry.count >= 0);
    }
  });

  it('weist einen falschen Bestätigungssatz zurück — ohne etwas zu löschen', async () => {
    const before = await get<{ data: { key: string; total: number }[] }>('/api/system/purge', {
      jar: superAdmin,
    });

    for (const bestaetigung of ['', 'alles löschen', 'ALLES LOESCHEN', 'ALLES LÖSCHEN!']) {
      const response = await post(
        '/api/system/purge',
        { bereiche: ['website'], bestaetigung, nummernkreiseZuruecksetzen: false },
        { jar: superAdmin },
      );
      assert.equal(response.status, 422, `«${bestaetigung}» durchgelassen: ${response.text}`);
    }

    const after = await get<{ data: { key: string; total: number }[] }>('/api/system/purge', {
      jar: superAdmin,
    });
    assert.deepEqual(after.payload.data.map((a) => a.total), before.payload.data.map((a) => a.total));
  });

  it('weist unbekannte und leere Bereichslisten zurück', async () => {
    const unknown = await post(
      '/api/system/purge',
      { bereiche: ['alles'], bestaetigung: 'ALLES LÖSCHEN' },
      { jar: superAdmin },
    );
    assert.equal(unknown.status, 422);

    const empty = await post(
      '/api/system/purge',
      { bereiche: [], bestaetigung: 'ALLES LÖSCHEN' },
      { jar: superAdmin },
    );
    assert.equal(empty.status, 422);
  });

  it('lässt die Kundschaft nicht ohne die Finanzen löschen', async () => {
    const response = await post<{ error: { message: string } }>(
      '/api/system/purge',
      { bereiche: ['crm'], bestaetigung: 'ALLES LÖSCHEN' },
      { jar: superAdmin },
    );
    assert.equal(response.status, 422, response.text);
    assert.match(response.payload.error.message, /Finanzen/);
  });

  it('nimmt der Administration auch mit richtigem Satz nichts ab', async () => {
    const response = await post(
      '/api/system/purge',
      { bereiche: ['website'], bestaetigung: 'ALLES LÖSCHEN' },
      { jar: admin },
    );
    assert.equal(response.status, 403);
  });
});
