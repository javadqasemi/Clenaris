import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { BASE_URL, data, get, post } from '../helpers/client.js';
import { loginAll } from '../helpers/accounts.js';

/**
 * Byteprüfung, Prüfsumme und Abschluss von Uploads (Gate 2).
 *
 * **Was hier geprüft wird.** Bis Gate 2 nahm die Anwendung Dateien allein
 * nach dem entgegen, was der Client über sie behauptete: `mimeType` und
 * `sizeBytes` kamen aus dem Formular, `path`, `url`, `scope` und `isPublic`
 * standen frei im Körper von `POST /api/media`. Kein Byte wurde je angesehen.
 * Diese Reihe prüft, dass jeder dieser Wege jetzt zu ist.
 *
 * **Warum die Musterdateien nur aus Kopf und Füllung bestehen.** Geprüft
 * wird die Signaturerkennung, nicht ein Bilddecoder. Ein echtes JPEG würde
 * denselben Pfad nehmen und nichts zusätzlich beweisen — es machte die
 * Prüfungen nur unleserlich. Wo es auf die *Gleichheit* von Bytes ankommt
 * (Prüfsumme), steht der erwartete Hash im Test.
 *
 * Läuft gegen die eingebaute Rückfallebene. Ist Supabase eingerichtet,
 * übernimmt derselbe Abschluss mit demselben Ergebnis — nur dass der Server
 * die Bytes dort erst zurückladen muss.
 */

type Zugaenge = Awaited<ReturnType<typeof loginAll>>;
let jars: Zugaenge;

/** Ein Puffer mit der gewünschten Signatur und harmloser Füllung dahinter. */
function mitKopf(kopf: number[] | string, fuellung = 64): Buffer {
  const start = typeof kopf === 'string' ? Buffer.from(kopf, 'latin1') : Buffer.from(kopf);
  return Buffer.concat([start, Buffer.alloc(fuellung, 0x20)]);
}

const PNG = mitKopf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = mitKopf([0xff, 0xd8, 0xff, 0xe0]);
const PDF = mitKopf('%PDF-1.7\n');
const GIF = mitKopf('GIF89a');
const HTML = Buffer.from('<!doctype html><script>alert(1)</script>', 'latin1');
const ZUFALL = Buffer.from([0x17, 0x42, 0x99, 0x03, 0xab, 0xcd, 0xef, 0x11, 0x22, 0x33]);

/** WebP ist `RIFF` … `WEBP` — die Marke sitzt erst ab Byte 8. */
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x40, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'latin1'),
  Buffer.alloc(48, 0x20),
]);

interface Ticket {
  ticketId: string;
  signedUrl: string;
  path: string;
}
interface Abschluss {
  id: string;
  url: string;
  checksum: string;
  sizeBytes: number;
  mimeType: string;
}

async function ticketHolen(opts: {
  jar?: string;
  profile: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}) {
  return post<{ data: Ticket }>(
    '/api/files/upload-url',
    {
      profile: opts.profile,
      filename: opts.filename,
      mimeType: opts.mimeType,
      sizeBytes: opts.sizeBytes,
    },
    { jar: opts.jar },
  );
}

/**
 * Rohe Bytes an die Upload-Adresse schreiben — nicht durch den JSON-Klienten.
 *
 * Aus der Adresse wird nur der Pfad übernommen: `absoluteUrl` baut sie aus
 * der konfigurierten Basisadresse der Anwendung, und die zeigt nicht
 * zwangsläufig auf den Port, gegen den diese Reihe fährt.
 */
async function bytesSchreiben(signedUrl: string, bytes: Buffer, mimeType: string) {
  const pfad = `${BASE_URL}${new URL(signedUrl, BASE_URL).pathname}`;
  const antwort = await fetch(pfad, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    body: new Uint8Array(bytes),
  });
  return { status: antwort.status, text: await antwort.text() };
}

/** Der ganze Weg: Ticket, Bytes, Abschluss. */
async function hochladen(opts: {
  jar?: string;
  profile: string;
  filename: string;
  mimeType: string;
  bytes: Buffer;
  /** Abweichender Typ beim Anmelden — für die Fälschungsfälle. */
  angemeldeterTyp?: string;
}) {
  const angemeldet = opts.angemeldeterTyp ?? opts.mimeType;
  const ticket = await ticketHolen({
    jar: opts.jar,
    profile: opts.profile,
    filename: opts.filename,
    mimeType: angemeldet,
    sizeBytes: opts.bytes.byteLength,
  });
  if (ticket.status !== 201) return { schritt: 'ticket' as const, ticket, upload: null, abschluss: null };

  const upload = await bytesSchreiben(data(ticket).signedUrl, opts.bytes, opts.mimeType);
  const abschluss = await post<{ data: Abschluss }>(
    '/api/files/finalize',
    { ticketId: data(ticket).ticketId, filename: opts.filename },
    { jar: opts.jar },
  );
  return { schritt: 'fertig' as const, ticket, upload, abschluss };
}

before(async () => {
  jars = await loginAll();
});

describe('Byteprüfung: erlaubte Formate', () => {
  const faelle: Array<[string, Buffer, string, string]> = [
    ['PNG', PNG, 'image/png', 'gallery'],
    ['JPEG', JPEG, 'image/jpeg', 'gallery'],
    ['WebP', WEBP, 'image/webp', 'gallery'],
    ['PDF', PDF, 'application/pdf', 'document'],
  ];

  for (const [name, bytes, mimeType, profile] of faelle) {
    it(`${name} wird angenommen und bekommt eine Prüfsumme`, async () => {
      const lauf = await hochladen({
        jar: jars.admin,
        profile,
        filename: `pruefung.${name.toLowerCase()}`,
        mimeType,
        bytes,
      });

      assert.equal(lauf.upload?.status, 200, `Upload: ${lauf.upload?.text}`);
      assert.equal(lauf.abschluss?.status, 201, `Abschluss: ${lauf.abschluss?.text}`);

      const fertig = data(lauf.abschluss!);
      assert.match(fertig.checksum, /^[0-9a-f]{64}$/, 'SHA-256 als 64 Zeichen Kleinschrift');
      assert.equal(fertig.mimeType, mimeType);
      assert.equal(fertig.sizeBytes, bytes.byteLength, 'die tatsächliche Grösse');
    });
  }

  it('dieselben Bytes ergeben dieselbe Prüfsumme', async () => {
    const a = await hochladen({
      jar: jars.admin,
      profile: 'gallery',
      filename: 'gleich-a.png',
      mimeType: 'image/png',
      bytes: PNG,
    });
    const b = await hochladen({
      jar: jars.admin,
      profile: 'gallery',
      filename: 'gleich-b.png',
      mimeType: 'image/png',
      bytes: PNG,
    });

    assert.equal(data(a.abschluss!).checksum, data(b.abschluss!).checksum);
  });

  it('ein Byte Unterschied ergibt eine andere Prüfsumme', async () => {
    const anders = Buffer.concat([PNG]);
    anders[anders.length - 1] = 0x21;

    const a = await hochladen({
      jar: jars.admin,
      profile: 'gallery',
      filename: 'a.png',
      mimeType: 'image/png',
      bytes: PNG,
    });
    const b = await hochladen({
      jar: jars.admin,
      profile: 'gallery',
      filename: 'b.png',
      mimeType: 'image/png',
      bytes: anders,
    });

    assert.notEqual(data(a.abschluss!).checksum, data(b.abschluss!).checksum);
  });
});

describe('Byteprüfung: der angemeldete Typ muss stimmen', () => {
  const faelschungen: Array<[string, Buffer, string, string]> = [
    ['HTML als PDF', HTML, 'application/pdf', 'document'],
    ['JPEG als PDF', JPEG, 'application/pdf', 'document'],
    ['PDF als JPEG', PDF, 'image/jpeg', 'gallery'],
    ['GIF als PNG', GIF, 'image/png', 'gallery'],
    ['Zufallsbytes als PNG', ZUFALL, 'image/png', 'gallery'],
  ];

  for (const [name, bytes, angemeldet, profile] of faelschungen) {
    it(`${name} wird abgelehnt`, async () => {
      const lauf = await hochladen({
        jar: jars.admin,
        profile,
        filename: 'faelschung.dat',
        mimeType: angemeldet,
        bytes,
        angemeldeterTyp: angemeldet,
      });

      /**
       * Abgelehnt werden darf an beiden Stellen: Die Rückfallebene prüft
       * schon beim Empfang, damit nichts Ungeprüftes in der Datenbank
       * landet; der Abschluss prüft in jedem Fall. Gescheitert sein muss es
       * — dass es *irgendwo* durchgeht, wäre der Befund.
       */
      const abgelehnt =
        lauf.upload!.status >= 400 || (lauf.abschluss?.status ?? 500) >= 400;
      assert.ok(
        abgelehnt,
        `weder Upload (${lauf.upload?.status}) noch Abschluss (${lauf.abschluss?.status}) hat abgelehnt`,
      );
    });
  }

  it('eine leere Datei wird abgelehnt', async () => {
    const ticket = await ticketHolen({
      jar: jars.admin,
      profile: 'gallery',
      filename: 'leer.png',
      mimeType: 'image/png',
      sizeBytes: 1,
    });
    const upload = await bytesSchreiben(data(ticket).signedUrl, Buffer.alloc(0), 'image/png');
    assert.ok(upload.status >= 400, 'leere Übertragung angenommen');
  });

  it('GIF ist in keinem Profil erlaubt und scheitert schon am Ticket', async () => {
    const ticket = await ticketHolen({
      jar: jars.admin,
      profile: 'gallery',
      filename: 'animation.gif',
      mimeType: 'image/gif',
      sizeBytes: GIF.byteLength,
    });
    assert.equal(ticket.status, 400, 'GIF wurde neu zugelassen');
  });
});

describe('Der Abschluss ist die Grenze', () => {
  it('ohne Abschluss entsteht kein Asset und die Datei bleibt verschlossen', async () => {
    const ticket = await ticketHolen({
      jar: jars.admin,
      profile: 'gallery',
      filename: 'unfertig.png',
      mimeType: 'image/png',
      sizeBytes: PNG.byteLength,
    });
    const upload = await bytesSchreiben(data(ticket).signedUrl, PNG, 'image/png');
    assert.equal(upload.status, 200);

    // Die Bytes liegen jetzt da — abrufbar sind sie trotzdem nicht.
    const abruf = await get(`/api/files/blob/${data(ticket).ticketId}`, { jar: jars.admin });
    assert.equal(abruf.status, 404, 'eine nicht abgeschlossene Datei war abrufbar');
  });

  it('ein zweiter Abschluss liefert dasselbe Asset, kein zweites', async () => {
    const ticket = await ticketHolen({
      jar: jars.admin,
      profile: 'gallery',
      filename: 'zweimal.png',
      mimeType: 'image/png',
      sizeBytes: PNG.byteLength,
    });
    await bytesSchreiben(data(ticket).signedUrl, PNG, 'image/png');

    const koerper = { ticketId: data(ticket).ticketId, filename: 'zweimal.png' };
    const erst = await post<{ data: Abschluss }>('/api/files/finalize', koerper, { jar: jars.admin });
    const zweit = await post<{ data: Abschluss }>('/api/files/finalize', koerper, { jar: jars.admin });

    assert.equal(erst.status, 201);
    assert.equal(zweit.status, 201);
    assert.equal(data(erst).id, data(zweit).id, 'ein Wiederholungsversuch erzeugte ein zweites Asset');
  });

  it('zwei gleichzeitige Abschlüsse ergeben genau ein Asset', async () => {
    const ticket = await ticketHolen({
      jar: jars.admin,
      profile: 'gallery',
      filename: 'wettlauf.png',
      mimeType: 'image/png',
      sizeBytes: PNG.byteLength,
    });
    await bytesSchreiben(data(ticket).signedUrl, PNG, 'image/png');

    const koerper = { ticketId: data(ticket).ticketId, filename: 'wettlauf.png' };
    const ergebnisse = await Promise.all([
      post<{ data: Abschluss }>('/api/files/finalize', koerper, { jar: jars.admin }),
      post<{ data: Abschluss }>('/api/files/finalize', koerper, { jar: jars.admin }),
      post<{ data: Abschluss }>('/api/files/finalize', koerper, { jar: jars.admin }),
    ]);

    const kennungen = new Set(
      ergebnisse.filter((r) => r.status === 201).map((r) => data(r).id),
    );
    assert.equal(kennungen.size, 1, `es entstanden ${kennungen.size} Assets`);
  });

  /**
   * Einmal beschreiben heisst einmal — auch gleichzeitig (2026-09-27).
   *
   * Der Speicher prüfte „noch leer?" und schrieb danach, bedingungslos. Zwei
   * gleichzeitige Übertragungen auf dasselbe Ticket lasen beide „leer": Die
   * kleine landete zuerst, wurde abgeschlossen, geprüft und für sauber
   * befunden — und dann überschrieb die grosse, langsamere die Bytes. Die
   * Prüfsumme gehörte danach zu Bytes, die nicht mehr da waren, und was
   * ausgeliefert wurde, hatte nie ein Prüfer gesehen. Jetzt ist das
   * Beschreiben ein bedingter Übergang: genau eine Übertragung gelingt, und
   * die ausgelieferten Bytes sind die geprüften.
   */
  it('gleichzeitige Übertragungen auf ein Ticket: genau eine gelingt, ausgeliefert wird, was geprüft wurde', async () => {
    const klein = mitKopf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 64);
    const gross = mitKopf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 2_000_000);
    const ticket = await ticketHolen({ jar: jars.admin, profile: 'gallery', filename: 'wettlauf-bytes.png', mimeType: 'image/png', sizeBytes: gross.byteLength });
    assert.equal(ticket.status, 201, ticket.text);

    const uebertragungen = await Promise.all([
      bytesSchreiben(data(ticket).signedUrl, gross, 'image/png'),
      bytesSchreiben(data(ticket).signedUrl, klein, 'image/png'),
      bytesSchreiben(data(ticket).signedUrl, gross, 'image/png'),
      bytesSchreiben(data(ticket).signedUrl, klein, 'image/png'),
    ]);
    const erfolge = uebertragungen.filter((u) => u.status === 200).length;
    assert.equal(erfolge, 1, `Erfolge: ${uebertragungen.map((u) => u.status).join(', ')}`);

    const abschluss = await post<{ data: Abschluss }>('/api/files/finalize', { ticketId: data(ticket).ticketId, filename: 'wettlauf-bytes.png' }, { jar: jars.admin });
    assert.equal(abschluss.status, 201, abschluss.text);

    // Nach dem Abschluss nimmt das Ticket nichts mehr an.
    assert.notEqual((await bytesSchreiben(data(ticket).signedUrl, klein, 'image/png')).status, 200);

    const abruf = await fetch(`${BASE_URL}${data(abschluss).url}`, { headers: { cookie: jars.admin } });
    assert.equal(abruf.status, 200);
    const ausgeliefert = Buffer.from(await abruf.arrayBuffer());
    assert.equal(createHash('sha256').update(ausgeliefert).digest('hex'), data(abschluss).checksum, 'ausgelieferte Bytes ≠ geprüfte Prüfsumme');
  });

  it('ein unbekanntes Ticket ergibt 404', async () => {
    const antwort = await post(
      '/api/files/finalize',
      { ticketId: 'cmu0000000000000000000000', filename: 'nichts.png' },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 404);
  });

  it('ein fremdes Ticket lässt sich nicht abschliessen', async () => {
    const ticket = await ticketHolen({
      jar: jars.admin,
      profile: 'gallery',
      filename: 'fremd.png',
      mimeType: 'image/png',
      sizeBytes: PNG.byteLength,
    });
    await bytesSchreiben(data(ticket).signedUrl, PNG, 'image/png');

    const antwort = await post(
      '/api/files/finalize',
      { ticketId: data(ticket).ticketId, filename: 'fremd.png' },
      { jar: jars.employee },
    );
    assert.equal(antwort.status, 403, 'ein fremdes Ticket liess sich abschliessen');
  });

  it('der Client kann weder Pfad noch Sichtbarkeit noch Bereich bestimmen', async () => {
    const ticket = await ticketHolen({
      jar: jars.admin,
      profile: 'document',
      filename: 'vertraulich.pdf',
      mimeType: 'application/pdf',
      sizeBytes: PDF.byteLength,
    });
    await bytesSchreiben(data(ticket).signedUrl, PDF, 'application/pdf');

    const abschluss = await post<{ data: Abschluss }>(
      '/api/files/finalize',
      {
        ticketId: data(ticket).ticketId,
        filename: 'vertraulich.pdf',
        // Alles darunter stand früher im Körper von POST /api/media und
        // wurde übernommen. Heute gibt es die Felder nicht mehr.
        isPublic: true,
        scope: 'GALLERY',
        path: 'fremd/uebernommen.pdf',
        url: 'https://example.invalid/uebernommen.pdf',
        mimeType: 'text/html',
        sizeBytes: 1,
      },
      { jar: jars.admin },
    );

    assert.equal(abschluss.status, 201);
    const fertig = data(abschluss);
    assert.equal(fertig.mimeType, 'application/pdf', 'der behauptete Typ wurde übernommen');
    assert.equal(fertig.sizeBytes, PDF.byteLength, 'die behauptete Grösse wurde übernommen');

    // Ein privates Dokument. Wäre `isPublic: true` durchgegangen, käme die
    // Datei ohne Anmeldung heraus.
    const ohneAnmeldung = await get(fertig.url);
    assert.equal(ohneAnmeldung.status, 404, 'isPublic liess sich vom Client setzen');
  });
});

describe('POST /api/media nimmt keine Behauptungen mehr an', () => {
  it('ein frei erfundener Pfad wird mit 422 abgewiesen', async () => {
    const antwort = await post(
      '/api/media',
      {
        bucket: 'clenaris',
        path: 'fremd/erfunden.png',
        url: '/api/files/blob/cmu0000000000000000000000',
        filename: 'erfunden.png',
        mimeType: 'image/png',
        sizeBytes: 10,
        scope: 'GALLERY',
        isPublic: true,
      },
      { jar: jars.admin },
    );

    // Der Körper enthält kein `ticketId` — das Schema lehnt ab, bevor
    // irgendetwas entsteht.
    assert.equal(antwort.status, 422, `Antwort war ${antwort.status}: ${antwort.text}`);
  });
});

after(async () => {
  // Nichts aufzuräumen: Die Prüfreihe legt nur Dateien an, keine
  // Geschäftsobjekte. Sie landen in der Mediathek der Testdatenbank und
  // stören dort niemanden.
});
