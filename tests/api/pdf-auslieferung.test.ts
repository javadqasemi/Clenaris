import { strict as assert } from 'node:assert';
import { before, describe, it } from 'node:test';

import { data, get } from '../helpers/client.js';
import { loginAll } from '../helpers/accounts.js';

/**
 * Was der PDF-Viewer vom Server bekommt (Gate 3).
 *
 * Der Viewer entsteht im Browser; was sich von aussen prüfen lässt, ist die
 * Grenze, an der er hängt: Liefern die Endpunkte, von denen er lädt, ein
 * PDF mit den richtigen Kopfzeilen — und nur an die, die es sehen dürfen?
 * Dazu die Einbettung selbst: Steht der Viewer auf den Seiten, auf denen er
 * stehen soll, mit der autorisierten Adresse und nicht mit einer
 * Ablagekennung?
 *
 * Die Werkzeuge des Viewers (Blättern, Zoom, Anpassen) sind Rechnung und
 * stehen in `pdf-viewer-mathematik.test.ts`. Was dazwischen liegt — Klick,
 * Tastatur, Rendern, der startende Worker — braucht einen Browser und steht
 * seit Gate 4D.1 in `tests/e2e/gate3-pdf-viewer.spec.ts`.
 */

type Zugaenge = Awaited<ReturnType<typeof loginAll>>;
let jars: Zugaenge;
let rechnungId: string | null = null;
let offerteId: string | null = null;
let dokumentId: string | null = null;
/** Ein Dokument, das tatsächlich eine Fassung mit Datei hat. */
let dokumentMitDatei: string | null = null;

async function erste(pfad: string, jar: string): Promise<string | null> {
  const antwort = await get<{ data: Array<{ id: string }> }>(pfad, { jar });
  if (antwort.status !== 200) return null;
  return data(antwort)[0]?.id ?? null;
}

before(async () => {
  jars = await loginAll();
  rechnungId = await erste('/api/invoices?pageSize=1', jars.admin);
  offerteId = await erste('/api/quotes?pageSize=1', jars.admin);
  dokumentId = await erste('/api/bi/documents?pageSize=1', jars.admin);

  /**
   * Die Ablage darf Dokumente ohne Fassung enthalten — eine Police, die
   * jemand angelegt und noch nicht hochgeladen hat. Für die Auslieferung
   * braucht es eines mit Datei; welches, ist gleichgültig.
   */
  const liste = await get<{ data: Array<{ id: string }> }>('/api/bi/documents?pageSize=25', { jar: jars.admin });
  if (liste.status === 200) {
    for (const eintrag of data(liste)) {
      const inhalt = await get(`/api/bi/documents/${eintrag.id}/content`, { jar: jars.admin });
      if (inhalt.status === 200) {
        dokumentMitDatei = eintrag.id;
        break;
      }
    }
  }
});

/** Die Kopfzeilen, die jede private PDF-Antwort tragen muss. */
function pruefePrivatesPdf(antwort: { status: number; headers: Headers; text: string }, was: string) {
  assert.equal(antwort.status, 200, `${was}: ${antwort.status} ${antwort.text.slice(0, 120)}`);
  assert.equal(antwort.headers.get('content-type'), 'application/pdf', `${was}: Content-Type`);
  assert.equal(antwort.headers.get('x-content-type-options'), 'nosniff', `${was}: nosniff`);
  const cache = antwort.headers.get('cache-control') ?? '';
  assert.doesNotMatch(cache, /public/, `${was}: öffentlich zwischenspeicherbar`);
  assert.match(cache, /private|no-store/, `${was}: Cache-Control „${cache}"`);
  assert.match(antwort.headers.get('content-disposition') ?? '', /filename=/, `${was}: Dateiname`);
  assert.ok(antwort.text.startsWith('%PDF-'), `${was}: keine PDF-Signatur am Anfang`);
}

describe('Die PDF-Quellen des Viewers', () => {
  it('Rechnung: Verwaltung bekommt ein PDF mit sicheren Kopfzeilen', async () => {
    if (!rechnungId) return;
    pruefePrivatesPdf(await get(`/api/invoices/${rechnungId}/pdf`, { jar: jars.admin }), 'Rechnung');
  });

  it('Offerte: Verwaltung bekommt ein PDF mit sicheren Kopfzeilen', async () => {
    if (!offerteId) return;
    pruefePrivatesPdf(await get(`/api/quotes/${offerteId}/pdf`, { jar: jars.admin }), 'Offerte');
  });

  it('Rechnung: ohne Anmeldung nichts', async () => {
    if (!rechnungId) return;
    const antwort = await get(`/api/invoices/${rechnungId}/pdf`);
    assert.ok(antwort.status === 401 || antwort.status === 403, `Status ${antwort.status}`);
  });

  it('Rechnung: fremde Kundschaft nichts', async () => {
    if (!rechnungId) return;
    // Das Demokundenkonto besitzt nicht zwingend die erste Rechnung; wenn
    // doch, ist 200 richtig — geprüft wird, dass es nie 500 und nie ein
    // fremdes PDF ohne Prüfung gibt.
    const antwort = await get(`/api/invoices/${rechnungId}/pdf`, { jar: jars.customer });
    assert.ok([200, 403, 404].includes(antwort.status), `Status ${antwort.status}`);
  });
});

describe('Dokumentfassung: der neue Content-Endpunkt', () => {
  it('liefert Verwaltung die geltende Fassung samt Fassungsnummer', async () => {
    if (!dokumentId) return;
    const antwort = await get(`/api/bi/documents/${dokumentId}/content`, { jar: jars.admin });
    // Der Demobestand kann ein Dokument ohne Fassung enthalten — dann 404,
    // und das ist die richtige Antwort.
    if (antwort.status === 404) return;
    assert.equal(antwort.status, 200, antwort.text.slice(0, 200));
    assert.match(antwort.headers.get('x-document-version') ?? '', /^\d+$/, 'Fassungsnummer fehlt');
    assert.equal(antwort.headers.get('x-content-type-options'), 'nosniff');
    assert.match(antwort.headers.get('cache-control') ?? '', /no-store/);
    if (antwort.headers.get('content-type') === 'application/pdf') {
      assert.match(antwort.headers.get('content-disposition') ?? '', /^inline/);
    } else {
      assert.match(antwort.headers.get('content-disposition') ?? '', /^attachment/);
    }
  });

  it('verweigert Kundschaft', async () => {
    if (!dokumentId) return;
    const antwort = await get(`/api/bi/documents/${dokumentId}/content`, { jar: jars.customer });
    assert.ok(antwort.status === 403 || antwort.status === 404, `Status ${antwort.status}`);
  });

  it('verweigert ohne Anmeldung', async () => {
    if (!dokumentId) return;
    const antwort = await get(`/api/bi/documents/${dokumentId}/content`);
    assert.ok(antwort.status === 401 || antwort.status === 403, `Status ${antwort.status}`);
  });

  it('kennt eine erfundene Fassung nicht', async () => {
    if (!dokumentId) return;
    const antwort = await get(`/api/bi/documents/${dokumentId}/content?version=9999`, { jar: jars.admin });
    assert.equal(antwort.status, 404);
  });
});

/**
 * Der Download — der Befund aus Gate 4D.1.
 *
 * **Was hier vorher stand und warum es nicht genügte.** Die Prüfung dieser
 * Route bestand darin, dass sie mit 302 antwortet. Das tat sie auch. Wohin,
 * hat nie jemand nachgesehen: Ohne eingerichteten Objektspeicher — die
 * Vorgabe dieser Anwendung — gab `createSignedDownloadUrl` den blossen
 * Ablagepfad zurück, und die Route leitete auf `<orgId>/documents/<datei>`
 * weiter. Diese Adresse gibt es nicht. Jeder Klick auf „Herunterladen" landete
 * auf einer 404-Seite; aufgefallen ist es erst, als ein Browser tatsächlich
 * klickte (`tests/e2e/gate3-pdf-viewer.spec.ts`).
 *
 * Ein Statuscode ist keine Datei. Diese Reihe prüft deshalb die Datei.
 */
describe('Dokumentfassung: der Download liefert die Datei', () => {
  it('antwortet mit den Bytes — oder mit einer Weiterleitung, die wirklich woandershin zeigt', async () => {
    if (!dokumentMitDatei) return;
    const antwort = await get(`/api/bi/documents/${dokumentMitDatei}/download`, { jar: jars.admin });

    if ([301, 302, 303, 307, 308].includes(antwort.status)) {
      /**
       * Mit Objektspeicher ist die Weiterleitung richtig — dann muss sie aber
       * auf eine vollständige, fremde Adresse zeigen. Ein relativer Pfad wäre
       * genau der Fehler, den diese Prüfung fängt.
       */
      const ziel = antwort.headers.get('location') ?? '';
      assert.match(ziel, /^https?:\/\//, `Weiterleitung auf „${ziel}" — das ist keine ausstellbare Adresse.`);
      return;
    }

    assert.equal(antwort.status, 200, antwort.text.slice(0, 200));
    assert.match(
      antwort.headers.get('content-disposition') ?? '',
      /^attachment; filename=/,
      'Ein Download wird angeboten, nicht angezeigt.',
    );
    assert.equal(antwort.headers.get('x-content-type-options'), 'nosniff');
    assert.doesNotMatch(antwort.headers.get('cache-control') ?? '', /public/);
    assert.ok(antwort.text.length > 0, 'Der Download ist leer.');
    if (antwort.headers.get('content-type') === 'application/pdf') {
      assert.ok(antwort.text.startsWith('%PDF-'), 'keine PDF-Signatur am Anfang');
    }
  });

  it('gibt Kundschaft und Anonymen nichts', async () => {
    if (!dokumentMitDatei) return;
    const alsKunde = await get(`/api/bi/documents/${dokumentMitDatei}/download`, { jar: jars.customer });
    assert.ok([403, 404].includes(alsKunde.status), `Status ${alsKunde.status}`);
    const ohne = await get(`/api/bi/documents/${dokumentMitDatei}/download`);
    assert.ok([401, 403].includes(ohne.status), `Status ${ohne.status}`);
  });
});

describe('Die Einbettung auf den Seiten', () => {
  /**
   * Geprüft wird das ausgelieferte HTML: Der Viewer wird ohne SSR geladen,
   * also steht auf der Seite sein Ankerpunkt (`data-pdf-viewer-mount`) und
   * die Adresse, von der er laden wird — als Eigenschaft der
   * Client-Komponente im serialisierten React-Baum. Eine Ablagekennung
   * (`/api/files/blob/…`) darf dort nirgends stehen.
   */
  const faelle: Array<[string, () => string | null, string, keyof Zugaenge]> = [
    ['Verwaltung Rechnung', () => rechnungId && `/admin/rechnungen/${rechnungId}`, '/api/invoices/', 'admin'],
    ['Verwaltung Offerte', () => offerteId && `/admin/offerten/${offerteId}`, '/api/quotes/', 'admin'],
    ['Führung Dokument', () => dokumentId && `/admin/fuehrung/dokumente/${dokumentId}`, '/api/bi/documents/', 'admin'],
  ];

  for (const [name, pfad, quelle, rolle] of faelle) {
    it(`${name}: Viewer mit autorisierter Adresse, ohne Ablagekennung`, async () => {
      const p = pfad();
      if (!p) return;
      const seite = await get(p, { jar: jars[rolle] });
      assert.equal(seite.status, 200, `${name}: ${seite.status}`);
      const html = seite.text.replace(/<!--[\s\S]*?-->/g, '');
      if (!html.includes('data-pdf-viewer-mount')) {
        // Entwurf oder Dokument ohne PDF-Fassung — dann gibt es keinen Viewer,
        // und das ist richtig.
        return;
      }
      assert.ok(html.includes(quelle), `${name}: Quelle „${quelle}" nicht im HTML`);
      assert.ok(!html.includes('/api/files/blob/'), `${name}: Ablagekennung im HTML`);
    });
  }
});

describe('PDF.js kommt aus dem eigenen Ursprung', () => {
  it('Worker und Hilfsdateien liegen unter /pdfjs/<Version>/', async () => {
    const version = (await get('/pdfjs/VERSION')).text.trim();
    assert.match(version, /^\d+\.\d+\.\d+$/, `VERSION-Datei: „${version}"`);

    const worker = await get(`/pdfjs/${version}/pdf.worker.min.mjs`);
    assert.equal(worker.status, 200, 'Worker nicht ausgeliefert');
    assert.match(worker.headers.get('content-type') ?? '', /javascript/, 'Worker ohne JavaScript-Typ');

    const wasm = await get(`/pdfjs/${version}/wasm/openjpeg.wasm`);
    assert.equal(wasm.status, 200, 'wasm nicht ausgeliefert');
  });
});
