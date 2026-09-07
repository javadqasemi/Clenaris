import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { call, get, post, requireServer, sleep } from '../helpers/client';
import { loginAs } from '../helpers/accounts';

/**
 * Der Leistungskatalog — und die Frage, ob eine Änderung ankommt.
 *
 * Die öffentlichen Seiten sind statisch erzeugt. Ohne `revalidatePath`
 * speichert die Verwaltung, sieht auf der Website nichts und hält das
 * Speichern für kaputt. Diese Prüfung ändert deshalb wirklich etwas, ruft die
 * öffentliche Seite ab und stellt den Ausgangszustand wieder her.
 *
 * Der Preis ist der zweite Punkt: Er wird auf dem Server berechnet, nie im
 * Browser. Ein geänderter Grundpreis muss in der Berechnung ankommen, sonst
 * nennt die Website einen Preis, den die Rechnung später nicht hält.
 */

interface Service {
  id: string;
  slug: string;
  name: string;
  shortDesc: string;
  basePrice: string | number;
  active: boolean;
}

describe('Katalogänderungen erreichen die Website', { concurrency: 1 }, async () => {
  await requireServer();
  const admin = await loginAs('admin');

  const services = await get<{ data: Service[] }>('/api/services', { jar: admin });
  const target = services.payload.data.find((service) => service.active) ?? services.payload.data[0];
  assert.ok(target, 'keine Leistung im Katalog — Datenbank befüllt?');

  const original = {
    name: target.name,
    shortDesc: target.shortDesc,
    basePrice: Number(target.basePrice),
  };
  const marker = `Prüfmarke ${Date.now()}`;

  after(async () => {
    await call('PATCH', `/api/services/${target.id}`, { jar: admin, body: original });
  });

  it('speichert eine Änderung an der Leistung', async () => {
    const response = await call('PATCH', `/api/services/${target.id}`, {
      jar: admin,
      body: { shortDesc: marker, basePrice: 123.45 },
    });
    assert.equal(response.status, 200, JSON.stringify(response.payload));

    // `revalidatePath` markiert nur; gebaut wird beim nächsten Aufruf.
    await sleep(500);
  });

  it('zeigt sie auf der Leistungsseite', async () => {
    const page = await get(`/leistungen/${target.slug}`);
    assert.equal(page.status, 200);
    assert.ok(
      page.text.includes(marker) || page.text.includes('123.45'),
      'weder Beschreibung noch Preis geändert — greift revalidatePath?',
    );
  });

  it('rechnet mit dem neuen Grundpreis', async () => {
    const estimate = await post<{ data: { lines: { key: string; amount: number }[] } }>(
      '/api/public/pricing/estimate',
      {
        serviceId: target.id,
        squareMeters: 80,
        propertyKind: 'APARTMENT',
        frequency: 'ONCE',
        extras: [],
        postalCode: '3000',
      },
    );
    assert.equal(estimate.status, 200);

    const baseFee = estimate.payload.data.lines.find(
      (line) => line.key === 'base-fee' || line.key === 'flat',
    );
    assert.ok(baseFee, 'keine Grundpauschale in der Herleitung');
    assert.equal(Number(baseFee.amount), 123.45);
  });

  it('lässt die Marke nach dem Zurücksetzen verschwinden', async () => {
    const restore = await call('PATCH', `/api/services/${target.id}`, {
      jar: admin,
      body: original,
    });
    assert.equal(restore.status, 200);

    await sleep(500);
    const page = await get(`/leistungen/${target.slug}`);
    assert.ok(!page.text.includes(marker));
  });
});

// ---------------------------------------------------------------------------

describe('Die Katalogpflege im Verwaltungsbereich', { concurrency: 1 }, async () => {
  await requireServer();
  const admin = await loginAs('admin');
  const manager = await loginAs('manager');
  const customer = await loginAs('customer');

  it('zeigt der Administration alle Register', async () => {
    const page = await get('/admin/einstellungen/leistungen', { jar: admin });
    assert.equal(page.status, 200);

    // Fehlt eines der sechs, ist ein ganzer Bereich unpflegbar geworden —
    // ohne dass irgendetwas einen Fehler meldet.
    for (const tab of [
      'Kategorien',
      'Leistungen',
      'Zusätze',
      'Preisregeln',
      'Steuersätze',
      'Gutscheine',
    ]) {
      assert.ok(page.text.includes(tab), `Register „${tab}" fehlt`);
    }
  });

  it('bietet der Administration das Bearbeiten an', async () => {
    const page = await get('/admin/einstellungen/leistungen', { jar: admin });
    assert.ok(
      page.text.includes('Leistung bearbeiten') || page.text.includes('>Leistung<'),
      'keine Bearbeitungsschaltfläche im HTML',
    );
  });

  it('zeigt der Betriebsleitung den Katalog ohne Bearbeitung', async () => {
    const page = await get('/admin/einstellungen/leistungen', { jar: manager });

    if (page.status === 200) {
      // Der Katalog ist für die Disposition nützlich zu sehen. Statt
      // ausgegrauter Schaltflächen — die suggerieren, es fehle nur ein Klick —
      // steht dort ein Satz, der die Lage benennt.
      assert.ok(!page.text.includes('bearbeiten'), 'Bearbeitungsschaltflächen sichtbar');
      assert.ok(
        page.text.includes('können ihn aber nicht ändern'),
        'der Hinweis auf den Lesemodus fehlt',
      );
    } else {
      assert.ok([307, 308, 404].includes(page.status), `HTTP ${page.status}`);
    }
  });

  it('lässt die Kundschaft nicht hinein', async () => {
    const page = await get('/admin/einstellungen/leistungen', { jar: customer });
    assert.ok([307, 308, 404].includes(page.status), `HTTP ${page.status}`);
  });
});
