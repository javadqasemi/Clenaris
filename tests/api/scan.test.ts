import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { call, data, del, get, post, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { resetRateLimits, rateLimitResetAvailable } from '../helpers/rate-limit';
import { eigeneOrganisationId, fremdeOrganisation, schutzfreiAufraeumen, testDb, testDbSchliessen } from '../helpers/testdb';

/**
 * Scanplattform über HTTP (2026-09-26): Etikett, Strichcode, QR-Rechnung und
 * Nummer — aufgelöst im Leserecht der Rolle, im eigenen Mandanten, ohne dass
 * irgendetwas von allein geschieht.
 *
 * Die Fälle folgen der Kette SCAN → EINORDNEN → PRÜFEN → AUFLÖSEN →
 * BERECHTIGEN → ZEIGEN → WÄHLEN → ERNEUT PRÜFEN: bekannte und unbekannte
 * Codes, fremde Organisation, fehlendes Recht, kaputte, lange und feindliche
 * Eingaben, doppelte und gesperrte Etiketten, gelöschte Datensätze, das
 * Kontingent — und am Ende eine Schnellaktion, die über den bestehenden
 * Endpunkt bucht und im Protokoll steht.
 */

interface Treffer {
  art: string;
  id: string;
  titel: string;
  link: string | null;
  aktionen: { schluessel: string; optionen?: { value: string; label: string }[] }[];
  verweise: { label: string; href: string; art: string }[];
  etikett: string | null;
}
interface Ergebnis {
  eingabe: { art: string; anzeige: string; format: string | null };
  treffer: Treffer[];
  hinweis: string | null;
  neuerArtikel: { barcode: string; format: string } | null;
}
type Antwort = { data: Ergebnis };

let jars: Record<AccountName, string>;
const RUN = Date.now();
const SKU = `SCAN-${RUN}`;
/** Eine EAN-13, die es im Demobestand nicht gibt — Prüfziffer passend gerechnet. */
const EAN_NEU = mitPruefziffer(`760${String(RUN).slice(-9)}`);
/** Dieselbe als UPC-A gelesen wäre nur mit führender 0 gleich; hier ein eigener UPC-A. */
const UPC = mitPruefziffer(`0${String(RUN).slice(-10)}`);

/** 20 Zeichen aus dem Code-Alphabet; der Vorsatz macht ihn beim Aufräumen auffindbar. */
const FREMDCODE = 'SCANTEST000000000000';

let materialId = '';
let geraetId = '';
let objektId = '';
let fremdesMaterial = '';
const angelegteMaterialien: string[] = [];

function mitPruefziffer(koerper: string): string {
  let summe = 0;
  for (let i = 0; i < koerper.length; i += 1) summe += Number(koerper[koerper.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  return `${koerper}${(10 - (summe % 10)) % 10}`;
}

const aufloesen = (text: string, jar: string) => post<Antwort>('/api/scan/resolve', { text }, { jar });

async function etikett(entityType: string, entityId: string, jar: string) {
  return post<{ data: { id: string; inhalt: string; neu: boolean } }>('/api/scan/codes', { entityType, entityId }, { jar });
}

async function aufraeumen() {
  const db = testDb();
  if (!db) return;
  const materialien = await db.material.findMany({
    where: { OR: [{ sku: { startsWith: 'SCAN-' } }, { id: { in: angelegteMaterialien } }] },
    select: { id: true },
  });
  const ids = materialien.map((m) => m.id);
  await schutzfreiAufraeumen(async (tx) => {
    await tx.scanCode.deleteMany({ where: { OR: [{ entityId: { in: [...ids, geraetId, objektId].filter(Boolean) } }, { code: { startsWith: 'SCANTEST' } }] } });
    await tx.stockMovement.deleteMany({ where: { materialId: { in: ids } } });
    await tx.material.deleteMany({ where: { id: { in: ids } } });
    await tx.equipment.deleteMany({ where: { name: { startsWith: 'Scangerät' } } });
    await tx.property.deleteMany({ where: { label: { startsWith: 'Scanobjekt' } } });
    // Prüfbestand 2026-09-28: ausgestellte Rechnungen mit alter und neuer
    // QR-Referenz (an den Unveränderlichkeitstriggern vorbei, nur hier) und
    // Verträge mit Nummer, in der eigenen und der fremden Organisation.
    await tx.invoice.deleteMany({ where: { number: { startsWith: 'SCAN-RE-' } } });
    await tx.contract.deleteMany({ where: { number: { startsWith: 'SCAN-VT-' } } });
  });
}

/** Eine gültige QR-Referenz aus 26 Ziffern Körper (Modulo 10 rekursiv, wie `kennung.ts`). */
function qrReferenz(koerper: string): string {
  const tabelle = [0, 9, 4, 6, 8, 2, 7, 1, 3, 5];
  let uebertrag = 0;
  for (const z of koerper) uebertrag = tabelle[(uebertrag + Number(z)) % 10]!;
  return `${koerper}${(10 - uebertrag) % 10}`;
}

function qrRechnungText(referenz: string): string {
  return [
    'SPC', '0200', '1', 'CH4431999123000889012',
    'S', 'Clenaris', 'Weg', '1', '3011', 'Bern', 'CH',
    '', '', '', '', '', '', '',
    '100.00', 'CHF',
    '', '', '', '', '', '', '',
    'QRR', referenz, '', 'EPD',
  ].join('\n');
}

before(async () => {
  await requireServer();
  jars = await loginAll();
  await aufraeumen();

  const m = await post<{ data: { id: string } }>('/api/materials', { sku: SKU, name: 'Scanprüfung Reiniger', unit: 'l', minStock: 5 }, { jar: jars.manager });
  assert.equal(m.status, 201, m.text);
  materialId = data(m).id;
  const g = await post<{ data: { id: string } }>('/api/equipment', { name: `Scangerät ${RUN}` }, { jar: jars.manager });
  assert.equal(g.status, 201, g.text);
  geraetId = data(g).id;

  const db = testDb();
  const eigen = await eigeneOrganisationId();
  if (db && eigen) {
    const kunde = await db.customer.findFirst({ where: { organizationId: eigen, deletedAt: null }, select: { id: true } });
    if (kunde) objektId = (await db.property.create({ data: { customerId: kunde.id, label: `Scanobjekt ${RUN}` } })).id;
  }
  const fremd = await fremdeOrganisation();
  if (db && fremd) {
    fremdesMaterial = (await db.material.create({ data: { organizationId: fremd, sku: `SCAN-F-${RUN}`, name: 'Fremdes Material', barcode: EAN_NEU } })).id;
    angelegteMaterialien.push(fremdesMaterial);
  }
});

after(async () => {
  await aufraeumen();
  if (rateLimitResetAvailable()) resetRateLimits();
  await testDbSchliessen();
});

describe('Etikettcode: erzeugen, auflösen, sperren', () => {
  let inhalt = '';
  let codeId = '';

  it('erzeugt einmal (201) und liefert danach denselben Code (200)', async () => {
    const erst = await etikett('MATERIAL', materialId, jars.manager);
    assert.equal(erst.status, 201, erst.text);
    inhalt = data(erst).inhalt;
    codeId = data(erst).id;
    assert.match(inhalt, /^CLX1:[0-9A-HJKMNP-TV-Z]{20}$/);
    const zweit = await etikett('MATERIAL', materialId, jars.manager);
    assert.equal(zweit.status, 200);
    assert.equal(data(zweit).inhalt, inhalt);
  });

  it('der Code enthält nichts vom Datensatz — keine ID, keine Nummer, keinen Namen', () => {
    assert.ok(!inhalt.includes(materialId));
    assert.ok(!inhalt.includes(SKU));
    assert.ok(!/Reiniger/i.test(inhalt));
  });

  it('bekannter Code: der Artikel mit Bestand und Schnellaktionen fürs Büro', async () => {
    const r = await aufloesen(inhalt, jars.manager);
    assert.equal(r.status, 200, r.text);
    const e = data(r);
    assert.equal(e.eingabe.art, 'INTERN');
    assert.equal(e.treffer.length, 1);
    assert.equal(e.treffer[0]!.id, materialId);
    assert.deepEqual(
      e.treffer[0]!.aktionen.map((a) => a.schluessel).sort(),
      ['material.eingang', 'material.entnahme', 'material.korrektur'],
    );
    assert.equal(e.treffer[0]!.link, `/admin/material#material-${materialId}`);
  });

  it('Mitarbeitende ohne Lagerrecht: dieselbe leere Antwort wie bei einem unbekannten Code', async () => {
    const r = data(await aufloesen(inhalt, jars.employee));
    assert.deepEqual(r.treffer, []);
    const unbekannt = data(await aufloesen('CLX1:ZZZZZZZZZZZZZZZZZZZZ', jars.employee));
    assert.equal(r.hinweis, unbekannt.hinweis, 'Die Antwort verrät, dass es hinter dem Code etwas gibt');
  });

  it('die Kundschaft hat keinen Scanner (403), ohne Anmeldung 401', async () => {
    assert.equal((await aufloesen(inhalt, jars.customer)).status, 403);
    assert.equal((await post('/api/scan/resolve', { text: inhalt })).status, 401);
  });

  it('die globale Suche findet den Artikel über den Etikettcode', async () => {
    const r = data(await get<{ data: { treffer: { art: string; id: string }[] } }>(`/api/search?q=${encodeURIComponent(inhalt)}`, { jar: jars.manager }));
    assert.ok(r.treffer.some((t) => t.art === 'Material' && t.id === materialId), JSON.stringify(r));
  });

  it('gesperrt: Hinweis für wer lesen darf, keine Schnellaktionen mehr; ein neues Etikett bekommt einen neuen Code', async () => {
    const sperre = await del(`/api/scan/codes/${codeId}`, { jar: jars.manager });
    assert.equal(sperre.status, 200, sperre.text);
    const r = data(await aufloesen(inhalt, jars.manager));
    assert.match(r.hinweis ?? '', /gesperrt/);
    assert.equal(r.treffer.length, 1);
    assert.deepEqual(r.treffer[0]!.aktionen, []);
    // Ohne Leserecht bleibt auch der gesperrte Code stumm.
    assert.equal(data(await aufloesen(inhalt, jars.employee)).hinweis, 'Kein Datensatz zu diesem Etikett.');

    // Die globale Suche gibt dieselbe Warnung (2026-09-27). Vorher zeigte sie
    // den Artikel zum gesperrten Etikett kommentarlos — derselbe Code, zwei
    // verschiedene Antworten, und die Suche war die ohne Warnung.
    const suche = data(await get<{ data: { treffer: { id: string }[]; hinweis: string | null } }>(`/api/search?q=${encodeURIComponent(inhalt)}`, { jar: jars.manager }));
    assert.ok(suche.treffer.some((t) => t.id === materialId), JSON.stringify(suche));
    assert.match(suche.hinweis ?? '', /gesperrt/, 'die Suche verschweigt die Sperre');
    const seite = await get(`/admin/suche?q=${encodeURIComponent(inhalt)}`, { jar: jars.manager });
    assert.equal(seite.status, 200);
    assert.match(seite.text, /Etikett ist gesperrt/, 'die Vollansicht verschweigt die Sperre');

    const neu = await etikett('MATERIAL', materialId, jars.manager);
    assert.equal(neu.status, 201);
    assert.notEqual(data(neu).inhalt, inhalt);
  });

  it('Etikett erzeugen verlangt das Pflegerecht der Art (Mitarbeitende 403) und findet keine fremden IDs (404)', async () => {
    assert.equal((await etikett('MATERIAL', materialId, jars.employee)).status, 403);
    if (fremdesMaterial) assert.equal((await etikett('MATERIAL', fremdesMaterial, jars.admin)).status, 404);
    assert.equal((await etikett('MATERIAL', 'gibt-es-nicht', jars.admin)).status, 404);
    assert.equal((await post('/api/scan/codes', { entityType: 'INVOICE', entityId: materialId }, { jar: jars.admin })).status, 422);
  });

  it('zwei gleichzeitige Anfragen erzeugen genau einen aktiven Code', async (t) => {
    const db = testDb();
    if (!db) return t.skip('keine Testdatenbank');
    const [a, b] = await Promise.all([etikett('EQUIPMENT', geraetId, jars.manager), etikett('EQUIPMENT', geraetId, jars.manager)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 201]);
    assert.equal(data(a).inhalt, data(b).inhalt);
    assert.equal(await db.scanCode.count({ where: { entityId: geraetId, revokedAt: null } }), 1);
  });

  it('Erzeugen und Sperren stehen im Protokoll — ohne den Code selbst', async (t) => {
    const db = testDb();
    if (!db) return t.skip('keine Testdatenbank');
    const eintraege = await db.auditLog.findMany({ where: { entity: 'ScanCode', entityId: codeId }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(eintraege.map((e) => e.action), ['CREATE', 'UPDATE']);
    for (const e of eintraege) assert.ok(!(e.summary ?? '').includes(inhalt.slice(5)), 'Der Code steht im Protokoll');
  });
});

describe('Fremd, gelöscht, kaputt, feindlich', () => {
  it('ein Code einer fremden Organisation löst nichts auf', async (t) => {
    const db = testDb();
    const fremd = await fremdeOrganisation();
    if (!db || !fremd || !fremdesMaterial) return t.skip('keine fremde Organisation');
    // Ein gültig geformter Code, eingetragen unter der fremden Organisation.
    await db.scanCode.create({ data: { organizationId: fremd, entityType: 'MATERIAL', entityId: fremdesMaterial, code: FREMDCODE } });
    const r = data(await aufloesen(`CLX1:${FREMDCODE}`, jars.super));
    assert.deepEqual(r.treffer, []);
  });

  it('ein fremder Strichcode findet den fremden Artikel nicht — und bietet das Anlegen an', async () => {
    const r = data(await aufloesen(EAN_NEU, jars.manager));
    assert.equal(r.eingabe.art, 'GTIN');
    assert.deepEqual(r.treffer, []);
    assert.equal(r.hinweis, 'Artikel nicht gefunden.');
    assert.deepEqual(r.neuerArtikel, { barcode: EAN_NEU, format: 'EAN_13' });
  });

  it('das Objekt eines gelöschten Datensatzes: nicht mehr auflösbar', async (t) => {
    const db = testDb();
    if (!db || !objektId) return t.skip('keine Testdatenbank');
    const code = await etikett('PROPERTY', objektId, jars.admin);
    assert.equal(code.status, 201, code.text);
    const vorher = data(await aufloesen(data(code).inhalt, jars.admin));
    assert.equal(vorher.treffer[0]?.art, 'OBJEKT');
    await db.property.update({ where: { id: objektId }, data: { deletedAt: new Date() } });
    const nachher = data(await aufloesen(data(code).inhalt, jars.admin));
    assert.deepEqual(nachher.treffer, []);
  });

  it('kaputte Codes, Steuerzeichen und Markup: 200 ohne Treffer, nie ein Fehler 500', async () => {
    for (const text of ['CLX1:KURZ', 'ABC\u0000DEF', '<script>alert(1)</script>', "' OR 1=1 --", '{{7*7}}', '../../etc/passwd']) {
      const r = await aufloesen(text, jars.admin);
      assert.equal(r.status, 200, `${JSON.stringify(text)}: ${r.text}`);
      assert.deepEqual(data(r).treffer, [], JSON.stringify(text));
    }
  });

  it('Adressen werden weder aufgelöst noch als Link zurückgegeben', async () => {
    for (const text of ['https://login.example.com/clenaris', 'javascript:alert(document.cookie)', 'data:text/html,<b>x</b>']) {
      const r = data(await aufloesen(text, jars.admin));
      assert.equal(r.eingabe.art, 'ADRESSE', text);
      assert.deepEqual(r.treffer, []);
      assert.match(r.hinweis ?? '', /öffnet gescannte Adressen nicht/);
      assert.ok(!JSON.stringify(r).includes('"link":"http'), 'Eine gescannte Adresse kommt als Link zurück');
    }
  });

  it('fremde Herkunft: Etikett erzeugen, sperren und auflösen werden abgewiesen (403)', async () => {
    const fremd = { origin: 'https://fremde-seite.example' };
    assert.equal((await post('/api/scan/codes', { entityType: 'MATERIAL', entityId: materialId }, { jar: jars.manager, headers: fremd })).status, 403);
    assert.equal((await del('/api/scan/codes/irgendeiner', { jar: jars.manager, headers: fremd })).status, 403);
    assert.equal((await post('/api/scan/resolve', { text: SKU }, { jar: jars.manager, headers: fremd })).status, 403);
  });

  it('zu lang: 422 vor jedem Dienst; leer: 422', async () => {
    assert.equal((await aufloesen('A'.repeat(1001), jars.admin)).status, 422);
    assert.equal((await aufloesen('', jars.admin)).status, 422);
    assert.equal((await post('/api/scan/resolve', { text: 42 }, { jar: jars.admin })).status, 422);
  });
});

describe('Strichcode und Nummern', () => {
  it('unbekannte EAN → „Neuen Artikel erfassen" vorbelegt nur mit dem Strichcode; danach findet der Scan ihn', async () => {
    const anlegen = await post<{ data: { id: string; barcode: string } }>(
      '/api/materials',
      { sku: `SCAN-N-${RUN}`, name: 'Neu aus dem Scan', barcode: EAN_NEU },
      { jar: jars.manager },
    );
    assert.equal(anlegen.status, 201, anlegen.text);
    angelegteMaterialien.push(data(anlegen).id);
    const r = data(await aufloesen(EAN_NEU, jars.manager));
    assert.equal(r.treffer[0]?.id, data(anlegen).id);
    assert.equal(r.neuerArtikel, null);
  });

  it('derselbe Strichcode ein zweites Mal: 409 mit Hinweis auf den Strichcode', async () => {
    const zweit = await post('/api/materials', { sku: `SCAN-D-${RUN}`, name: 'Doppelt', barcode: EAN_NEU }, { jar: jars.manager });
    assert.equal(zweit.status, 409, zweit.text);
    assert.match(zweit.text, /Strichcode/);
  });

  it('ein Strichcode mit falscher Prüfziffer wird nicht gespeichert (422)', async () => {
    const r = await post('/api/materials', { sku: `SCAN-P-${RUN}`, name: 'Prüfziffer', barcode: '4006381333932' }, { jar: jars.manager });
    assert.equal(r.status, 422, r.text);
  });

  it('UPC-A und die EAN-13 mit führender Null finden denselben Artikel', async () => {
    const r = await post<{ data: { id: string; barcode: string } }>('/api/materials', { sku: `SCAN-U-${RUN}`, name: 'UPC', barcode: UPC }, { jar: jars.manager });
    assert.equal(r.status, 201, r.text);
    angelegteMaterialien.push(data(r).id);
    assert.equal(data(r).barcode, `0${UPC}`);
    assert.equal(data(await aufloesen(UPC, jars.manager)).treffer[0]?.id, data(r).id);
    assert.equal(data(await aufloesen(`0${UPC}`, jars.manager)).treffer[0]?.id, data(r).id);
  });

  it('Mitarbeitende bekommen für eine unbekannte EAN kein Anlegen angeboten', async () => {
    const r = data(await aufloesen(mitPruefziffer('761234567890'), jars.employee));
    assert.equal(r.neuerArtikel, null);
  });

  it('eine Nummer trifft genau — kein Teilwort', async () => {
    const r = data(await aufloesen(SKU, jars.manager));
    assert.deepEqual(r.treffer.map((t) => t.id), [materialId]);
    assert.deepEqual(data(await aufloesen(SKU.slice(0, -1), jars.manager)).treffer, []);
  });
});

describe('Schnellaktionen je Rolle und die erneute Prüfung', () => {
  it('Rechnung per Nummer und per QR-Rechnung — Zahlung erfassen nur mit payment:create, Mitarbeitende sehen nichts', async (t) => {
    const db = testDb();
    const eigen = await eigeneOrganisationId();
    if (!db || !eigen) return t.skip('keine Testdatenbank');
    const rechnung = await db.invoice.findFirst({
      where: { organizationId: eigen, deletedAt: null, status: { in: ['ISSUED', 'SENT', 'PARTIALLY_PAID', 'OVERDUE'] } },
      select: { id: true, number: true },
    });
    if (!rechnung) return t.skip('keine offene Rechnung im Demobestand');
    const perNummer = data(await aufloesen(rechnung.number, jars.admin));
    const treffer = perNummer.treffer.find((x) => x.id === rechnung.id);
    assert.ok(treffer, JSON.stringify(perNummer));
    assert.deepEqual(treffer.aktionen.map((a) => a.schluessel), ['rechnung.zahlung']);

    const zeilen = ['SPC', '0200', '1', 'CH4431999123000889012', 'S', 'Clenaris', 'Weg', '1', '3011', 'Bern', 'CH', '', '', '', '', '', '', '', '100.00', 'CHF', '', '', '', '', '', '', '', 'NON', '', `Rechnung ${rechnung.number}`, 'EPD'];
    const perQr = data(await aufloesen(zeilen.join('\n'), jars.admin));
    assert.equal(perQr.eingabe.art, 'QR_RECHNUNG');
    assert.ok(perQr.treffer.some((x) => x.id === rechnung.id), JSON.stringify(perQr));

    assert.deepEqual(data(await aufloesen(rechnung.number, jars.employee)).treffer, []);
  });

  it('Einsatz: Mitarbeitende finden nur den eigenen, mit Link ins Portal und „Einstempeln"', async (t) => {
    const db = testDb();
    const eigen = await eigeneOrganisationId();
    if (!db || !eigen) return t.skip('keine Testdatenbank');
    const anna = await db.employee.findFirst({ where: { user: { email: 'anna.keller@clenaris.ch' } }, select: { id: true } });
    const eigener = await db.job.findFirst({
      where: { organizationId: eigen, deletedAt: null, assignments: { some: { employeeId: anna?.id ?? '__' } }, status: { in: ['SCHEDULED', 'DISPATCHED'] } },
      select: { id: true, number: true },
    });
    const fremder = await db.job.findFirst({
      where: { organizationId: eigen, deletedAt: null, assignments: { none: { employeeId: anna?.id ?? '__' } } },
      select: { id: true, number: true },
    });
    if (!eigener || !fremder) return t.skip('Demobestand ohne passende Einsätze');
    const r = data(await aufloesen(eigener.number, jars.employee));
    const treffer = r.treffer.find((x) => x.id === eigener.id);
    assert.ok(treffer, JSON.stringify(r));
    assert.equal(treffer.link, `/portal/einsaetze/${eigener.id}`);
    assert.deepEqual(treffer.aktionen.map((a) => a.schluessel), ['einsatz.einstempeln']);
    assert.equal(treffer.etikett, null);
    // Rapport im Portal — kein PDF-Endpunkt, den die Rolle nicht abrufen darf.
    assert.deepEqual(treffer.verweise, [{ label: 'Rapport', href: `/portal/einsaetze/${eigener.id}#rapport`, art: 'seite' }]);
    // Ein fremder Einsatz ist für Mitarbeitende dieselbe leere Antwort wie
    // eine Nummer, die es nicht gibt — kein Hinweis, dass es ihn gibt.
    const fremd = data(await aufloesen(fremder.number, jars.employee));
    const unbekannt = data(await aufloesen(`E-GIBTESNICHT-${RUN}`, jars.employee));
    assert.deepEqual(fremd.treffer, []);
    assert.equal(fremd.hinweis, unbekannt.hinweis);
    // Das Büro sieht beide, aber ohne „Einstempeln" — es ist nicht zugeteilt.
    const buero = data(await aufloesen(fremder.number, jars.manager));
    assert.equal(buero.treffer[0]?.link, `/admin/einsaetze/${fremder.id}`);
    assert.deepEqual(buero.treffer[0]?.aktionen, []);
    assert.deepEqual(buero.treffer[0]?.verweise, [{ label: 'Rapport (PDF)', href: `/api/jobs/${fremder.id}/report`, art: 'datei' }]);
    // Der Verweis ist kein Zugang: Der Endpunkt prüft beim Abruf selbst.
    assert.equal((await get(`/api/jobs/${fremder.id}/report`, { jar: jars.employee })).status, 403);
  });

  it('Einsatz: läuft die eigene Zeit schon, bietet der Scan „Ausstempeln" statt „Einstempeln"', async (t) => {
    const db = testDb();
    const eigen = await eigeneOrganisationId();
    if (!db || !eigen) return t.skip('keine Testdatenbank');
    const anna = await db.employee.findFirst({ where: { user: { email: 'anna.keller@clenaris.ch' } }, select: { id: true } });
    if (!anna) return t.skip('keine Mitarbeitende im Demobestand');
    if (await db.timeEntry.count({ where: { employeeId: anna.id, endedAt: null } })) return t.skip('es läuft bereits eine Zeiterfassung');
    const eigener = await db.job.findFirst({
      where: { organizationId: eigen, deletedAt: null, assignments: { some: { employeeId: anna.id } }, status: { in: ['SCHEDULED', 'DISPATCHED'] } },
      select: { id: true, number: true },
    });
    if (!eigener) return t.skip('Demobestand ohne passenden Einsatz');
    // Direkt angelegt statt über `clock-in`: Einstempeln setzte den
    // Demoeinsatz auf „in Arbeit", und andere Prüfdateien suchen geplante.
    const eintrag = await db.timeEntry.create({ data: { employeeId: anna.id, jobId: eigener.id, startedAt: new Date() } });
    try {
      const r = data(await aufloesen(eigener.number, jars.employee));
      const treffer = r.treffer.find((x) => x.id === eigener.id);
      assert.deepEqual(treffer?.aktionen.map((a) => a.schluessel), ['einsatz.ausstempeln']);
    } finally {
      await schutzfreiAufraeumen((tx) => tx.timeEntry.deleteMany({ where: { id: eintrag.id } }));
    }
  });

  it('Gerät: „Defekt melden" über den bestehenden Statusendpunkt, danach „Wieder verfügbar"', async () => {
    const code = data(await etikett('EQUIPMENT', geraetId, jars.manager)).inhalt;
    const r1 = data(await aufloesen(code, jars.manager));
    // Seit 2026-09-28 auch „Zuteilen" für ein freies, verfügbares Gerät.
    assert.deepEqual(r1.treffer[0]!.aktionen.map((a) => a.schluessel), ['geraet.wartung', 'geraet.defekt', 'geraet.zuteilen']);
    const defekt = await post(`/api/equipment/${geraetId}/status`, { status: 'MAINTENANCE', reason: 'Kabel beschädigt' }, { jar: jars.manager });
    assert.equal(defekt.status, 200, defekt.text);
    const r2 = data(await aufloesen(code, jars.manager));
    // In Wartung kein Zuteilen — `assignEquipment` wiese es mit 422 ab.
    assert.deepEqual(r2.treffer[0]!.aktionen.map((a) => a.schluessel), ['geraet.wartung', 'geraet.verfuegbar']);
    const zurueck = await post(`/api/equipment/${geraetId}/status`, { status: 'AVAILABLE' }, { jar: jars.manager });
    assert.equal(zurueck.status, 200, zurueck.text);
  });

  it('Gerät: „Zuteilen" bringt die aktiven Personen mit, geht über den bestehenden Endpunkt, danach „Zurücknehmen"', async (t) => {
    const code = data(await etikett('EQUIPMENT', geraetId, jars.manager)).inhalt;
    const vorher = data(await aufloesen(code, jars.manager)).treffer[0]!;
    const zuteilen = vorher.aktionen.find((a) => a.schluessel === 'geraet.zuteilen');
    assert.ok(zuteilen, JSON.stringify(vorher.aktionen));
    const person = zuteilen.optionen?.[0];
    if (!person) return t.skip('kein aktives Personal im Demobestand');
    // Der Scan allein teilt nichts zu.
    const db = testDb();
    if (db) assert.equal((await db.equipment.findUniqueOrThrow({ where: { id: geraetId } })).assignedEmployeeId, null);

    // Mitarbeitende: dasselbe Etikett ist für sie leer wie ein unbekanntes, und
    // der Endpunkt weist die Zuteilung trotz bekannter ID ab.
    const leer = data(await aufloesen(code, jars.employee));
    assert.deepEqual(leer.treffer, []);
    assert.equal(leer.hinweis, data(await aufloesen('CLX1:ZZZZZZZZZZZZZZZZZZZZ', jars.employee)).hinweis);
    assert.equal((await post(`/api/equipment/${geraetId}/assign`, { employeeId: person.value }, { jar: jars.employee })).status, 403);

    const zugeteilt = await post(`/api/equipment/${geraetId}/assign`, { employeeId: person.value }, { jar: jars.manager });
    assert.equal(zugeteilt.status, 200, zugeteilt.text);
    const nachher = data(await aufloesen(code, jars.manager)).treffer[0]!;
    assert.deepEqual(nachher.aktionen.map((a) => a.schluessel), ['geraet.wartung', 'geraet.defekt', 'geraet.zuruecknehmen']);

    const zurueck = await post(`/api/equipment/${geraetId}/assign`, { employeeId: null }, { jar: jars.manager });
    assert.equal(zurueck.status, 200, zurueck.text);
    if (db) {
      const eintrag = await db.auditLog.findFirst({ where: { entity: 'Equipment', entityId: geraetId, summary: { contains: 'zugeteilt' } } });
      assert.ok(eintrag, 'Die Zuteilung steht nicht im Protokoll');
    }
  });

  it('die Schnellaktion prüft der Endpunkt erneut: Mitarbeitende können nicht buchen, auch mit bekannter ID', async () => {
    const r = await post(`/api/materials/${materialId}/movements`, { kind: 'RECEIPT', quantity: 1 }, { jar: jars.employee });
    assert.equal(r.status, 403);
  });

  it('Scan → Treffer → Wareneingang → Bestand und Protokoll', async (t) => {
    const code = data(await etikett('MATERIAL', materialId, jars.manager)).inhalt;
    const vorher = data(await aufloesen(code, jars.manager)).treffer[0]!;
    assert.ok(vorher.aktionen.some((a) => a.schluessel === 'material.eingang'));
    const buchung = await post<{ data: { id: string } }>(`/api/materials/${materialId}/movements`, { kind: 'RECEIPT', quantity: 12, reference: `LS-${RUN}` }, { jar: jars.manager });
    assert.equal(buchung.status, 201, buchung.text);
    const nachher = data(await aufloesen(code, jars.manager)) as unknown as { treffer: { merkmale: { label: string; wert: string }[] }[] };
    assert.ok(nachher.treffer[0]!.merkmale.some((m) => m.label === 'Bestand' && m.wert.startsWith('12')), JSON.stringify(nachher));
    const db = testDb();
    if (!db) return t.skip('keine Testdatenbank');
    const eintrag = await db.auditLog.findFirst({ where: { entity: 'StockMovement', entityId: data(buchung).id } });
    assert.ok(eintrag, 'Die Buchung steht nicht im Protokoll');
    assert.equal(eintrag.action, 'CREATE');
  });
});

/*
  Ausbau 2026-09-28: Rechnungen über beide Formen der QR-Referenz, Verträge
  über ihre Nummer. Jede neue Auflösung einmal mit Recht (Treffer) und einmal
  ohne (dieselbe Antwort wie ein unbekannter Code — kein Existenzorakel).
*/
describe('Rechnung: alte und neue QR-Referenz', () => {
  const ENDE = String(RUN).slice(-12);
  /** Bis 2026-09-27: nur die laufende Nummer, mit führenden Nullen. */
  const ALT = qrReferenz(`00000000000000${ENDE}`);
  /** Seit 2026-09-28: Jahr + laufende Nummer (`buildQrReference`). */
  const NEU = qrReferenz(`2026${'0'.repeat(10)}${ENDE}`);
  const rechnungen: { alt: string; neu: string } = { alt: '', neu: '' };

  before(async () => {
    const db = testDb();
    const eigen = await eigeneOrganisationId();
    if (!db || !eigen) return;
    const kunde = await db.customer.findFirst({ where: { organizationId: eigen, deletedAt: null }, select: { id: true } });
    if (!kunde) return;
    const anlegen = (number: string, qrReference: string) =>
      db.invoice.create({
        data: {
          organizationId: eigen,
          number,
          customerId: kunde.id,
          status: 'SENT',
          sentAt: new Date(),
          issueDate: new Date(),
          dueDate: new Date(Date.now() + 30 * 86_400_000),
          billToName: 'Scanprüfung',
          billToStreet: 'Prüfweg 1',
          billToZip: '3000',
          billToCity: 'Bern',
          qrReference,
        },
        select: { id: true },
      });
    rechnungen.alt = (await anlegen(`SCAN-RE-A-${RUN}`, ALT)).id;
    rechnungen.neu = (await anlegen(`SCAN-RE-N-${RUN}`, NEU)).id;
  });

  it('beide Formen sind gültige Referenzen und unterscheiden sich', () => {
    assert.ok(ALT.startsWith('000000'));
    assert.ok(NEU.startsWith('2026'));
    assert.notEqual(ALT, NEU);
  });

  it('die nackte Referenz — alt wie neu — findet genau ihre Rechnung, mit PDF und „Zahlung erfassen"', async (t) => {
    if (!rechnungen.alt) return t.skip('keine Testdatenbank');
    for (const [referenz, id] of [[ALT, rechnungen.alt], [NEU, rechnungen.neu]] as const) {
      const r = data(await aufloesen(referenz, jars.admin));
      assert.equal(r.eingabe.art, 'QR_REFERENZ', referenz);
      assert.deepEqual(r.treffer.map((x) => x.id), [id], referenz);
      assert.deepEqual(r.treffer[0]!.aktionen.map((a) => a.schluessel), ['rechnung.zahlung']);
      assert.deepEqual(r.treffer[0]!.verweise, [{ label: 'PDF', href: `/api/invoices/${id}/pdf`, art: 'datei' }]);
    }
  });

  it('der Zahlteil einer QR-Rechnung — alt wie neu — findet dieselbe Rechnung', async (t) => {
    if (!rechnungen.alt) return t.skip('keine Testdatenbank');
    assert.deepEqual(data(await aufloesen(qrRechnungText(ALT), jars.admin)).treffer.map((x) => x.id), [rechnungen.alt]);
    assert.deepEqual(data(await aufloesen(qrRechnungText(NEU), jars.admin)).treffer.map((x) => x.id), [rechnungen.neu]);
  });

  it('Mitarbeitende: dieselbe Antwort wie für eine Referenz, zu der es keine Rechnung gibt — und das PDF bleibt verschlossen', async (t) => {
    if (!rechnungen.alt) return t.skip('keine Testdatenbank');
    const unbekannt = data(await aufloesen(qrReferenz(`9999${'0'.repeat(10)}${ENDE}`), jars.employee));
    for (const referenz of [ALT, NEU]) {
      const r = data(await aufloesen(referenz, jars.employee));
      assert.deepEqual(r.treffer, [], referenz);
      assert.equal(r.hinweis, unbekannt.hinweis, referenz);
    }
    assert.equal((await get(`/api/invoices/${rechnungen.alt}/pdf`, { jar: jars.employee })).status, 403);
  });
});

describe('Vertrag über die Nummer', () => {
  const NUMMER = `SCAN-VT-${RUN}`;
  let vertragId = '';

  before(async () => {
    const db = testDb();
    const eigen = await eigeneOrganisationId();
    if (!db || !eigen) return;
    const kunde = await db.customer.findFirst({ where: { organizationId: eigen, deletedAt: null }, select: { id: true } });
    if (!kunde) return;
    vertragId = (
      await db.contract.create({
        data: { organizationId: eigen, number: NUMMER, customerId: kunde.id, title: 'Scanprüfung Unterhaltsreinigung', status: 'ACTIVE', startDate: new Date('2026-01-01') },
        select: { id: true },
      })
    ).id;
    // Dieselbe Nummer in der fremden Organisation: Sie darf nie erscheinen.
    const fremd = await fremdeOrganisation();
    if (fremd) {
      const fremdeKundschaft = await db.customer.findFirst({ where: { organizationId: fremd }, select: { id: true } });
      if (fremdeKundschaft) {
        await db.contract.create({
          data: { organizationId: fremd, number: `SCAN-VT-F-${RUN}`, customerId: fremdeKundschaft.id, title: 'Fremder Vertrag', status: 'ACTIVE', startDate: new Date('2026-01-01') },
        });
      }
    }
  });

  it('Administration und Betriebsleitung finden den Vertrag, mit Link auf die Vertragsseite, ohne Schnellaktion', async (t) => {
    if (!vertragId) return t.skip('keine Testdatenbank');
    for (const jar of [jars.admin, jars.manager]) {
      const r = data(await aufloesen(NUMMER, jar));
      const treffer = r.treffer.find((x) => x.art === 'VERTRAG');
      assert.ok(treffer, JSON.stringify(r));
      assert.equal(treffer.id, vertragId);
      assert.equal(treffer.link, `/admin/vertraege/${vertragId}`);
      assert.deepEqual(treffer.aktionen, []);
    }
    // Genau — kein Teilwort.
    assert.deepEqual(data(await aufloesen(NUMMER.slice(0, -1), jars.admin)).treffer.filter((x) => x.art === 'VERTRAG'), []);
  });

  it('Mitarbeitende: dieselbe Antwort wie eine unbekannte Nummer', async (t) => {
    if (!vertragId) return t.skip('keine Testdatenbank');
    const r = data(await aufloesen(NUMMER, jars.employee));
    const unbekannt = data(await aufloesen(`SCAN-VT-GIBTESNICHT-${RUN}`, jars.employee));
    assert.deepEqual(r.treffer, []);
    assert.equal(r.hinweis, unbekannt.hinweis);
  });

  it('die Nummer eines Vertrags der fremden Organisation löst nichts auf', async () => {
    assert.deepEqual(data(await aufloesen(`SCAN-VT-F-${RUN}`, jars.super)).treffer, []);
  });
});

describe('Kontingent', () => {
  it('mehr als 60 Scans pro Minute: 429 — und nur für diese Person', async (t) => {
    if (!rateLimitResetAvailable()) return t.skip('Zähler nicht zurücksetzbar');
    resetRateLimits();
    let erstes429 = 0;
    for (let i = 1; i <= 61; i += 1) {
      const r = await call('POST', '/api/scan/resolve', { jar: jars.admin, body: { text: `NICHTS-${i}` }, retries: 0 });
      if (r.status === 429) {
        erstes429 = i;
        break;
      }
    }
    assert.equal(erstes429, 61);
    // Das Kontingent hängt an der Person, nicht an der Adresse.
    assert.equal((await aufloesen('NICHTS', jars.manager)).status, 200);
    resetRateLimits();
  });
});
