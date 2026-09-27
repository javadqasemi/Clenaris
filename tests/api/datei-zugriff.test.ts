import { strict as assert } from 'node:assert';
import { before, describe, it } from 'node:test';

import { BASE_URL, data, get, post } from '../helpers/client.js';
import { ACCOUNTS, loginAll } from '../helpers/accounts.js';
import { testDb } from '../helpers/testdb.js';

/**
 * Wer welche Datei abrufen darf (Gate 2).
 *
 * **Der Befund, den diese Reihe absichert.** `GET /api/files/blob/:id` gab
 * bis Gate 2 jede Datei heraus, deren Kennung jemand nannte — ohne Sitzung,
 * ohne Kontingent, mit `Cache-Control: public, immutable`. Die Begründung im
 * Quelltext lautete, die `cuid` sei „nicht erratbar". Nachgemessen sind von
 * 25 Zeichen acht der Erstellungszeitpunkt, vier ein Zähler und vier ein pro
 * Prozess konstanter Fingerabdruck; zufällig bleiben rund 41 Bit. Über
 * diesen Weg lagen Lebensläufe und Personaldokumente.
 *
 * Geprüft wird deshalb der Satz, der jetzt gelten soll: **Die Kennung allein
 * öffnet nichts.**
 */

type Zugaenge = Awaited<ReturnType<typeof loginAll>>;
let jars: Zugaenge;

function mitKopf(kopf: number[] | string, fuellung = 64): Buffer {
  const start = typeof kopf === 'string' ? Buffer.from(kopf, 'latin1') : Buffer.from(kopf);
  return Buffer.concat([start, Buffer.alloc(fuellung, 0x20)]);
}
const PNG = mitKopf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = mitKopf('%PDF-1.7\n');

interface Ticket {
  ticketId: string;
  signedUrl: string;
}
interface Abschluss {
  id: string;
  url: string;
}

async function hochladen(opts: {
  jar?: string;
  profile: string;
  filename: string;
  mimeType: string;
  bytes: Buffer;
}): Promise<{ url: string; ticketId: string; id: string }> {
  const ticket = await post<{ data: Ticket }>(
    '/api/files/upload-url',
    {
      profile: opts.profile,
      filename: opts.filename,
      mimeType: opts.mimeType,
      sizeBytes: opts.bytes.byteLength,
    },
    { jar: opts.jar },
  );
  assert.equal(ticket.status, 201, `Ticket: ${ticket.text}`);

  const ziel = data(ticket);
  // Nur den Pfad: `absoluteUrl` baut die Adresse aus der konfigurierten
  // Basis, nicht aus dem Port, gegen den diese Reihe fährt.
  const pfad = `${BASE_URL}${new URL(ziel.signedUrl, BASE_URL).pathname}`;
  const upload = await fetch(pfad, {
    method: 'PUT',
    headers: { 'Content-Type': opts.mimeType },
    body: new Uint8Array(opts.bytes),
  });
  assert.equal(upload.status, 200, 'Upload fehlgeschlagen');

  const abschluss = await post<{ data: Abschluss }>(
    '/api/files/finalize',
    { ticketId: ziel.ticketId, filename: opts.filename },
    { jar: opts.jar },
  );
  assert.equal(abschluss.status, 201, `Abschluss: ${abschluss.text}`);

  return { url: data(abschluss).url, ticketId: ziel.ticketId, id: data(abschluss).id };
}

before(async () => {
  jars = await loginAll();
});

describe('Öffentliche Assets bleiben öffentlich', () => {
  it('ein Galeriebild ist ohne Anmeldung erreichbar', async () => {
    const datei = await hochladen({
      jar: jars.admin,
      profile: 'gallery',
      filename: 'galerie.png',
      mimeType: 'image/png',
      bytes: PNG,
    });

    const antwort = await get(datei.url);
    assert.equal(antwort.status, 200, 'ein öffentliches Bild war nicht erreichbar');
    assert.equal(antwort.headers.get('content-type'), 'image/png');
    assert.match(antwort.headers.get('cache-control') ?? '', /public/);
    assert.equal(antwort.headers.get('x-content-type-options'), 'nosniff');
  });

  it('das Profilbild einer Mitarbeiterin erscheint auf der Website und ist öffentlich', async () => {
    const datei = await hochladen({
      jar: jars.employee,
      profile: 'avatar',
      filename: 'profilbild.png',
      mimeType: 'image/png',
      bytes: PNG,
    });

    const antwort = await get(datei.url);
    assert.equal(antwort.status, 200);
    assert.match(antwort.headers.get('cache-control') ?? '', /public/);
  });
});

describe('Private Dateien öffnen sich nicht durch Kenntnis der Kennung', () => {
  it('ein Dokument ist ohne Anmeldung nicht erreichbar', async () => {
    const datei = await hochladen({
      jar: jars.admin,
      profile: 'document',
      filename: 'vertrag.pdf',
      mimeType: 'application/pdf',
      bytes: PDF,
    });

    const antwort = await get(datei.url);
    assert.equal(antwort.status, 404, 'ein privates Dokument war ohne Anmeldung abrufbar');
  });

  it('die Kennung der Ablage allein genügt ebenso wenig', async () => {
    const datei = await hochladen({
      jar: jars.admin,
      profile: 'document',
      filename: 'vertrag2.pdf',
      mimeType: 'application/pdf',
      bytes: PDF,
    });

    // Genau der Angriff aus dem Befund: Die Kennung ist bekannt, sonst nichts.
    const antwort = await get(`/api/files/blob/${datei.ticketId}`);
    assert.equal(antwort.status, 404);
  });

  it('die berechtigte Rolle bekommt dieselbe Datei', async () => {
    const datei = await hochladen({
      jar: jars.admin,
      profile: 'document',
      filename: 'vertrag3.pdf',
      mimeType: 'application/pdf',
      bytes: PDF,
    });

    const antwort = await get(datei.url, { jar: jars.admin });
    assert.equal(antwort.status, 200, 'die berechtigte Rolle kam nicht an die Datei');
    assert.equal(antwort.headers.get('content-type'), 'application/pdf');
  });

  it('Kundschaft kommt nicht an ein internes Dokument', async () => {
    const datei = await hochladen({
      jar: jars.admin,
      profile: 'document',
      filename: 'intern.pdf',
      mimeType: 'application/pdf',
      bytes: PDF,
    });

    const antwort = await get(datei.url, { jar: jars.customer });
    assert.equal(antwort.status, 404, 'Kundschaft sah ein internes Dokument');
  });

  it('eine private Datei wird nie öffentlich zwischengespeichert', async () => {
    const datei = await hochladen({
      jar: jars.admin,
      profile: 'document',
      filename: 'nichtcachen.pdf',
      mimeType: 'application/pdf',
      bytes: PDF,
    });

    const antwort = await get(datei.url, { jar: jars.admin });
    const cache = antwort.headers.get('cache-control') ?? '';
    assert.doesNotMatch(cache, /public/, `private Datei mit „${cache}"`);
    assert.doesNotMatch(cache, /immutable/, `private Datei mit „${cache}"`);
    assert.match(cache, /private|no-store/);
  });
});

describe('Kopfzeilen der Auslieferung', () => {
  it('ein PDF darf im Fenster angezeigt werden', async () => {
    const datei = await hochladen({
      jar: jars.admin,
      profile: 'document',
      filename: 'ansehen.pdf',
      mimeType: 'application/pdf',
      bytes: PDF,
    });

    const antwort = await get(datei.url, { jar: jars.admin });
    assert.match(antwort.headers.get('content-disposition') ?? '', /^inline/);
    assert.equal(antwort.headers.get('x-content-type-options'), 'nosniff');
  });

  it('ein Dateiname kann keine zweite Kopfzeile einschleusen', async () => {
    const datei = await hochladen({
      jar: jars.admin,
      profile: 'document',
      filename: 'bös"\r\nX-Eingeschleust: ja.pdf',
      mimeType: 'application/pdf',
      bytes: PDF,
    });

    const antwort = await get(datei.url, { jar: jars.admin });
    assert.equal(antwort.headers.get('x-eingeschleust'), null, 'Kopfzeile eingeschleust');
    const disposition = antwort.headers.get('content-disposition') ?? '';
    assert.doesNotMatch(disposition, /[\r\n]/);
  });
});

/**
 * Objektunterlagen folgen dem Objekt, nicht der Berechtigung (2026-09-27).
 *
 * `property:read` hält auch die Kundschaft — für die eigenen Objekte. Die
 * Dateiroute liess damit jede Kundschaft die Objektunterlagen jeder anderen
 * Kundschaft derselben Organisation lesen, sobald sie eine Kennung kannte
 * (Grundrisse, Schlüsselfotos). Jetzt gilt dieselbe Regel wie für das Objekt:
 * Büro alles, Kundschaft die eigenen, Personal die seiner Einsätze.
 */
describe('Objektunterlagen: nur wer das Objekt sehen darf', () => {
  async function objektdatei(propertyId: string, name: string) {
    const datei = await hochladen({ jar: jars.admin, profile: 'document', filename: name, mimeType: 'application/pdf', bytes: PDF });
    await testDb()!.fileAsset.update({ where: { id: datei.id }, data: { scope: 'PROPERTY', propertyId } });
    return datei;
  }

  it('die Kundschaft liest die Unterlagen des eigenen Objekts, nicht die eines fremden', async (t) => {
    const db = testDb();
    if (!db) return t.skip('keine Testdatenbank');
    const eigenesKonto = await db.user.findUniqueOrThrow({ where: { email: ACCOUNTS.customer.email }, select: { customer: { select: { id: true } } } });
    const kundeId = eigenesKonto.customer!.id;
    const eigenes = await db.property.findFirst({ where: { customerId: kundeId, deletedAt: null }, select: { id: true } });
    const fremdes = await db.property.findFirst({ where: { customerId: { not: kundeId }, deletedAt: null }, select: { id: true } });
    assert.ok(fremdes, 'der Demobestand hat ein Objekt einer anderen Kundschaft');

    const fremd = await objektdatei(fremdes.id, 'fremdes-objekt.pdf');
    assert.equal((await get(fremd.url, { jar: jars.customer })).status, 404, 'fremde Objektunterlage ausgeliefert');
    assert.equal((await get(fremd.url, { jar: jars.admin })).status, 200, 'das Büro sieht sie');

    if (eigenes) {
      const eigen = await objektdatei(eigenes.id, 'eigenes-objekt.pdf');
      assert.equal((await get(eigen.url, { jar: jars.customer })).status, 200, 'die eigene Objektunterlage bleibt lesbar');
    }
  });
});

describe('Eine unbekannte Kennung verrät nichts', () => {
  it('eine erfundene Kennung ergibt 404, nicht 403', async () => {
    const antwort = await get('/api/files/blob/cmu0000000000000000000000', { jar: jars.admin });
    assert.equal(
      antwort.status,
      404,
      'ein anderer Status als 404 macht die Route zum Orakel für vorhandene Kennungen',
    );
  });

  it('eine fremde Datei antwortet genauso wie eine nicht vorhandene', async () => {
    const datei = await hochladen({
      jar: jars.admin,
      profile: 'document',
      filename: 'fremd.pdf',
      mimeType: 'application/pdf',
      bytes: PDF,
    });

    const fremd = await get(datei.url, { jar: jars.customer });
    const gibtEsNicht = await get('/api/files/blob/cmu0000000000000000000001', {
      jar: jars.customer,
    });

    assert.equal(fremd.status, gibtEsNicht.status);
  });
});
