import { strict as assert } from 'node:assert';
import { createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { after, before, describe, it } from 'node:test';

import { PDFDocument, PDFString, StandardFonts } from 'pdf-lib';
import { hash as argon2Hash } from '@node-rs/argon2';
import { SignJWT } from 'jose';

import { BASE_URL, data, get, post } from '../helpers/client.js';
import { loginAll } from '../helpers/accounts.js';
import { testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb.js';

/**
 * Elektronische Unterzeichnung (Gate 4B) — der ganze Weg über HTTP.
 *
 * **Was hier bewiesen wird, und warum so.** Der Befund aus Gate 4A: Die
 * bisherige Signatur hing an veränderlichen Daten, der Link stand in der
 * Adresse, die IP war eine Behauptung des Absenders, und nichts war
 * unveränderlich. Diese Reihe fährt jeden dieser Punkte von aussen an:
 *
 *  • Der Vorgang bindet **Bytes**: Hash A ist der SHA-256 der hochgeladenen
 *    Datei; werden die gespeicherten Bytes verändert, scheitert der
 *    Abschluss mit 422 und einem `INTEGRITY_FAILED`-Ereignis.
 *  • Der rohe Token erreicht den Server einmal, im Körper. Keine Antwort
 *    und keine Adresse trägt je einen 64-Hex-Wert.
 *  • Der Code wird als Argon2id-Hash gespeichert, Versuche werden gezählt,
 *    ein neuer Code entwertet den alten, ein bestätigter gilt nie zweimal.
 *  • Vier gleichzeitige Abschlüsse ergeben genau einen.
 *  • Ereignisse lassen sich in der Datenbank weder ändern noch löschen —
 *    das prüft der Trigger, nicht nur der Dienst.
 *
 * **Woher die rohen Tokens kommen.** Der Versand legt nur den Hash ab und
 * schickt den Rohwert per E-Mail. Wie in `oeffentlicher-zugang.test.ts`
 * wird deshalb geprüft, *dass* der Versand einen Token des richtigen Zwecks
 * ausgestellt hat; der Weg selbst wird mit einem Token gefahren, den die
 * Prüfung mit bekanntem Rohwert in die Testdatenbank legt.
 *
 * **Woher der richtige Code kommt.** Auch der steht nur in der E-Mail. Die
 * Prüfung rechnet den Hash nach — HKDF aus `JWT_SECRET`/`ENCRYPTION_KEY`,
 * HMAC, Argon2id — und schreibt ihn in die Challenge. Das ist zugleich die
 * Prüfung, dass das Speicherformat dem Entwurf entspricht. Die Schlüssel
 * kommen aus der Umgebung oder aus `.env`; sie werden nie ausgegeben.
 *
 * **Rate-Limits.** Der Tausch ist auf 20 je 10 Minuten und Adresse
 * begrenzt — und ohne `TRUSTED_PROXY_MODE` teilen sich alle Aufrufer eine
 * Adresse. Die Fälle, die nicht den Tausch selbst prüfen, bauen ihre Sitzung
 * deshalb direkt (derselbe Schlüssel, dieselben Ansprüche wie
 * `signature-session.ts`); nur rund ein Dutzend Fälle tauschen wirklich.
 * Wer Tauschfälle hinzufügt, zählt mit — der Klient sässe sonst bis zu zehn
 * Minuten aus.
 *
 * Vorgänge bleiben in der Testdatenbank liegen: Ereignisse sind nicht
 * löschbar, und das ist der Punkt. `npm run db:test:setup -- --frisch` räumt.
 */

type Zugaenge = Awaited<ReturnType<typeof loginAll>>;
let jars: Zugaenge;

const db = testDb();
const ohneDb = { skip: db ? false : `Keine Testdatenbank: ${testDbGrund()}` };

// ---------------------------------------------------------------------------
//  Werkzeuge
// ---------------------------------------------------------------------------

/** Ein Wert aus der Umgebung oder aus `.env` — nie ausgegeben. */
function envWert(name: string): string | null {
  const direkt = process.env[name]?.trim();
  if (direkt) return direkt;
  try {
    const datei = readFileSync(join(__dirname, '..', '..', '.env'), 'utf8');
    for (const zeile of datei.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(zeile);
      if (!m || m[1] !== name) continue;
      return m[2]!.replace(/^["']|["']$/g, '').trim() || null;
    }
  } catch {
    // keine .env — dann eben nicht
  }
  return null;
}

/** Der Wurzelschlüssel wie in `src/lib/crypto.ts` — oder `null` ohne Schlüssel. */
function wurzelschluessel(): Buffer | null {
  const enc = envWert('ENCRYPTION_KEY');
  const jwt = envWert('JWT_SECRET');
  if (enc && /^[0-9a-fA-F]{64}$/.test(enc)) return Buffer.from(enc, 'hex');
  if (jwt) return Buffer.from(hkdfSync('sha256', jwt, 'clenaris-feldverschluesselung', 'aes-256-gcm-v1', 32));
  return null;
}

const abgeleitet = (wurzel: Buffer, kontext: string) => Buffer.from(hkdfSync('sha256', wurzel, 'clenaris-abgeleitet', kontext, 32));

/** Derselbe Weg wie `signature-otp.ts`, nachgerechnet. */
async function otpHashNachrechnen(challengeId: string, code: string): Promise<string | null> {
  const wurzel = wurzelschluessel();
  if (!wurzel) return null;
  const hmac = createHmac('sha256', abgeleitet(wurzel, 'clenaris-signature-otp-v1')).update(`${challengeId}:${code}`).digest('hex');
  return argon2Hash(hmac, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });
}

/** Eine Sitzung wie `issueSignatureSession` — als fertiger `cookie`-Kopf, oder `null` ohne Schlüssel. */
async function sitzungBauen(params: { scope: 'sign' | 'result'; requestId: string; participantId: string; tokenId: string }): Promise<string | null> {
  const wurzel = wurzelschluessel();
  if (!wurzel) return null;
  const token = await new SignJWT({ typ: 'sig', scope: params.scope, req: params.requestId, part: params.participantId, tok: params.tokenId })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(randomBytes(16).toString('hex'))
    .setIssuedAt()
    .setExpirationTime('60m')
    .sign(new Uint8Array(abgeleitet(wurzel, 'clenaris-signature-session-v1')));
  return `clenaris_sig=${token}`;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Ein echtes, minimales PDF — pdf-lib muss es laden können. */
async function pdfErzeugen(text: string, opts: { sigStruktur?: boolean; sigFeld?: boolean } = {}): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 56, y: 780, size: 14, font });
  page.drawText(`Zufall ${randomBytes(6).toString('hex')}`, { x: 56, y: 760, size: 9, font });
  if (opts.sigStruktur) {
    // Ein Wörterbuch, wie es eine kryptografische Signatur anlegt — ohne Signatur.
    doc.context.register(doc.context.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite', ByteRange: [0, 0, 0, 0] }));
  }
  if (opts.sigFeld) {
    const feld = doc.context.register(
      doc.context.obj({ FT: 'Sig', T: PDFString.of('Unterschrift1'), Type: 'Annot', Subtype: 'Widget', Rect: [0, 0, 0, 0], F: 4, P: page.ref }),
    );
    page.node.addAnnot(feld);
    // `getForm()` legt das AcroForm im Katalog an, falls es fehlt.
    doc.getForm().acroForm.addField(feld);
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/** Ein echtes PNG (RGBA, einfarbig) — pdf-lib muss es einbetten können. */
function pngErzeugen(width = 300, height = 100): Buffer {
  const chunk = (typ: string, daten: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(daten.length);
    const typDaten = Buffer.concat([Buffer.from(typ, 'latin1'), daten]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typDaten) >>> 0);
    return Buffer.concat([len, typDaten, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // Bittiefe
  ihdr[9] = 6; // RGBA
  const zeilen: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const zeile = Buffer.alloc(1 + width * 4, 0);
    for (let x = 0; x < width; x++) {
      // Eine „Linie" in der Mitte, sonst transparent.
      const auf = Math.abs(y - height / 2) < 3;
      zeile[1 + x * 4] = 15;
      zeile[2 + x * 4] = 23;
      zeile[3 + x * 4] = 42;
      zeile[4 + x * 4] = auf ? 255 : 0;
    }
    zeilen.push(zeile);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(zeilen))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const pngDataUrl = () => `data:image/png;base64,${pngErzeugen().toString('base64')}`;

interface Ticket {
  ticketId: string;
  signedUrl: string;
}
interface Abschluss {
  id: string;
  checksum: string;
}

/** Upload wie in `datei-integritaet.test.ts`: Ticket, Bytes, Abschluss. */
async function hochladen(bytes: Buffer, filename: string): Promise<Abschluss> {
  const ticket = await post<{ data: Ticket }>(
    '/api/files/upload-url',
    { profile: 'document', filename, mimeType: 'application/pdf', sizeBytes: bytes.byteLength },
    { jar: jars.admin },
  );
  assert.equal(ticket.status, 201, ticket.text);
  const pfad = `${BASE_URL}${new URL(data(ticket).signedUrl, BASE_URL).pathname}`;
  const upload = await fetch(pfad, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: new Uint8Array(bytes) });
  assert.equal(upload.status, 200);
  const abschluss = await post<{ data: Abschluss }>('/api/files/finalize', { ticketId: data(ticket).ticketId, filename }, { jar: jars.admin });
  assert.equal(abschluss.status, 201, abschluss.text);
  return data(abschluss);
}

async function dokumentAnlegen(fileId: string, title: string): Promise<string> {
  const antwort = await post<{ data: { id: string } }>('/api/bi/documents', { title, category: 'OTHER', fileId }, { jar: jars.admin });
  assert.equal(antwort.status, 201, antwort.text);
  return data(antwort).id;
}

interface Vorgang {
  id: string;
  publicId: string;
  status: string;
}

interface VorgangAdmin {
  id: string;
  publicId: string;
  organizationId: string;
  status: string;
  artifactMode: string;
  originalArtifactId: string;
  originalDocumentHash: string;
  signedArtifactId: string | null;
  signedArtifactHash: string | null;
  evidenceArtifactId: string | null;
  evidenceArtifactHash: string | null;
  participants: {
    id: string;
    status: string;
    signedName: string | null;
    signatureMethod: string | null;
    consentTextSnapshot: string | null;
    consentTextHash: string | null;
    consentVersion: string | null;
    ipAddress: string | null;
    ipSource: string | null;
    authenticationMethod: string | null;
  }[];
  events: { type: string; details: Record<string, unknown> | null }[];
}

async function vorgangAnlegen(documentId: string, body: Record<string, unknown> = {}, jar = jars.admin) {
  return post<{ data: Vorgang }>(
    `/api/bi/documents/${documentId}/signature-requests`,
    { participants: [{ name: 'Prüf Person', email: 'pruef.person@example.ch' }], ...body },
    { jar },
  );
}

async function vorgangLesen(id: string): Promise<VorgangAdmin> {
  const antwort = await get<{ data: VorgangAdmin }>(`/api/signatures/${id}`, { jar: jars.admin });
  assert.equal(antwort.status, 200, antwort.text);
  return data(antwort);
}

/** Token mit bekanntem Rohwert — das Werkzeug, nicht der Versand. */
async function tokenMitId(params: { organizationId: string; purpose: string; resourceId: string; expiresAt?: Date; revoked?: boolean }) {
  if (!db) throw new Error('keine Testdatenbank');
  const raw = randomBytes(32).toString('hex');
  const record = await db.publicAccessToken.create({
    data: {
      organizationId: params.organizationId,
      tokenHash: sha256(Buffer.from(raw)),
      purpose: params.purpose as never,
      resourceId: params.resourceId,
      expiresAt: params.expiresAt ?? new Date(Date.now() + 86_400_000),
      revokedAt: params.revoked ? new Date() : null,
    },
    select: { id: true },
  });
  return { raw, id: record.id };
}

const tokenAnlegen = async (params: Parameters<typeof tokenMitId>[0]) => (await tokenMitId(params)).raw;

interface Tausch {
  publicId: string;
  scope: 'sign' | 'result';
  expiresAt: string;
}

/** Tausch: roher Token im Körper → Sitzungs-Cookie + nicht geheime Kennung. */
async function tauschen(raw: string) {
  const antwort = await post<{ data: Tausch }>('/api/public/signatures/exchange', { token: raw });
  return { antwort, jar: antwort.cookies, publicId: antwort.status === 200 ? data(antwort).publicId : null };
}

/**
 * Anlegen, Token legen, Sitzung bauen — der Standardweg für die meisten
 * Fälle. Getauscht wird nur, wenn kein Schlüssel vorliegt (oder der Fall es
 * ausdrücklich will, `tauschen: true`); siehe Kopfkommentar zum Limit.
 */
async function bereit(documentId: string, body: Record<string, unknown> = {}, opts: { tauschen?: boolean } = {}) {
  const angelegt = await vorgangAnlegen(documentId, body);
  assert.equal(angelegt.status, 201, angelegt.text);
  const vorgang = data(angelegt);
  const admin = await vorgangLesen(vorgang.id);
  const teilnehmer = admin.participants[0]!;
  const token = await tokenMitId({ organizationId: admin.organizationId, purpose: 'SIGNATURE_ACCESS', resourceId: teilnehmer.id });
  let jar = opts.tauschen ? null : await sitzungBauen({ scope: 'sign', requestId: vorgang.id, participantId: teilnehmer.id, tokenId: token.id });
  if (!jar) {
    const t = await tauschen(token.raw);
    assert.equal(t.antwort.status, 200, t.antwort.text);
    assert.equal(t.publicId, vorgang.publicId);
    jar = t.jar;
  }
  return { vorgang, admin, teilnehmer, raw: token.raw, jar, publicId: vorgang.publicId };
}

const abschliessen = (publicId: string, jar: string, body: Record<string, unknown> = {}, headers?: Record<string, string>) =>
  post<{ data: { participantStatus: string; requestStatus: string } }>(
    `/api/public/signatures/${publicId}/complete`,
    { accepted: true, method: 'TYPED', name: 'Prüf Person', ...body },
    { jar, headers },
  );

// ---------------------------------------------------------------------------
//  Vorbereitung
// ---------------------------------------------------------------------------

let originalBytes: Buffer;
let originalHash: string;
let dokumentId: string;

before(async () => {
  jars = await loginAll();
  originalBytes = await pdfErzeugen('Prüfdokument für die Unterzeichnung');
  originalHash = sha256(originalBytes);
  const datei = await hochladen(originalBytes, 'unterzeichnung.pdf');
  assert.equal(datei.checksum, originalHash, 'der Abschluss liefert den SHA-256 der Bytes');
  dokumentId = await dokumentAnlegen(datei.id, `Signaturprüfung ${Date.now()}`);
});

after(async () => {
  await testDbSchliessen();
});

// ---------------------------------------------------------------------------
//  Rechte und Anlegen
// ---------------------------------------------------------------------------

describe('Unterzeichnung — Rechte und Anlegen', () => {
  it('lässt nur Verwaltung Vorgänge anlegen — und nur auf sichtbaren Dokumenten', async () => {
    assert.equal((await vorgangAnlegen(dokumentId, { send: false }, jars.employee)).status, 403);
    assert.equal((await vorgangAnlegen(dokumentId, { send: false }, jars.customer)).status, 403);
    assert.equal((await vorgangAnlegen(dokumentId, { send: false }, '')).status, 401);
    /**
     * Die Betriebsleitung hält `signature:create`, sieht aber keine
     * Führungsdokumente (`document:read` fehlt). Das Recht am Vorgang ersetzt
     * nicht das Recht am Ursprung: 404, nicht 201 — und nicht 403, damit
     * die Existenz des Dokuments nicht durchsickert.
     */
    assert.equal((await vorgangAnlegen(dokumentId, { send: false }, jars.manager)).status, 404);
    const entwurf = await vorgangAnlegen(dokumentId, { send: false });
    assert.equal(entwurf.status, 201, entwurf.text);
    assert.equal(data(entwurf).status, 'DRAFT');
    // Abbrechen darf die Betriebsleitung nicht — die Verwaltung schon.
    assert.equal((await post(`/api/signatures/${data(entwurf).id}/cancel`, {}, { jar: jars.manager })).status, 403);
    assert.equal((await get(`/api/signatures/${data(entwurf).id}`, { jar: jars.employee })).status, 403);
    assert.equal((await post(`/api/signatures/${data(entwurf).id}/cancel`, {}, { jar: jars.admin })).status, 204);
  });

  it('bindet die Bytes der Fassung — Hash A ist der SHA-256 des Uploads', async () => {
    const angelegt = await vorgangAnlegen(dokumentId, { send: false });
    assert.equal(angelegt.status, 201, angelegt.text);
    const admin = await vorgangLesen(data(angelegt).id);
    assert.equal(admin.originalDocumentHash, originalHash);
    assert.equal(admin.artifactMode, 'DETACHED_EVIDENCE', 'Vorgabe für hochgeladene Dokumente');
    assert.equal(admin.status, 'DRAFT');
    const erstellt = admin.events.find((e) => e.type === 'REQUEST_CREATED');
    assert.ok(erstellt, 'Ereignis REQUEST_CREATED');
    assert.equal(erstellt.details?.originalHash, originalHash);
    assert.match(String((erstellt.details?.signatureCheck as { note: string }).note), /keine kryptografische Prüfung/);
  });

  it('stellt beim Versand je Person einen SIGNATURE_ACCESS-Token aus — nur als Hash', ohneDb, async () => {
    const angelegt = await vorgangAnlegen(dokumentId);
    assert.equal(angelegt.status, 201, angelegt.text);
    assert.equal(data(angelegt).status, 'PENDING');
    const admin = await vorgangLesen(data(angelegt).id);
    const token = await db!.publicAccessToken.findFirst({
      where: { purpose: 'SIGNATURE_ACCESS', resourceId: admin.participants[0]!.id, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    assert.ok(token, 'Token für den Teilnehmer');
    assert.match(token.tokenHash, /^[0-9a-f]{64}$/);
    assert.ok(admin.events.some((e) => e.type === 'LINK_ISSUED' && e.details?.tokenId === token.id));
    assert.ok(!JSON.stringify(admin).includes(token.tokenHash), 'nicht einmal der Hash steht in der Verwaltungsantwort');
  });

  it('weist EMBEDDED_VISUAL bei vorhandenen Signaturstrukturen ab, DETACHED nicht', async () => {
    const mitStruktur = await hochladen(await pdfErzeugen('Mit Sig-Struktur', { sigStruktur: true }), 'sig-struktur.pdf');
    const dokStruktur = await dokumentAnlegen(mitStruktur.id, 'Signaturprüfung Struktur');
    const eingebettet = await vorgangAnlegen(dokStruktur, { artifactMode: 'EMBEDDED_VISUAL', send: false });
    assert.equal(eingebettet.status, 422, eingebettet.text);
    assert.match(eingebettet.text, /vorhandene Signatur/);
    const getrennt = await vorgangAnlegen(dokStruktur, { artifactMode: 'DETACHED_EVIDENCE', send: false });
    assert.equal(getrennt.status, 201, getrennt.text);

    const mitFeld = await hochladen(await pdfErzeugen('Mit Sig-Feld', { sigFeld: true }), 'sig-feld.pdf');
    const dokFeld = await dokumentAnlegen(mitFeld.id, 'Signaturprüfung Feld');
    const feld = await vorgangAnlegen(dokFeld, { artifactMode: 'EMBEDDED_VISUAL', send: false });
    assert.equal(feld.status, 422, feld.text);
  });

  it('prüft die Position gegen die tatsächliche Seite', async () => {
    const faelle = [
      ['Seite gibt es nicht', { page: 5, x: 50, y: 50, width: 200, height: 60 }],
      ['ragt über die Seite hinaus', { page: 1, x: 500, y: 50, width: 200, height: 60 }],
      ['zu klein', { page: 1, x: 50, y: 50, width: 10, height: 60 }],
      ['zu gross', { page: 1, x: 0, y: 0, width: 400, height: 60 }],
    ] as const;
    for (const [name, placement] of faelle) {
      const antwort = await vorgangAnlegen(dokumentId, { artifactMode: 'EMBEDDED_VISUAL', placement, send: false });
      assert.ok(antwort.status === 422 || antwort.status === 400, `${name}: ${antwort.status} ${antwort.text}`);
    }
    const ohneEinbettung = await vorgangAnlegen(dokumentId, { artifactMode: 'DETACHED_EVIDENCE', placement: { page: 1, x: 50, y: 50, width: 200, height: 60 }, send: false });
    assert.equal(ohneEinbettung.status, 400, 'eine Position ohne Einbettung ist ein Widerspruch');
  });
});

// ---------------------------------------------------------------------------
//  Tausch, Sitzung, Adresse
// ---------------------------------------------------------------------------

describe('Unterzeichnung — Tausch und Sitzung', () => {
  it('tauscht den rohen Token gegen ein enges Cookie und eine nicht geheime Adresse', ohneDb, async () => {
    const b = await bereit(dokumentId, {}, { tauschen: true });
    const cookieKopf = b.jar;
    assert.match(cookieKopf, /clenaris_sig=/, 'das Sitzungs-Cookie');
    assert.match(b.publicId, /^[0-9a-f]{32}$/, 'die Adresse ist 16 Zufallsbytes — kein Geheimnis');
    assert.ok(!/[0-9a-f]{64}/.test(b.publicId), 'kein 64-Hex-Wert in der Adresse');
    assert.ok(!JSON.stringify(data(await post('/api/public/signatures/exchange', { token: b.raw }))).includes(b.raw), 'der Rohwert kommt nie zurück');
    assert.equal((await get(`/api/public/signatures/${b.publicId}`, { jar: b.jar })).headers.get('cache-control'), 'no-store');

    // Die Ereignisse nennen die Token-Kennung, nie den Wert.
    const admin = await vorgangLesen(b.vorgang.id);
    const text = JSON.stringify(admin);
    assert.ok(!text.includes(b.raw) && !text.includes(sha256(Buffer.from(b.raw))));
    assert.ok(admin.events.some((e) => e.type === 'LINK_EXCHANGED'));
  });

  it('setzt das Cookie HttpOnly, nur für die Signatur-API, SameSite=Lax', ohneDb, async () => {
    const angelegt = await vorgangAnlegen(dokumentId);
    const admin = await vorgangLesen(data(angelegt).id);
    const raw = await tokenAnlegen({ organizationId: admin.organizationId, purpose: 'SIGNATURE_ACCESS', resourceId: admin.participants[0]!.id });
    const antwort = await fetch(`${BASE_URL}/api/public/signatures/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: raw }),
    });
    assert.equal(antwort.status, 200);
    const cookie = antwort.headers.getSetCookie().find((c) => c.startsWith('clenaris_sig='));
    assert.ok(cookie, 'Cookie gesetzt');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Path=\/api\/public\/signatures/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.equal(antwort.headers.get('referrer-policy'), 'no-referrer');
  });

  it('antwortet auf unbekannte, missgebildete, abgelaufene und widerrufene Tokens gleich nichtssagend', ohneDb, async () => {
    const angelegt = await vorgangAnlegen(dokumentId);
    const admin = await vorgangLesen(data(angelegt).id);
    const p = admin.participants[0]!.id;
    const abgelaufen = await tokenAnlegen({ organizationId: admin.organizationId, purpose: 'SIGNATURE_ACCESS', resourceId: p, expiresAt: new Date(Date.now() - 1000) });
    const widerrufen = await tokenAnlegen({ organizationId: admin.organizationId, purpose: 'SIGNATURE_ACCESS', resourceId: p, revoked: true });
    const falscherZweck = await tokenAnlegen({ organizationId: admin.organizationId, purpose: 'QUOTE_VIEW', resourceId: p });

    const unbekannt = await tauschen(randomBytes(32).toString('hex'));
    assert.equal(unbekannt.antwort.status, 404);
    for (const [name, raw] of [['abgelaufen', abgelaufen], ['widerrufen', widerrufen], ['falscher Zweck', falscherZweck]] as const) {
      const t = await tauschen(raw);
      assert.equal(t.antwort.status, 404, `${name}: ${t.antwort.text}`);
      assert.equal(t.jar, '', `${name}: kein Cookie`);
    }
    assert.equal((await tauschen('nicht-hex')).antwort.status, 422, 'missgebildet scheitert an der Validierung');
    assert.equal((await post('/api/public/signatures/exchange', { token: `${sha256(Buffer.from('x'))}` })).status, 404);
  });

  it('gibt ohne Sitzung, mit fremdem Cookie und für den falschen Bereich nichts preis', ohneDb, async () => {
    const b = await bereit(dokumentId, {}, { tauschen: true });
    assert.equal((await get(`/api/public/signatures/${b.publicId}`)).status, 404, 'ohne Cookie');
    assert.equal((await get(`/api/public/signatures/${b.publicId}/document`)).status, 404);
    assert.equal((await get(`/api/public/signatures/${b.publicId}`, { jar: 'clenaris_sig=abc.def.ghi' })).status, 404, 'kaputtes Cookie');
    assert.equal((await get(`/api/public/signatures/${b.publicId}/result`, { jar: b.jar })).status, 404, 'Unterzeichnungssitzung öffnet kein Ergebnis');
    assert.equal((await get(`/api/public/signatures/${'0'.repeat(32)}`, { jar: b.jar })).status, 404, 'Cookie passt nicht zur Adresse');
    assert.equal((await get(`/api/public/signatures/kurz`, { jar: b.jar })).status, 422);
  });

  it('zeigt den Stand mit verschleierten Kontaktdaten und dem Zustimmungstext des Servers', ohneDb, async () => {
    const b = await bereit(dokumentId);
    const stand = await get<{ data: { request: { consent: { text: string; version: string }; documentVersion: number }; participant: { email: string; requiresCode: boolean; status: string } } }>(
      `/api/public/signatures/${b.publicId}`,
      { jar: b.jar },
    );
    assert.equal(stand.status, 200, stand.text);
    const z = data(stand);
    assert.equal(z.participant.email, 'p…n@example.ch');
    assert.equal(z.participant.requiresCode, false);
    assert.equal(z.request.consent.version, 'v1');
    assert.ok(z.request.consent.text.length > 40);
    assert.ok(!/QES|ZertES|qualifiziert/i.test(z.request.consent.text));
    assert.equal(z.request.documentVersion, 1);

    const dokument = await fetch(`${BASE_URL}/api/public/signatures/${b.publicId}/document`, { headers: { cookie: b.jar } });
    assert.equal(dokument.status, 200);
    assert.equal(dokument.headers.get('content-type'), 'application/pdf');
    assert.equal(dokument.headers.get('cache-control'), 'no-store');
    assert.equal(dokument.headers.get('referrer-policy'), 'no-referrer');
    assert.match(dokument.headers.get('content-disposition') ?? '', /^inline/);
    assert.equal(sha256(Buffer.from(await dokument.arrayBuffer())), originalHash, 'geliefert wird genau A');
  });

  it('liefert weiter die gebundene Fassung, wenn eine neue hochgeladen wurde', ohneDb, async () => {
    const zweiteBytes = await pdfErzeugen('Zweite Fassung — nicht die unterzeichnete');
    const eigenesDokument = await dokumentAnlegen((await hochladen(originalBytes, 'fassung-1.pdf')).id, 'Signaturprüfung Fassungen');
    const b = await bereit(eigenesDokument);
    const neu = await post(`/api/bi/documents/${eigenesDokument}/versions`, { fileId: (await hochladen(zweiteBytes, 'fassung-2.pdf')).id }, { jar: jars.admin });
    assert.equal(neu.status, 201, neu.text);

    const geliefert = await fetch(`${BASE_URL}/api/public/signatures/${b.publicId}/document`, { headers: { cookie: b.jar } });
    const bytes = Buffer.from(await geliefert.arrayBuffer());
    assert.equal(sha256(bytes), originalHash, 'Fassung 1 — die gebundenen Bytes');
    assert.notEqual(sha256(bytes), sha256(zweiteBytes));

    const fertig = await abschliessen(b.publicId, b.jar);
    assert.equal(fertig.status, 200, fertig.text);
    assert.equal((await vorgangLesen(b.vorgang.id)).originalDocumentHash, originalHash);
  });
});

// ---------------------------------------------------------------------------
//  Abschluss, Zustimmung, Adresse, Beweiskette
// ---------------------------------------------------------------------------

describe('Unterzeichnung — Abschluss und Beweiskette', () => {
  it('verlangt die Zustimmung als Literal und den Namen; Text und Fassung bestimmt der Server', ohneDb, async () => {
    const b = await bereit(dokumentId);
    assert.equal((await post(`/api/public/signatures/${b.publicId}/complete`, { method: 'TYPED', name: 'Prüf Person' }, { jar: b.jar })).status, 422, 'ohne accepted');
    assert.equal((await abschliessen(b.publicId, b.jar, { accepted: 'ja' })).status, 422);
    assert.equal((await abschliessen(b.publicId, b.jar, { name: 'P' })).status, 422, 'Name zu kurz');
    assert.equal((await abschliessen(b.publicId, b.jar, { method: 'DRAWN' })).status, 422, 'DRAWN ohne Bild');
    assert.equal((await abschliessen(b.publicId, b.jar, { method: 'DRAWN', imageDataUrl: 'data:image/png;base64,QUJD' })).status, 400, 'kein PNG — missgebildete Eingabe');

    const fertig = await abschliessen(b.publicId, b.jar, {}, { 'cf-connecting-ip': '203.0.113.99', 'x-forwarded-for': '203.0.113.99', 'x-real-ip': '203.0.113.99' });
    assert.equal(fertig.status, 200, fertig.text);
    assert.equal(data(fertig).participantStatus, 'SIGNED');
    assert.equal(data(fertig).requestStatus, 'COMPLETED', 'DETACHED: Protokoll reicht zum Abschluss');

    const admin = await vorgangLesen(b.vorgang.id);
    const p = admin.participants[0]!;
    assert.equal(p.status, 'SIGNED');
    assert.equal(p.signatureMethod, 'TYPED');
    assert.equal(p.signedName, 'Prüf Person');
    assert.equal(p.authenticationMethod, 'LINK_ONLY');
    assert.equal(p.consentVersion, 'v1');
    assert.ok(p.consentTextSnapshot && p.consentTextSnapshot.length > 40, 'Wortlaut eingefroren');
    assert.equal(p.consentTextHash, sha256(Buffer.from(p.consentTextSnapshot!, 'utf8')), 'Hash über den exakten Wortlaut');

    // Die Adresse: nur aus einem vertrauenswürdigen Kopf, sonst „nicht verfügbar".
    assert.ok(['UNAVAILABLE', 'NGINX_X_REAL_IP', 'CLOUDFLARE', 'DIRECT'].includes(p.ipSource ?? ''), `ipSource ${p.ipSource}`);
    if (p.ipSource === 'UNAVAILABLE') assert.equal(p.ipAddress, null, 'ohne Proxy-Richtlinie keine erfundene Adresse');
    if ((process.env.TRUSTED_PROXY_MODE ?? 'NONE') === 'NONE') assert.notEqual(p.ipAddress, '203.0.113.99', 'der gefälschte Kopf landet nicht im Protokoll');

    // Beweiskette: A aus den Bytes, C vorhanden und ≠ A, kein B bei DETACHED.
    assert.equal(admin.originalDocumentHash, originalHash);
    assert.equal(admin.signedArtifactId, null);
    assert.ok(admin.evidenceArtifactId && admin.evidenceArtifactHash, 'Protokoll (C)');
    assert.notEqual(admin.evidenceArtifactHash, admin.originalDocumentHash);
    for (const typ of ['CONSENT_ACCEPTED', 'SIGNATURE_SUBMITTED', 'SIGNED', 'FINALIZATION_STARTED', 'ARTIFACT_CREATED', 'REQUEST_COMPLETED', 'RESULT_LINK_ISSUED']) {
      assert.ok(admin.events.some((e) => e.type === typ), `Ereignis ${typ}`);
    }

    const integritaet = await get<{ data: { original: { status: string }; signed: { status: string }; evidence: { status: string } } }>(`/api/signatures/${b.vorgang.id}/integrity`, { jar: jars.admin });
    assert.equal(integritaet.status, 200, integritaet.text);
    assert.deepEqual(
      { o: data(integritaet).original.status, s: data(integritaet).signed.status, e: data(integritaet).evidence.status },
      { o: 'ok', s: 'nicht_vorgesehen', e: 'ok' },
    );

    // Zweiter Abschluss: kein zweites Mal.
    assert.equal((await abschliessen(b.publicId, b.jar)).status, 422);
    // Abgeschlossen lässt sich nicht abbrechen.
    assert.equal((await post(`/api/signatures/${b.vorgang.id}/cancel`, {}, { jar: jars.admin })).status, 422);
  });

  it('bettet bei EMBEDDED_VISUAL die gezeichnete Unterschrift ein und hängt eine Signaturseite an (B ≠ A)', ohneDb, async () => {
    const b = await bereit(dokumentId, { artifactMode: 'EMBEDDED_VISUAL', placement: { page: 1, x: 56, y: 100, width: 220, height: 70 } });
    const fertig = await abschliessen(b.publicId, b.jar, { method: 'DRAWN', imageDataUrl: pngDataUrl() });
    assert.equal(fertig.status, 200, fertig.text);
    assert.equal(data(fertig).requestStatus, 'COMPLETED');

    const admin = await vorgangLesen(b.vorgang.id);
    assert.ok(admin.signedArtifactId && admin.signedArtifactHash, 'signiertes Artefakt (B)');
    assert.notEqual(admin.signedArtifactHash, admin.originalDocumentHash, 'B ≠ A');
    assert.notEqual(admin.evidenceArtifactHash, admin.signedArtifactHash, 'C ≠ B');
    assert.equal(admin.participants[0]!.signatureMethod, 'DRAWN');
    assert.ok(admin.events.some((e) => e.type === 'ARTIFACT_CREATED' && e.details?.kind === 'signed'));

    const integritaet = await get<{ data: { original: { status: string }; signed: { status: string }; evidence: { status: string } } }>(`/api/signatures/${b.vorgang.id}/integrity`, { jar: jars.admin });
    assert.deepEqual([data(integritaet).original.status, data(integritaet).signed.status, data(integritaet).evidence.status], ['ok', 'ok', 'ok']);

    // Über einen Ergebnislink: das signierte Dokument hat eine Seite mehr als das Original.
    const rawErgebnis = await tokenAnlegen({ organizationId: admin.organizationId, purpose: 'SIGNATURE_RESULT_VIEW', resourceId: admin.participants[0]!.id });
    const t = await tauschen(rawErgebnis);
    assert.equal(t.antwort.status, 200, t.antwort.text);
    assert.equal(data(t.antwort).scope, 'result');
    const signiert = await fetch(`${BASE_URL}/api/public/signatures/${b.publicId}/result/signed`, { headers: { cookie: t.jar } });
    assert.equal(signiert.status, 200);
    const bytes = Buffer.from(await signiert.arrayBuffer());
    assert.equal(sha256(bytes), admin.signedArtifactHash, 'geliefert wird genau B');
    const doc = await PDFDocument.load(bytes);
    assert.equal(doc.getPageCount(), 2, 'Original (1) + Signaturseite');
    const original = await fetch(`${BASE_URL}/api/public/signatures/${b.publicId}/result/original`, { headers: { cookie: t.jar } });
    assert.equal(sha256(Buffer.from(await original.arrayBuffer())), originalHash, 'das Original ist bytegenau unverändert');
  });

  it('bricht ab, wenn die gespeicherten Originalbytes nicht mehr zu Hash A passen', ohneDb, async () => {
    const eigenesDokument = await dokumentAnlegen((await hochladen(await pdfErzeugen('Wird manipuliert'), 'manipuliert.pdf')).id, 'Signaturprüfung Manipulation');
    const b = await bereit(eigenesDokument);
    const asset = await db!.fileAsset.findUnique({ where: { id: b.admin.originalArtifactId }, include: { storedFile: true } });
    assert.ok(asset?.storedFile?.data, 'die Bytes liegen im eingebauten Speicher — sonst lässt sich der Fall hier nicht herstellen');
    const unversehrt = Buffer.from(asset.storedFile.data);

    await db!.storedFile.update({ where: { id: asset.storedFile.id }, data: { data: Buffer.concat([unversehrt, Buffer.from(' ')]) } });
    try {
      const versuch = await abschliessen(b.publicId, b.jar);
      assert.equal(versuch.status, 422, versuch.text);
      assert.match(versuch.text, /stimmt nicht mehr/);
      const admin = await vorgangLesen(b.vorgang.id);
      assert.equal(admin.status, 'PENDING', 'kein Abschluss');
      assert.equal(admin.participants[0]!.status, 'PENDING');
      assert.equal(admin.evidenceArtifactId, null);
      const ereignis = admin.events.find((e) => e.type === 'INTEGRITY_FAILED');
      assert.ok(ereignis, 'INTEGRITY_FAILED protokolliert');
      assert.equal(ereignis.details?.expected, b.admin.originalDocumentHash);
      assert.notEqual(ereignis.details?.actual, b.admin.originalDocumentHash);
      const integritaet = await get<{ data: { original: { status: string } } }>(`/api/signatures/${b.vorgang.id}/integrity`, { jar: jars.admin });
      assert.equal(data(integritaet).original.status, 'abweichung');
    } finally {
      await db!.storedFile.update({ where: { id: asset.storedFile.id }, data: { data: unversehrt } });
    }
    const danach = await abschliessen(b.publicId, b.jar);
    assert.equal(danach.status, 200, `nach Wiederherstellung: ${danach.text}`);
  });

  it('ergibt bei vier gleichzeitigen Abschlüssen genau einen', ohneDb, async () => {
    const b = await bereit(dokumentId);
    const antworten = await Promise.all([1, 2, 3, 4].map(() => abschliessen(b.publicId, b.jar)));
    const codes = antworten.map((a) => a.status).sort();
    assert.equal(codes.filter((c) => c === 200).length, 1, `Statuscodes: ${codes.join(', ')}`);
    assert.equal(codes.filter((c) => c === 422).length, 3);
    const admin = await vorgangLesen(b.vorgang.id);
    assert.equal(admin.events.filter((e) => e.type === 'SIGNED').length, 1, 'genau ein SIGNED');
    assert.equal(admin.events.filter((e) => e.type === 'REQUEST_COMPLETED').length, 1);
    assert.equal(admin.events.filter((e) => e.type === 'ARTIFACT_CREATED').length, 1, 'genau ein Protokoll');
  });

  it('lässt Ereignisse in der Datenbank weder ändern noch löschen', ohneDb, async () => {
    const angelegt = await vorgangAnlegen(dokumentId, { send: false });
    const id = data(angelegt).id;
    const ereignisse = await db!.signatureEvent.findMany({ where: { requestId: id } });
    assert.ok(ereignisse.length >= 1);
    const verweigert = /nie geändert oder gelöscht|P0001/;
    await assert.rejects(db!.signatureEvent.update({ where: { id: ereignisse[0]!.id }, data: { type: 'SIGNED' } }), verweigert);
    await assert.rejects(db!.signatureEvent.deleteMany({ where: { requestId: id } }), verweigert);
    await assert.rejects(db!.$executeRawUnsafe('TRUNCATE TABLE signature_events'), verweigert);
    assert.equal((await db!.signatureEvent.count({ where: { requestId: id } })), ereignisse.length);
    // Und der Vorgang selbst ist damit ebenfalls nicht löschbar (Restrict).
    await assert.rejects(db!.signatureRequest.delete({ where: { id } }));
  });
});

// ---------------------------------------------------------------------------
//  Code, Ablehnen, Abbrechen, Ergebnis, Nachtlauf
// ---------------------------------------------------------------------------

describe('Unterzeichnung — Bestätigungscode', () => {
  it('speichert nur einen Argon2id-Hash, zählt Versuche, sperrt den Neuversand und gilt einmal', ohneDb, async () => {
    const b = await bereit(dokumentId, { assuranceLevel: 'LINK_PLUS_EMAIL_CODE' });
    assert.equal((await abschliessen(b.publicId, b.jar)).status, 422, 'ohne bestätigten Code kein Abschluss');

    const angefordert = await post<{ data: { channel: string; sentTo: string } }>(`/api/public/signatures/${b.publicId}/otp/request`, {}, { jar: b.jar });
    assert.equal(angefordert.status, 200, angefordert.text);
    assert.equal(data(angefordert).channel, 'EMAIL');
    assert.equal(data(angefordert).sentTo, 'p…n@example.ch');
    assert.equal((await post(`/api/public/signatures/${b.publicId}/otp/request`, {}, { jar: b.jar })).status, 422, 'Neuversand innerhalb von 60 s');

    const challenge = await db!.signatureOtpChallenge.findFirst({ where: { participantId: b.teilnehmer.id }, orderBy: { createdAt: 'desc' } });
    assert.ok(challenge);
    assert.match(challenge.codeHash, /^\$argon2id\$/, 'Argon2id, nicht SHA-256, nicht Klartext');
    assert.equal(challenge.maxAttempts, 5);
    assert.ok(challenge.expiresAt.getTime() - Date.now() <= 10 * 60 * 1000 + 5000);

    for (let i = 1; i <= 5; i++) {
      const falsch = await post(`/api/public/signatures/${b.publicId}/otp/verify`, { code: String(100000 + i) }, { jar: b.jar });
      assert.equal(falsch.status, 422, `Versuch ${i}: ${falsch.text}`);
    }
    const danach = await db!.signatureOtpChallenge.findUniqueOrThrow({ where: { id: challenge.id } });
    assert.equal(danach.attempts, 5, 'jeder Versuch gezählt');
    assert.equal((await post(`/api/public/signatures/${b.publicId}/otp/verify`, { code: '100001' }, { jar: b.jar })).status, 422, 'erschöpft');
    assert.equal((await post(`/api/public/signatures/${b.publicId}/otp/verify`, { code: '12' }, { jar: b.jar })).status, 422, 'Format');

    const admin = await vorgangLesen(b.vorgang.id);
    assert.ok(admin.events.some((e) => e.type === 'OTP_REQUESTED'));
    assert.ok(admin.events.filter((e) => e.type === 'OTP_FAILED').length >= 5);
    assert.ok(!JSON.stringify(admin).includes(challenge.codeHash), 'der Hash steht in keiner Antwort');
  });

  it('bestätigt den richtigen Code genau einmal und gibt den Abschluss frei', ohneDb, async () => {
    const b = await bereit(dokumentId, { assuranceLevel: 'LINK_PLUS_EMAIL_CODE' });
    const angefordert = await post(`/api/public/signatures/${b.publicId}/otp/request`, {}, { jar: b.jar });
    assert.equal(angefordert.status, 200, angefordert.text);
    const challenge = await db!.signatureOtpChallenge.findFirstOrThrow({ where: { participantId: b.teilnehmer.id }, orderBy: { createdAt: 'desc' } });

    const nachgerechnet = await otpHashNachrechnen(challenge.id, '424242');
    if (!nachgerechnet) {
      // Ohne Schlüssel lässt sich der richtige Code nicht herstellen — die
      // falschen Fälle oben stehen trotzdem.
      return;
    }
    await db!.signatureOtpChallenge.update({ where: { id: challenge.id }, data: { codeHash: nachgerechnet } });

    assert.equal((await post(`/api/public/signatures/${b.publicId}/otp/verify`, { code: '424241' }, { jar: b.jar })).status, 422);
    const richtig = await post(`/api/public/signatures/${b.publicId}/otp/verify`, { code: '424242' }, { jar: b.jar });
    assert.equal(richtig.status, 200, `stimmt der Schlüssel der Prüfung mit dem des Servers überein? ${richtig.text}`);
    const verbraucht = await db!.signatureOtpChallenge.findUniqueOrThrow({ where: { id: challenge.id } });
    assert.ok(verbraucht.usedAt, 'einmal verwendet');
    assert.equal((await post(`/api/public/signatures/${b.publicId}/otp/request`, {}, { jar: b.jar })).status, 422, 'nach Bestätigung kein neuer Code');

    const fertig = await abschliessen(b.publicId, b.jar);
    assert.equal(fertig.status, 200, fertig.text);
    const admin = await vorgangLesen(b.vorgang.id);
    assert.equal(admin.participants[0]!.authenticationMethod, 'LINK_PLUS_EMAIL_CODE');
    assert.ok(admin.events.some((e) => e.type === 'OTP_VERIFIED'));
  });

  it('verlangt für den SMS-Code eine Mobilnummer — und legt ohne sie nichts an', async () => {
    const vorher = await get<{ data: { id: string }[] }>(`/api/bi/documents/${dokumentId}/signature-requests`, { jar: jars.admin });
    const ohne = await vorgangAnlegen(dokumentId, { assuranceLevel: 'LINK_PLUS_SMS_CODE', send: false });
    assert.equal(ohne.status, 400, ohne.text);
    const nachher = await get<{ data: { id: string }[] }>(`/api/bi/documents/${dokumentId}/signature-requests`, { jar: jars.admin });
    assert.equal(data(nachher).length, data(vorher).length, 'kein halb angelegter Vorgang');
  });
});

describe('Unterzeichnung — Ablehnen, Abbrechen, Ergebnis, Nachtlauf', () => {
  it('Ablehnen ist terminal und widerruft den Link', ohneDb, async () => {
    const b = await bereit(dokumentId);
    const abgelehnt = await post(`/api/public/signatures/${b.publicId}/decline`, { reason: 'Betrag stimmt nicht' }, { jar: b.jar });
    assert.equal(abgelehnt.status, 204, abgelehnt.text);
    // Der Link ist widerrufen — damit ist auch die Sitzung tot: 404, nicht 422.
    assert.equal((await abschliessen(b.publicId, b.jar)).status, 404);
    const admin = await vorgangLesen(b.vorgang.id);
    assert.equal(admin.status, 'DECLINED');
    assert.equal(admin.participants[0]!.status, 'DECLINED');
    assert.ok(admin.events.some((e) => e.type === 'DECLINED' && e.details?.reason === 'Betrag stimmt nicht'));
    assert.equal((await tauschen(b.raw)).antwort.status, 404, 'der Link ist verbraucht');
  });

  it('Abbrechen widerruft Tokens und macht bestehende Sitzungen sofort wertlos', ohneDb, async () => {
    const b = await bereit(dokumentId);
    assert.equal((await get(`/api/public/signatures/${b.publicId}`, { jar: b.jar })).status, 200);
    const abgebrochen = await post(`/api/signatures/${b.vorgang.id}/cancel`, { reason: 'Falsches Dokument' }, { jar: jars.admin });
    assert.equal(abgebrochen.status, 204, abgebrochen.text);
    assert.equal((await get(`/api/public/signatures/${b.publicId}`, { jar: b.jar })).status, 404, 'die Sitzung ist tot, ohne Sitzungstabelle');
    assert.equal((await abschliessen(b.publicId, b.jar)).status, 404);
    assert.equal((await tauschen(b.raw)).antwort.status, 404);
    const admin = await vorgangLesen(b.vorgang.id);
    assert.equal(admin.status, 'CANCELLED');
    assert.equal((await post(`/api/signatures/${b.vorgang.id}/cancel`, {}, { jar: jars.admin })).status, 422, 'zweimal geht nicht');
    assert.equal((await post(`/api/signatures/${b.vorgang.id}/send`, {}, { jar: jars.admin })).status, 422, 'abgebrochen wird nicht mehr versendet');
  });

  it('stellt nach Abschluss einen Ergebnislink mit eigenem Zweck aus, der nur das Ergebnis öffnet', ohneDb, async () => {
    const b = await bereit(dokumentId);
    assert.equal((await abschliessen(b.publicId, b.jar)).status, 200);
    const ergebnisToken = await db!.publicAccessToken.findFirst({ where: { purpose: 'SIGNATURE_RESULT_VIEW', resourceId: b.teilnehmer.id, revokedAt: null } });
    assert.ok(ergebnisToken, 'SIGNATURE_RESULT_VIEW ausgestellt');
    const tage = (ergebnisToken.expiresAt.getTime() - Date.now()) / 86_400_000;
    assert.ok(tage > 29 && tage <= 30.1, `30 Tage, nicht 90: ${tage.toFixed(1)}`);

    const raw = await tokenAnlegen({ organizationId: b.admin.organizationId, purpose: 'SIGNATURE_RESULT_VIEW', resourceId: b.teilnehmer.id });
    const t = await tauschen(raw);
    assert.equal(t.antwort.status, 200, t.antwort.text);
    assert.equal(data(t.antwort).scope, 'result');
    assert.equal((await get(`/api/public/signatures/${b.publicId}`, { jar: t.jar })).status, 404, 'Ergebnissitzung öffnet keinen Unterzeichnungsablauf');
    assert.equal((await abschliessen(b.publicId, t.jar)).status, 404);

    const ergebnis = await get<{ data: { hashes: { original: string; signed: string | null; evidence: string | null }; available: { evidence: boolean; signed: boolean } } }>(`/api/public/signatures/${b.publicId}/result`, { jar: t.jar });
    assert.equal(ergebnis.status, 200, ergebnis.text);
    assert.equal(data(ergebnis).hashes.original, originalHash);
    assert.equal(data(ergebnis).available.signed, false);
    assert.ok(data(ergebnis).available.evidence);
    assert.ok(!/[0-9a-f]{64}/.test(JSON.stringify(data(ergebnis)).replace(/[0-9a-f]{64}/g, (h) => (h === data(ergebnis).hashes.original || h === data(ergebnis).hashes.evidence ? '' : h))), 'nur Prüfsummen, keine Tokens');

    // Binär über `fetch`, nicht über den JSON-Klienten: `text()` dekodiert UTF-8 und verfälscht Bytes.
    const protokoll = await fetch(`${BASE_URL}/api/public/signatures/${b.publicId}/result/evidence`, { headers: { cookie: t.jar } });
    assert.equal(protokoll.status, 200);
    assert.equal(protokoll.headers.get('content-type'), 'application/pdf');
    assert.match(protokoll.headers.get('content-disposition') ?? '', /^attachment/);
    const protokollBytes = Buffer.from(await protokoll.arrayBuffer());
    assert.ok(protokollBytes.subarray(0, 5).toString('latin1') === '%PDF-');
    assert.equal(sha256(protokollBytes), data(ergebnis).hashes.evidence, 'geliefert wird genau C');
    assert.equal((await get(`/api/public/signatures/${b.publicId}/result/signed`, { jar: t.jar })).status, 404, 'kein B bei DETACHED');
    assert.equal((await get(`/api/public/signatures/${b.publicId}/result/evidence`)).status, 404, 'ohne Sitzung nichts');
  });

  it('Nachtlauf: lässt Vorgänge ablaufen und holt ein fehlendes Protokoll idempotent nach', ohneDb, async () => {
    const secret = envWert('CRON_SECRET') ?? 'dev-cron-secret';

    // Ablauf: ein offener Vorgang mit Ablauf in der Vergangenheit.
    const ablauf = await bereit(dokumentId);
    await db!.signatureRequest.update({ where: { id: ablauf.vorgang.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    assert.equal((await abschliessen(ablauf.publicId, ablauf.jar)).status, 422, 'abgelaufen — schon vor dem Nachtlauf');

    // Fehlendes Protokoll: ein abgeschlossener Vorgang, dem das Protokoll „verloren" geht.
    const fertig = await bereit(dokumentId);
    assert.equal((await abschliessen(fertig.publicId, fertig.jar)).status, 200);
    const vorher = await vorgangLesen(fertig.vorgang.id);
    assert.ok(vorher.evidenceArtifactId);
    await db!.signatureRequest.update({ where: { id: fertig.vorgang.id }, data: { evidenceArtifactId: null, evidenceArtifactHash: null } });

    const lauf = await get('/api/cron/daily', { headers: { authorization: `Bearer ${secret}` } });
    assert.equal(lauf.status, 200, `stimmt CRON_SECRET in .env mit dem Test überein? ${lauf.text}`);

    const abgelaufen = await vorgangLesen(ablauf.vorgang.id);
    assert.equal(abgelaufen.status, 'EXPIRED');
    assert.ok(abgelaufen.events.some((e) => e.type === 'EXPIRED'));
    assert.equal((await tauschen(ablauf.raw)).antwort.status, 404, 'Token widerrufen');

    const nachgeholt = await vorgangLesen(fertig.vorgang.id);
    assert.equal(nachgeholt.status, 'COMPLETED');
    assert.ok(nachgeholt.evidenceArtifactId && nachgeholt.evidenceArtifactHash, 'Protokoll nachgeholt');
    /*
      Bis 2026-09-28 stand hier „derselbe Pfad, dasselbe Asset": Das
      Nachholen schrieb die Bytes des verlorenen Protokolls an derselben Stelle
      neu. Genau dieses Überschreiben ist B-16 — ein hängender und ein
      übernehmender Abschluss veränderten so einen Beleg, dessen Hash schon
      eingetragen war. Jetzt legt jeder Versuch eine eigene Datei an; die
      Zusage „kein zweites Protokoll" heisst: genau **eines** ist verknüpft
      (bedingtes Eintragen), und das frühere wurde **nicht** überschrieben.
    */
    const altesAsset = await db!.fileAsset.findUniqueOrThrow({ where: { id: vorher.evidenceArtifactId! }, select: { checksum: true, path: true } });
    assert.equal(altesAsset.checksum, vorher.evidenceArtifactHash, 'das frühere Protokoll wurde überschrieben');
    if (nachgeholt.evidenceArtifactId !== vorher.evidenceArtifactId) {
      const neuesAsset = await db!.fileAsset.findUniqueOrThrow({ where: { id: nachgeholt.evidenceArtifactId }, select: { path: true } });
      assert.notEqual(neuesAsset.path, altesAsset.path, 'zwei Protokolle unter demselben Pfad');
    }
    const integritaet = await get<{ data: { evidence: { status: string } } }>(`/api/signatures/${fertig.vorgang.id}/integrity`, { jar: jars.admin });
    assert.equal(data(integritaet).evidence.status, 'ok');
  });

  it('sperrt die Bereinigung von Aufträgen und Führung, solange Vorgänge existieren', async () => {
    const antwort = await post<{ error: { message: string } }>('/api/system/purge', { bereiche: ['auftraege'], bestaetigung: 'ALLES LÖSCHEN' }, { jar: jars.super });
    assert.equal(antwort.status, 422, antwort.text);
    assert.match(antwort.payload.error.message, /Unterzeichnungsvorg/);
  });
});

// ---------------------------------------------------------------------------
//  Seiten und Wortlaut
// ---------------------------------------------------------------------------

describe('Unterzeichnung — Seiten', () => {
  it('liefert die Tauschseite ohne Referrer, ohne Zwischenspeicher, ohne Fremdskripte, ohne Rechtsbehauptungen', async () => {
    for (const pfad of ['/signieren', '/signieren/ergebnis', `/signieren/s/${'a'.repeat(32)}`, `/signieren/ergebnis/${'b'.repeat(32)}`]) {
      const seite = await get(pfad);
      assert.equal(seite.status, 200, pfad);
      assert.equal(seite.headers.get('referrer-policy'), 'no-referrer', pfad);
      assert.match(seite.headers.get('cache-control') ?? '', /no-store/, pfad);
      assert.match(seite.headers.get('x-robots-tag') ?? '', /noindex/, pfad);
      assert.ok(!/googletagmanager|gtag\(|plausible|umami|matomo|hotjar/i.test(seite.text), `${pfad}: kein Fremdskript`);
      assert.ok(!/ZertES|QES|qualifizierte? elektronische|digital signiert/i.test(seite.text), `${pfad}: Wortlaut`);
    }
    assert.equal((await get('/signieren/s/kurz')).status, 404);
  });
});
