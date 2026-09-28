import { after, afterEach, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Module from 'node:module';
import { join } from 'node:path';

// Nur Typen — zur Laufzeit gelöscht. Geladen werden die Module erst in
// `before()`, nachdem `server-only` umgeleitet ist.
import type * as AblageModul from '../../src/lib/storage/index';
import type * as PruefsummeModul from '../../src/lib/storage/pruefsumme';
import type * as TreiberModul from '../../src/lib/storage/supabase';

/**
 * Vertrag des Supabase-Treibers — ohne Supabase (F-09 c, 2026-09-27).
 *
 * ---------------------------------------------------------------------------
 *  Was hier geprüft wird, und was nicht
 * ---------------------------------------------------------------------------
 *
 * Der Prüfserver läuft mit dem eingebauten Speicher; über HTTP ist der
 * externe Treiber deshalb nie zu sehen. Bis hierher gab es für ihn keinen
 * einzigen Test — und genau dort lagen die drei Befunde von F-09 c: kein
 * berechtigter Leseweg für private Dateien, keine Ablagezeile mit Prüfsumme
 * für servererzeugte Dateien, keine Prüfung, dass nie eine öffentliche
 * Adresse benutzt wird.
 *
 * Dieser Test ruft den **echten** Treiber (`src/lib/storage/supabase.ts`) und
 * den echten Leseweg der Auslieferung (`leseAblageGeprueft` in
 * `src/lib/storage/index.ts`) auf, samt der echten Bibliothek
 * `@supabase/supabase-js`. Ersetzt wird nur das Netz: `globalThis.fetch`
 * zeigt auf einen Nachbau der Storage-API, der Objekte im Speicher hält und
 * jede Anfrage mitschreibt. Dieselbe Technik wie `webhook-ziel.test.ts` mit
 * `https.request` — `storage-js` löst `fetch` bei jedem Aufruf neu auf, der
 * Ersatz greift also auch für den bereits erzeugten Klienten.
 *
 * Was ein Nachbau **nicht** beweisen kann: dass ein echter Bucket privat
 * eingestellt ist, dass der Dienstschlüssel dort trägt und dass Supabase auf
 * ein fehlendes Objekt so antwortet wie hier nachgebildet. Das ist die
 * Abnahme gegen einen echten Bucket (`scripts/abnahme/supabase-ablage.ts`,
 * EXTERNER NACHWEIS E-8).
 *
 * Keine Datenbank, kein Server: Der Leseweg der Auslieferung berührt für
 * `driver = SUPABASE` keine Tabelle. Die Umgebungsvariablen unten sind
 * Platzhalter, damit `serverEnv()` den Bucketnamen liefert — verbunden wird
 * mit keiner der Adressen.
 */

const SUPABASE_URL = 'https://ablage.pruef.example';
const BUCKET = 'clenaris-privat';
// Ein Platzhalter, der nirgends gilt. Geprüft wird, dass er mitgeschickt
// wird — und dass er in keiner Fehlermeldung auftaucht.
const DIENSTSCHLUESSEL = 'pruef-dienstschluessel-nicht-echt-0123456789abcdef';

process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = DIENSTSCHLUESSEL;
process.env.SUPABASE_STORAGE_BUCKET = BUCKET;
process.env.DATABASE_URL ??= 'postgresql://nicht-verwendet@127.0.0.1:1/ablage_vertrag';
process.env.JWT_SECRET ??= 'ablage-vertrag-platzhalter-mindestens-32-zeichen';

// `server-only` gibt es nur in Next — dieselbe Umleitung wie in
// `scripts/abnahme/clamd.ts`, vor dem ersten Import eines Treibermoduls.
const mitAufloeser = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
const urspruenglich = mitAufloeser._resolveFilename;
mitAufloeser._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'server-only') return join(__dirname, '..', '..', 'scripts', 'server-only-stub.cjs');
  return urspruenglich.call(this, request, ...rest);
};

let treiber: typeof TreiberModul;
let ablage: typeof AblageModul;
let pruefsumme: typeof PruefsummeModul;

before(async () => {
  treiber = await import('../../src/lib/storage/supabase');
  ablage = await import('../../src/lib/storage/index');
  pruefsumme = await import('../../src/lib/storage/pruefsumme');
});

after(() => {
  mitAufloeser._resolveFilename = urspruenglich;
});

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// ---------------------------------------------------------------------------
//  Nachbau der Storage-API
// ---------------------------------------------------------------------------

interface Anfrage {
  methode: string;
  url: string;
  kopf: Headers;
}

interface Nachbau {
  anfragen: Anfrage[];
  objekte: Map<string, { bytes: Buffer; typ: string }>;
  /** Wie ein fehlendes Objekt gemeldet wird: 400 mit `statusCode: "404"` (ältere Fassungen) oder 404. */
  fehltAls: 400 | 404;
  /** Simulierter Ausfall: jede Anfrage antwortet 503. */
  ausfall: boolean;
}

const OBJEKT_PRAEFIX = `${SUPABASE_URL}/storage/v1/object/`;

function json(status: number, rumpf: unknown): Response {
  return new Response(JSON.stringify(rumpf), { status, headers: { 'content-type': 'application/json' } });
}

async function rumpfAlsBytes(rumpf: unknown): Promise<Buffer> {
  if (rumpf instanceof Uint8Array) return Buffer.from(rumpf);
  if (rumpf instanceof ArrayBuffer) return Buffer.from(rumpf);
  if (rumpf instanceof Blob) return Buffer.from(await rumpf.arrayBuffer());
  throw new Error(`Unerwarteter Upload-Rumpf: ${Object.prototype.toString.call(rumpf)}`);
}

/**
 * Ein privater Bucket, so wie ihn die Storage-API von aussen zeigt: Lesen und
 * Schreiben nur mit Schlüssel über `/object/<bucket>/<pfad>`; der öffentliche
 * Weg `/object/public/…` kennt diesen Bucket nicht. Der Nachbau beantwortet
 * ihn trotzdem mit den Bytes — so, als wäre der Bucket versehentlich
 * öffentlich. Käme eine Anfrage dort an, wäre das Mitschreiben der Beweis,
 * und der Test unten schlüge an.
 */
function nachbau(): Nachbau {
  const zustand: Nachbau = { anfragen: [], objekte: new Map(), fehltAls: 400, ausfall: false };

  mock.method(globalThis, 'fetch', async (eingabe: string | URL | Request, init?: RequestInit) => {
    const url = typeof eingabe === 'string' ? eingabe : eingabe instanceof URL ? eingabe.href : eingabe.url;
    const methode = (init?.method ?? 'GET').toUpperCase();
    const kopf = new Headers(init?.headers);
    zustand.anfragen.push({ methode, url, kopf });

    if (zustand.ausfall) return json(503, { statusCode: '503', error: 'Service Unavailable', message: 'upstream down' });
    if (!url.startsWith(OBJEKT_PRAEFIX)) return json(404, { message: 'nicht nachgebildet' });

    const rest = decodeURIComponent(url.slice(OBJEKT_PRAEFIX.length).split('?')[0]!);

    if (rest.startsWith('public/')) {
      const schluessel = rest.slice('public/'.length);
      const obj = zustand.objekte.get(schluessel);
      return obj ? new Response(new Uint8Array(obj.bytes), { status: 200 }) : json(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
    }

    // Ohne Schlüssel gibt ein privater Bucket nichts heraus.
    if (kopf.get('authorization') !== `Bearer ${DIENSTSCHLUESSEL}` || kopf.get('apikey') !== DIENSTSCHLUESSEL) {
      return json(400, { statusCode: '403', error: 'Unauthorized', message: 'invalid signature' });
    }

    if (methode === 'POST' || methode === 'PUT') {
      const upsert = kopf.get('x-upsert') === 'true';
      if (zustand.objekte.has(rest) && !upsert) {
        return json(400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
      }
      zustand.objekte.set(rest, { bytes: await rumpfAlsBytes(init?.body), typ: kopf.get('content-type') ?? '' });
      return json(200, { Key: rest, Id: 'nachbau-id' });
    }

    if (methode === 'GET') {
      const obj = zustand.objekte.get(rest);
      if (!obj) {
        return zustand.fehltAls === 404
          ? json(404, { statusCode: '404', error: 'not_found', message: 'Object not found' })
          : json(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      }
      return new Response(new Uint8Array(obj.bytes), { status: 200, headers: { 'content-type': obj.typ } });
    }

    return json(405, { message: 'nicht nachgebildet' });
  });

  return zustand;
}

afterEach(() => {
  mock.restoreAll();
});

const PFAD = 'org-pruef/payroll/2026-09/lohn-abcdef0123456789.pdf';
const PDF = Buffer.from('%PDF-1.7\n% Clenaris Ablagevertrag\n1 0 obj << >> endobj\n%%EOF\n');

function keineOeffentlicheAdresse(n: Nachbau): void {
  const oeffentlich = n.anfragen.filter((a) => a.url.includes('/object/public/'));
  assert.deepEqual(oeffentlich.map((a) => a.url), [], 'eine private Datei wurde über die öffentliche Adresse angefragt');
}

// ---------------------------------------------------------------------------
//  Hochladen
// ---------------------------------------------------------------------------

describe('Supabase-Ablage: servererzeugte Dateien hochladen', () => {
  it('die Bytes gehen mit Dienstschlüssel in den privaten Bucket; zurück kommen Pfad, Grösse und SHA-256 — keine öffentliche Adresse', async () => {
    const n = nachbau();
    const ergebnis = await treiber.uploadBuffer({ path: PFAD, content: PDF, contentType: 'application/pdf', upsert: false });

    assert.equal(ergebnis.path, PFAD);
    assert.equal(ergebnis.sizeBytes, PDF.byteLength);
    assert.equal(ergebnis.checksum, sha256(PDF), 'die Prüfsumme gehört zu den hochgeladenen Bytes');
    assert.ok(!JSON.stringify(ergebnis).includes('http'), `das Ergebnis enthält eine Adresse: ${JSON.stringify(ergebnis)}`);
    assert.ok(!('publicUrl' in ergebnis), 'der Treiber gibt wieder eine öffentliche Adresse zurück');

    assert.equal(n.anfragen.length, 1);
    const [anfrage] = n.anfragen;
    assert.equal(anfrage!.methode, 'POST');
    assert.equal(anfrage!.url, `${OBJEKT_PRAEFIX}${BUCKET}/${PFAD}`);
    assert.equal(anfrage!.kopf.get('x-upsert'), 'false', 'upsert: false muss beim Dienst ankommen');
    assert.equal(anfrage!.kopf.get('content-type'), 'application/pdf');

    const abgelegt = n.objekte.get(`${BUCKET}/${PFAD}`);
    assert.ok(abgelegt, 'das Objekt liegt nicht im Bucket');
    assert.equal(sha256(abgelegt.bytes), sha256(PDF), 'im Bucket liegen andere Bytes als die gemeldete Prüfsumme');
    keineOeffentlicheAdresse(n);
  });

  it('ohne upsert scheitert ein belegter Pfad laut — eine unveränderliche Fassung wird nie still überschrieben', async () => {
    const n = nachbau();
    await treiber.uploadBuffer({ path: PFAD, content: PDF, contentType: 'application/pdf', upsert: false });
    const andere = Buffer.from('%PDF-1.7\n% eine andere Fassung\n%%EOF\n');

    await assert.rejects(
      treiber.uploadBuffer({ path: PFAD, content: andere, contentType: 'application/pdf', upsert: false }),
      (fehler: unknown) => {
        const f = fehler as { code?: string; message?: string };
        assert.equal(f.code, 'INTEGRATION_ERROR');
        assert.ok(!String(f.message).includes(DIENSTSCHLUESSEL), 'der Dienstschlüssel steht in der Fehlermeldung');
        return true;
      },
    );
    assert.equal(sha256(n.objekte.get(`${BUCKET}/${PFAD}`)!.bytes), sha256(PDF), 'die erste Fassung wurde überschrieben');
  });
});

// ---------------------------------------------------------------------------
//  Lesen — der Leseweg der Auslieferung
// ---------------------------------------------------------------------------

describe('Supabase-Ablage: der berechtigte Leseweg', () => {
  it('hochgeladen und über leseAblageGeprueft zurückgelesen: dieselben Bytes, Prüfsumme bestätigt, nur über den authentifizierten Objektweg', async () => {
    const n = nachbau();
    const hoch = await treiber.uploadBuffer({ path: PFAD, content: PDF, contentType: 'application/pdf', upsert: false });

    const gelesen = await ablage.leseAblageGeprueft(
      { id: 'ablage-1', path: PFAD, driver: 'SUPABASE', checksum: hoch.checksum },
      hoch.checksum,
    );

    assert.equal(gelesen.status, 'ok', JSON.stringify(gelesen));
    assert.ok(gelesen.status === 'ok');
    assert.equal(gelesen.pruefung, 'ok');
    assert.ok(gelesen.bytes.equals(PDF), 'andere Bytes als hochgeladen');

    const lesen = n.anfragen.filter((a) => a.methode === 'GET');
    assert.equal(lesen.length, 1);
    assert.equal(lesen[0]!.url, `${OBJEKT_PRAEFIX}${BUCKET}/${PFAD}`, 'gelesen wurde nicht über den authentifizierten Objektweg');
    assert.equal(lesen[0]!.kopf.get('authorization'), `Bearer ${DIENSTSCHLUESSEL}`, 'ohne Dienstschlüssel gelesen');
    keineOeffentlicheAdresse(n);
  });

  for (const fehltAls of [400, 404] as const) {
    it(`ein fehlendes Objekt (Supabase antwortet ${fehltAls}) heisst „fehlt" — keine leere Datei, kein Ausfall`, async () => {
      const n = nachbau();
      n.fehltAls = fehltAls;

      const gelesen = await ablage.leseAblageGeprueft({ id: 'ablage-2', path: 'org-pruef/gibt-es-nicht.pdf', driver: 'SUPABASE', checksum: sha256(PDF) });
      assert.deepEqual(gelesen, { status: 'fehlt' });

      const roh = await treiber.holeObjekt('org-pruef/gibt-es-nicht.pdf');
      assert.deepEqual(roh, { status: 'fehlt' });
      assert.equal(await treiber.downloadObject('org-pruef/gibt-es-nicht.pdf'), null);
      keineOeffentlicheAdresse(n);
    });
  }

  it('veränderte Bytes im Bucket → „abweichung", keine Bytes (fail closed)', async () => {
    const n = nachbau();
    const hoch = await treiber.uploadBuffer({ path: PFAD, content: PDF, contentType: 'application/pdf', upsert: false });

    // Jemand mit Zugang zum Bucket ersetzt die Datei — an der Anwendung vorbei.
    const manipuliert = Buffer.from(PDF.toString('latin1').replace('Ablagevertrag', 'Ablagevertrog'), 'latin1');
    assert.equal(manipuliert.byteLength, PDF.byteLength, 'gleiche Grösse: nur die Prüfsumme kann es bemerken');
    n.objekte.set(`${BUCKET}/${PFAD}`, { bytes: manipuliert, typ: 'application/pdf' });

    const gelesen = await ablage.leseAblageGeprueft(
      { id: 'ablage-3', path: PFAD, driver: 'SUPABASE', checksum: hoch.checksum },
      hoch.checksum,
    );
    assert.equal(gelesen.status, 'abweichung', JSON.stringify(gelesen));
    assert.ok(!('bytes' in gelesen), 'bei einer Abweichung dürfen keine Bytes zurückkommen');
    assert.ok(gelesen.status === 'abweichung');
    assert.equal(gelesen.erwartet, hoch.checksum);
    assert.equal(gelesen.tatsaechlich, sha256(manipuliert));
    keineOeffentlicheAdresse(n);
  });

  it('Ablagezeile und FileAsset nennen verschiedene Prüfsummen → „widerspruch", keine Bytes — auch wenn die Bytes zu einer der beiden passen', async () => {
    const n = nachbau();
    const hoch = await treiber.uploadBuffer({ path: PFAD, content: PDF, contentType: 'application/pdf', upsert: false });

    const gelesen = await ablage.leseAblageGeprueft(
      { id: 'ablage-4', path: PFAD, driver: 'SUPABASE', checksum: hoch.checksum },
      sha256(Buffer.from('eine andere, veröffentlichte Fassung')),
    );
    assert.equal(gelesen.status, 'widerspruch', JSON.stringify(gelesen));
    assert.ok(!('bytes' in gelesen));
    keineOeffentlicheAdresse(n);
  });

  it('ein Speicherausfall ist kein „fehlt": der Leseweg wirft einen Integrationsfehler ohne Schlüssel, der Abschluss sieht weiterhin null', async () => {
    const n = nachbau();
    await treiber.uploadBuffer({ path: PFAD, content: PDF, contentType: 'application/pdf', upsert: false });
    n.ausfall = true;

    await assert.rejects(
      ablage.leseAblageGeprueft({ id: 'ablage-5', path: PFAD, driver: 'SUPABASE', checksum: sha256(PDF) }),
      (fehler: unknown) => {
        const f = fehler as { code?: string; status?: number; message?: string };
        assert.equal(f.code, 'INTEGRATION_ERROR');
        assert.equal(f.status, 502);
        assert.ok(!String(f.message).includes(DIENSTSCHLUESSEL), 'der Dienstschlüssel steht in der Fehlermeldung');
        return true;
      },
    );

    const roh = await treiber.holeObjekt(PFAD);
    assert.equal(roh.status, 'fehler', 'ein Ausfall darf nicht als „fehlt" gelten');
    // Abschluss und Prüflauf behandeln „keine Bytes" bereits richtig; eine
    // Ausnahme liesse den Nachlauf mitten in der Reihe abbrechen.
    assert.equal(await treiber.downloadObject(PFAD), null);
    keineOeffentlicheAdresse(n);
  });
});

// ---------------------------------------------------------------------------
//  Die reine Entscheidung
// ---------------------------------------------------------------------------

describe('Prüfsummenentscheidung beim Lesen', () => {
  it('ohne jede Prüfsumme (Altbestand) heisst das Ergebnis „ungeprueft", nicht „ok"', () => {
    const befund = pruefsumme.pruefeGeleseneBytes(PDF, { ablage: null, asset: null });
    assert.equal(befund.status, 'ungeprueft');
  });

  it('fehlt die physische Prüfsumme, gilt die Momentaufnahme am FileAsset — und eine Abweichung davon sperrt', () => {
    assert.equal(pruefsumme.pruefeGeleseneBytes(PDF, { ablage: null, asset: sha256(PDF) }).status, 'ok');
    assert.equal(pruefsumme.pruefeGeleseneBytes(PDF, { ablage: null, asset: sha256(Buffer.from('x')) }).status, 'abweichung');
  });

  it('Grossschrift in einer gespeicherten Prüfsumme ist keine Abweichung', () => {
    assert.equal(pruefsumme.pruefeGeleseneBytes(PDF, { ablage: sha256(PDF).toUpperCase(), asset: sha256(PDF) }).status, 'ok');
  });

  it('veränderte Bytes wiegen schwerer als widersprüchliche Datensätze: „abweichung" vor „widerspruch"', () => {
    const befund = pruefsumme.pruefeGeleseneBytes(PDF, { ablage: sha256(Buffer.from('a')), asset: sha256(Buffer.from('b')) });
    assert.equal(befund.status, 'abweichung');
  });
});
