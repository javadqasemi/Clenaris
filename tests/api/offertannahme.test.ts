import { strict as assert } from 'node:assert';
import { createHash, hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { after, before, describe, it } from 'node:test';

import { PDFDocument } from 'pdf-lib';
import { SignJWT } from 'jose';

import { BASE_URL, data, get, patch, post } from '../helpers/client.js';
import { ACCOUNTS, loginAll } from '../helpers/accounts.js';
import { letzteMail, linksIn, mailOutboxAvailable } from '../helpers/mail.js';
import { testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb.js';

/**
 * Offertannahme über den Signaturkern (Gate 4C) — der ganze Weg über HTTP.
 *
 * **Der Befund, den diese Reihe ablöst.** Bis Gate 4B nahm eine Offerte sich
 * selbst an: Ein Klick schickte Name und ein PNG an `respond`, der Dienst
 * setzte ACCEPTED und legte beides in drei Spalten der Offertzeile ab. Was
 * unterschrieben worden war, stand nirgends — die Offerte liess sich danach
 * ändern, und das Bild hing an nichts. Gate 4C trennt das in zwei Schritte:
 *
 *  • `ACCEPT` **entscheidet nicht**. Es friert die Offerte als PDF ein
 *    (Hash A), legt genau einen Unterzeichnungsvorgang an und antwortet mit
 *    dem Weg dorthin. Erst dessen Abschluss nimmt die Offerte an.
 *  • `REJECT` bleibt eine direkte Transition — eine Ablehnung braucht keine
 *    Unterschrift.
 *  • Beide sind gegeneinander rennsicher: Es gibt genau ein terminales
 *    Ergebnis, nie „abgelehnt **und** gültig unterzeichnet".
 *
 * **Woher die rohen Tokens kommen.** Aus dem Postausgang des Testservers,
 * nicht aus der Datenbank: Dort liegt nur der Hash. `sendQuote` schreibt die
 * simulierte Nachricht als Datei (`src/lib/email/client.ts`, nur mit
 * `CLENARIS_TEST_CACHE_DIR`), und diese Reihe fährt den *tatsächlich
 * versendeten* Link — keinen selbst gelegten Ersatz (§ 49). Ohne Postausgang
 * überspringen sich die betroffenen Fälle.
 *
 * **Warum die Sitzung teils selbst gebaut wird.** Der Tausch ist auf 20 je
 * zehn Minuten und Adresse begrenzt, und ohne `TRUSTED_PROXY_MODE` teilen
 * sich alle Aufrufer eine Adresse. Die Fälle, die den Tausch selbst prüfen,
 * tauschen; die übrigen bauen die Sitzung mit demselben Schlüssel und
 * denselben Ansprüchen wie `signature-session.ts`. Wer Tauschfälle
 * hinzufügt, zählt mit.
 *
 * Vorgänge und Ereignisse bleiben liegen — Ereignisse sind nicht löschbar,
 * und das ist der Punkt. `npm run db:test:setup -- --frisch` räumt.
 */

type Zugaenge = Awaited<ReturnType<typeof loginAll>>;
let jars: Zugaenge;

const db = testDb();
const ohneDb = { skip: db ? false : `Keine Testdatenbank: ${testDbGrund()}` };
const ohnePost = {
  skip: !db
    ? `Keine Testdatenbank: ${testDbGrund()}`
    : mailOutboxAvailable()
      ? false
      : 'Kein Postausgang — Testserver ohne CLENARIS_TEST_CACHE_DIR gestartet.',
};

// ---------------------------------------------------------------------------
//  Werkzeuge
// ---------------------------------------------------------------------------

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

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

const abgeleitet = (wurzel: Buffer, kontext: string) =>
  Buffer.from(hkdfSync('sha256', wurzel, 'clenaris-abgeleitet', kontext, 32));

/** Eine Sitzung wie `issueSignatureSession` — als `cookie`-Kopf, oder `null` ohne Schlüssel. */
async function sitzungBauen(params: {
  scope: 'sign' | 'result';
  requestId: string;
  participantId: string;
  tokenId: string;
}): Promise<string | null> {
  const wurzel = wurzelschluessel();
  if (!wurzel) return null;
  const token = await new SignJWT({
    typ: 'sig',
    scope: params.scope,
    req: params.requestId,
    part: params.participantId,
    tok: params.tokenId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(randomBytes(16).toString('hex'))
    .setIssuedAt()
    .setExpirationTime('60m')
    .sign(new Uint8Array(abgeleitet(wurzel, 'clenaris-signature-session-v1')));
  return `clenaris_sig=${token}`;
}

/** Ein echtes PNG (RGBA) — pdf-lib muss es einbetten können. */
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

const inTagen = (n: number) => new Date(Date.now() + n * 86_400_000);
const nurDatum = (d: Date) => d.toISOString().slice(0, 10);

let laufendeNummer = 0;

/**
 * Eine frische Offerte für die Demokundschaft — jede Prüfung bekommt ihre
 * eigene. Geteilte Offerten wären nach dem ersten terminalen Übergang für
 * alle folgenden Fälle verbraucht.
 */
async function offerteAnlegen(opts: { validUntil?: Date; customerId?: string } = {}): Promise<{ id: string; number: string }> {
  laufendeNummer += 1;
  const antwort = await post<{ data: { id: string; number: string } }>(
    '/api/quotes',
    {
      customerId: opts.customerId ?? demoKundeId,
      title: `Gate-4C-Prüfung ${Date.now()}-${laufendeNummer}`,
      validUntil: nurDatum(opts.validUntil ?? inTagen(30)),
      items: [
        { name: 'Unterhaltsreinigung', quantity: 6, unit: 'Std.', unitPrice: 64, discount: 0, vatRate: 8.1, optional: false },
      ],
      discountValue: 0,
    },
    { jar: jars.admin },
  );
  assert.equal(antwort.status, 201, antwort.text);
  return data(antwort);
}

/**
 * Versenden — und den Token aus der tatsächlich versendeten Nachricht holen.
 *
 * Genau das verlangt § 49: kein selbst gelegter Ersatztoken. Steht kein
 * Postausgang bereit, geben wir `null` zurück und der Fall überspringt sich.
 */
async function versendenUndTokenLesen(quoteId: string): Promise<string | null> {
  const versand = await post(`/api/quotes/${quoteId}/send`, { attachPdf: true }, { jar: jars.admin });
  assert.equal(versand.status, 200, versand.text);
  const mail = letzteMail({ entityId: quoteId });
  if (!mail) return null;
  for (const link of linksIn(mail)) {
    const treffer = /\/offerte\/([0-9a-f]{64})(?:$|[?#])/.exec(link);
    if (treffer) return treffer[1]!;
  }
  return null;
}

interface AnnahmeAntwort {
  requiresSignature: boolean;
  signatureUrl?: string;
  signatureExpiresAt?: string;
  status?: string;
  rejectedAt?: string | null;
}

const antworten = (token: string, body: Record<string, unknown>) =>
  post<{ data: AnnahmeAntwort }>(`/api/public/quotes/${token}/respond`, body, {});

/** Der rohe Zugang aus `/signieren#t=…` — nur von dort, nie aus der Datenbank. */
function zugangAus(url: string | undefined): string {
  const treffer = /^\/signieren#t=([0-9a-f]{64})$/.exec(url ?? '');
  assert.ok(treffer, `unerwartete Signaturadresse: ${url}`);
  return treffer[1]!;
}

interface VorgangAdmin {
  id: string;
  publicId: string;
  status: string;
  artifactMode: string;
  assuranceLevel: string;
  consentVersion: string;
  quoteId: string | null;
  originalArtifactId: string;
  originalDocumentHash: string;
  signedArtifactId: string | null;
  signedArtifactHash: string | null;
  evidenceArtifactId: string | null;
  evidenceArtifactHash: string | null;
  expiresAt: string;
  participants: {
    id: string;
    status: string;
    nameSnapshot: string;
    signedName: string | null;
    signatureMethod: string | null;
    consentTextSnapshot: string | null;
    consentTextHash: string | null;
    consentVersion: string | null;
  }[];
  events: { type: string; details: Record<string, unknown> | null }[];
}

async function vorgangLesen(id: string): Promise<VorgangAdmin> {
  const antwort = await get<{ data: VorgangAdmin }>(`/api/signatures/${id}`, { jar: jars.admin });
  assert.equal(antwort.status, 200, antwort.text);
  return data(antwort);
}

/** Der offene Annahmevorgang einer Offerte — über die Datenbank, lesend. */
async function offenerVorgang(quoteId: string) {
  return db!.signatureRequest.findFirst({
    where: { quoteId, status: { in: ['DRAFT', 'PENDING', 'FINALIZING'] } },
    include: { participants: { orderBy: { order: 'asc' } } },
  });
}

const quoteLesen = (id: string) =>
  db!.quote.findUniqueOrThrow({
    where: { id },
    select: { status: true, acceptedAt: true, rejectedAt: true, validUntil: true, signatureName: true, signatureDataUrl: true, signedAt: true },
  });

/**
 * Sitzung für einen laufenden Vorgang, ohne den Tausch zu verbrauchen.
 *
 * Der Anker-Token muss existieren (die Sitzung trägt seine Kennung und der
 * Server prüft sie), deshalb wird der jüngste `SIGNATURE_ACCESS` des
 * Teilnehmers verwendet — nicht sein Rohwert, nur seine Kennung.
 */
async function sitzungFuer(requestId: string, participantId: string): Promise<string | null> {
  const anker = await db!.publicAccessToken.findFirst({
    where: { purpose: 'SIGNATURE_ACCESS', resourceId: participantId, revokedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (!anker) return null;
  return sitzungBauen({ scope: 'sign', requestId, participantId, tokenId: anker.id });
}

const abschliessen = (publicId: string, jar: string, body: Record<string, unknown> = {}) =>
  post<{ data: { participantStatus: string; requestStatus: string } }>(
    `/api/public/signatures/${publicId}/complete`,
    { accepted: true, method: 'TYPED', name: 'Nicole Wyss', ...body },
    { jar },
  );

// ---------------------------------------------------------------------------
//  Vorbereitung
// ---------------------------------------------------------------------------

let demoKundeId: string;

before(async () => {
  jars = await loginAll();
  if (!db) return;
  /**
   * Der Kundendatensatz hinter dem Demokonto. Über die Datenbank, nicht über
   * die Sitzung: `/api/auth/session` nennt die Rolle, nicht das Profil — und
   * das ist richtig so, eine Sitzungsauskunft ist kein Datenexport.
   */
  const kunde = await db.customer.findFirst({
    where: { user: { email: ACCOUNTS.customer.email } },
    select: { id: true },
  });
  assert.ok(kunde, `kein Kundendatensatz zu ${ACCOUNTS.customer.email} — `+'`npm run db:seed:demo`?');
  demoKundeId = kunde.id;
});

after(async () => {
  await testDbSchliessen();
});

// ---------------------------------------------------------------------------
//  Der vollständige Weg über den versendeten Link (§ 49–§ 51)
// ---------------------------------------------------------------------------

describe('Offertannahme über den öffentlichen Link', () => {
  it('nimmt eine Offerte getippt an — vom Versand bis zum Ergebnis', ohnePost, async () => {
    const quote = await offerteAnlegen();
    const token = await versendenUndTokenLesen(quote.id);
    assert.ok(token, 'der Versand hat einen Link mit 64 Hexzeichen verschickt');

    // Die Offertseite öffnet sich mit genau diesem Token.
    const seite = await get(`/offerte/${token}`);
    assert.equal(seite.status, 200, 'der versendete Link öffnet die Offerte');

    /**
     * `ACCEPT` entscheidet nicht — es beginnt. Die Offerte bleibt SENT, bis
     * die Unterzeichnung abgeschlossen ist (§ 3, § 10).
     */
    const start = await antworten(token, { decision: 'ACCEPT' });
    assert.equal(start.status, 200, start.text);
    assert.equal(data(start).requiresSignature, true);
    const roh = zugangAus(data(start).signatureUrl);

    const vorher = await quoteLesen(quote.id);
    assert.notEqual(vorher.status, 'ACCEPTED', 'der Start allein nimmt nicht an');

    const vorgang = await offenerVorgang(quote.id);
    assert.ok(vorgang, 'ein Annahmevorgang ist entstanden');
    assert.equal(vorgang.status, 'PENDING');
    assert.equal(vorgang.artifactMode, 'EMBEDDED_VISUAL');
    assert.equal(vorgang.assuranceLevel, 'LINK_ONLY', 'Vorgabe ohne Einmalkennwort (§ 18)');
    assert.equal(vorgang.consentVersion, 'quote-v1', 'der offertspezifische Zustimmungstext (§ 19)');
    assert.equal(vorgang.participants.length, 1, 'genau ein Teilnehmer (§ 7)');

    /**
     * Der Ablauf des Vorgangs überschreitet die Gültigkeit der Offerte
     * nicht (§ 37).
     */
    assert.ok(
      vorgang.expiresAt.getTime() <= vorher.validUntil.getTime(),
      `Vorgang bis ${vorgang.expiresAt.toISOString()}, Offerte bis ${vorher.validUntil.toISOString()}`,
    );

    // Tausch: der rohe Token einmal im Körper, danach eine Sitzung.
    const tausch = await post<{ data: { publicId: string; scope: string } }>('/api/public/signatures/exchange', { token: roh });
    assert.equal(tausch.status, 200, tausch.text);
    assert.equal(data(tausch).publicId, vorgang.publicId);
    const jar = tausch.cookies;

    const fertig = await abschliessen(vorgang.publicId, jar, { method: 'TYPED', name: 'Nicole Wyss' });
    assert.equal(fertig.status, 200, fertig.text);
    assert.equal(data(fertig).requestStatus, 'COMPLETED');

    // Erst jetzt ist die Offerte angenommen (§ 23).
    const nachher = await quoteLesen(quote.id);
    assert.equal(nachher.status, 'ACCEPTED');
    assert.ok(nachher.acceptedAt, 'mit Zeitpunkt');
    assert.equal(nachher.signatureDataUrl, null, 'kein Altbestandsfeld geschrieben (§ 32)');
    assert.equal(nachher.signatureName, null, 'kein Altbestandsfeld geschrieben (§ 32)');

    // Die Kette A/B/C — drei verschiedene Artefakte, alle vorhanden (§ 21).
    const admin = await vorgangLesen(vorgang.id);
    assert.equal(admin.status, 'COMPLETED');
    assert.equal(admin.quoteId, quote.id);
    assert.ok(admin.originalDocumentHash && admin.signedArtifactHash && admin.evidenceArtifactHash);
    assert.notEqual(admin.originalDocumentHash, admin.signedArtifactHash, 'A ≠ B');
    assert.notEqual(admin.signedArtifactHash, admin.evidenceArtifactHash, 'B ≠ C');
    assert.equal(admin.originalDocumentHash, vorgang.originalDocumentHash, 'A ist unverändert geblieben (§ 13)');

    const teilnehmer = admin.participants[0]!;
    assert.equal(teilnehmer.status, 'SIGNED');
    assert.equal(teilnehmer.signatureMethod, 'TYPED');
    assert.equal(teilnehmer.signedName, 'Nicole Wyss');
    assert.equal(teilnehmer.consentVersion, 'quote-v1');
    assert.ok(teilnehmer.consentTextSnapshot?.includes('Offerte'), 'der eingefrorene Text spricht von der Offerte');
    assert.equal(
      teilnehmer.consentTextHash,
      sha256(Buffer.from(teilnehmer.consentTextSnapshot!, 'utf8')),
      'der Zustimmungstext ist mit seiner Prüfsumme eingefroren (§ 19)',
    );

    /**
     * Die Sitzung zum Unterzeichnen reicht für das Ergebnis **nicht** — das
     * ist ein eigener Zweck mit eigenem Zugang (§ 61).
     */
    const mitSignSitzung = await fetch(`${BASE_URL}/api/public/signatures/${vorgang.publicId}/result/signed`, { headers: { cookie: jar } });
    assert.ok(mitSignSitzung.status >= 400, `die Unterzeichnungssitzung darf das Ergebnis nicht öffnen, war ${mitSignSitzung.status}`);

    /**
     * Der Ergebniszugang kommt per E-Mail — und zwar als Fragment, ohne
     * Anhang (§ 39, § 41). Auch ihn holt die Prüfung aus der tatsächlich
     * versendeten Nachricht, nicht aus der Datenbank.
     */
    const ergebnisMail = letzteMail({ templateKey: 'signature_completed', entityId: vorgang.id });
    assert.ok(ergebnisMail, 'nach dem Abschluss geht eine Nachricht mit dem Ergebnislink');
    assert.deepEqual(ergebnisMail.attachments, [], 'kein PDF im Anhang (§ 39)');
    const ergebnisLink = linksIn(ergebnisMail).find((l) => l.includes('/signieren/ergebnis#t='));
    assert.ok(ergebnisLink, `kein Ergebnislink in der Nachricht: ${linksIn(ergebnisMail).join(' ')}`);
    const rohErgebnis = /#t=([0-9a-f]{64})$/.exec(ergebnisLink)![1]!;

    const ergebnisTausch = await post<{ data: { scope: string } }>('/api/public/signatures/exchange', { token: rohErgebnis });
    assert.equal(ergebnisTausch.status, 200, ergebnisTausch.text);
    assert.equal(data(ergebnisTausch).scope, 'result');
    const ergebnisJar = ergebnisTausch.cookies;

    // Das Original ist bytegenau das, was beim Start eingefroren wurde.
    const original = await fetch(`${BASE_URL}/api/public/signatures/${vorgang.publicId}/result/original`, { headers: { cookie: ergebnisJar } });
    assert.equal(original.status, 200);
    assert.equal(sha256(Buffer.from(await original.arrayBuffer())), admin.originalDocumentHash, 'A bytegenau');

    // Das signierte Dokument trägt das Original plus Signaturseite (§ 22).
    const signiert = await fetch(`${BASE_URL}/api/public/signatures/${vorgang.publicId}/result/signed`, { headers: { cookie: ergebnisJar } });
    assert.equal(signiert.status, 200);
    const signierteBytes = Buffer.from(await signiert.arrayBuffer());
    assert.equal(sha256(signierteBytes), admin.signedArtifactHash, 'geliefert wird genau B');
    const doc = await PDFDocument.load(signierteBytes);
    assert.ok(doc.getPageCount() >= 2, `Original plus Signaturseite, nicht ${doc.getPageCount()}`);

    // Und das Protokoll (§ 43).
    const protokoll = await fetch(`${BASE_URL}/api/public/signatures/${vorgang.publicId}/result/evidence`, { headers: { cookie: ergebnisJar } });
    assert.equal(protokoll.status, 200);
    assert.equal(sha256(Buffer.from(await protokoll.arrayBuffer())), admin.evidenceArtifactHash, 'geliefert wird genau C');
  });

  it('nimmt eine Offerte gezeichnet an', ohnePost, async () => {
    const quote = await offerteAnlegen();
    const token = await versendenUndTokenLesen(quote.id);
    assert.ok(token);

    const start = await antworten(token, { decision: 'ACCEPT' });
    assert.equal(start.status, 200, start.text);
    const roh = zugangAus(data(start).signatureUrl);

    const vorgang = await offenerVorgang(quote.id);
    assert.ok(vorgang);

    const tausch = await post('/api/public/signatures/exchange', { token: roh });
    assert.equal(tausch.status, 200, tausch.text);

    const fertig = await abschliessen(vorgang.publicId, tausch.cookies, {
      method: 'DRAWN',
      name: 'Nicole Wyss',
      imageDataUrl: pngDataUrl(),
    });
    assert.equal(fertig.status, 200, fertig.text);

    assert.equal((await quoteLesen(quote.id)).status, 'ACCEPTED');
    const admin = await vorgangLesen(vorgang.id);
    assert.equal(admin.participants[0]!.signatureMethod, 'DRAWN');
    assert.ok(admin.signedArtifactHash, 'auch gezeichnet entsteht B');
    assert.ok(admin.evidenceArtifactHash, 'auch gezeichnet entsteht C');
  });

  it('lehnt ohne Unterzeichnung ab — und danach ist Annehmen verwehrt', ohnePost, async () => {
    const quote = await offerteAnlegen();
    const token = await versendenUndTokenLesen(quote.id);
    assert.ok(token);

    const ablehnung = await antworten(token, { decision: 'REJECT', reason: 'Budget überschritten' });
    assert.equal(ablehnung.status, 200, ablehnung.text);
    assert.equal(data(ablehnung).requiresSignature, false);
    assert.equal(data(ablehnung).status, 'REJECTED');

    const nachher = await quoteLesen(quote.id);
    assert.equal(nachher.status, 'REJECTED');
    assert.ok(nachher.rejectedAt);

    // Eine Ablehnung erzeugt keinen Unterzeichnungsvorgang (§ 6).
    const vorgaenge = await db!.signatureRequest.count({ where: { quoteId: quote.id } });
    assert.equal(vorgaenge, 0, 'keine SignatureRequest für eine Ablehnung');

    // Und ein späterer Annahmeversuch trifft auf eine beantwortete Offerte.
    const zuSpaet = await antworten(token, { decision: 'ACCEPT' });
    assert.equal(zuSpaet.status, 422, zuSpaet.text);
    assert.equal((await quoteLesen(quote.id)).status, 'REJECTED');
  });
});

// ---------------------------------------------------------------------------
//  Kundenkonto (§ 29, § 30, § 53)
// ---------------------------------------------------------------------------

describe('Offertannahme im Kundenkonto', () => {
  it('nimmt die eigene Offerte mit Sitzung und Eigentümerschaft an', ohneDb, async () => {
    const quote = await offerteAnlegen();
    // Versandt, damit die Offerte den Zustand SENT hat wie im Betrieb.
    await post(`/api/quotes/${quote.id}/send`, { attachPdf: false }, { jar: jars.admin });

    /**
     * Kein öffentlicher Token im Spiel: Die Antwort nennt die nicht geheime
     * Kennung, den Zugang trägt das Cookie (§ 30).
     */
    const start = await post<{ data: AnnahmeAntwort }>(`/api/quotes/${quote.id}/respond`, { decision: 'ACCEPT' }, { jar: jars.customer });
    assert.equal(start.status, 200, start.text);
    assert.equal(data(start).requiresSignature, true);
    assert.match(data(start).signatureUrl ?? '', /^\/signieren\/s\/[A-Za-z0-9_-]+$/, 'kein roher Token in der Adresse');
    assert.doesNotMatch(data(start).signatureUrl ?? '', /[0-9a-f]{64}/, 'und erst recht keine 64 Hexzeichen');

    const vorgang = await offenerVorgang(quote.id);
    assert.ok(vorgang);
    assert.notEqual((await quoteLesen(quote.id)).status, 'ACCEPTED', 'der Start allein nimmt nicht an');

    const jar = `${jars.customer}; ${start.cookies}`;
    const fertig = await abschliessen(vorgang.publicId, jar, { method: 'TYPED', name: 'Nicole Wyss' });
    assert.equal(fertig.status, 200, fertig.text);
    assert.equal((await quoteLesen(quote.id)).status, 'ACCEPTED');

    /**
     * Das Protokoll unterscheidet den Zugangsweg — ohne damit eine höhere
     * Identitätssicherheit zu behaupten (§ 30).
     */
    const admin = await vorgangLesen(vorgang.id);
    const zugang = admin.events.find((e) => e.type === 'LINK_EXCHANGED');
    assert.ok(zugang, 'der Zugang ist protokolliert');
    assert.equal(zugang.details?.actorSource, 'AUTHENTICATED_CUSTOMER');
  });

  it('verweigert die Offerte einer anderen Kundschaft', ohneDb, async () => {
    const fremd = await db!.customer.findFirst({
      where: { organizationId: (await db!.quote.findFirstOrThrow({ select: { organizationId: true } })).organizationId, id: { not: demoKundeId }, deletedAt: null },
      select: { id: true },
    });
    assert.ok(fremd, 'die Demodaten enthalten eine zweite Kundschaft');

    const quote = await offerteAnlegen({ customerId: fremd.id });
    const versuch = await post(`/api/quotes/${quote.id}/respond`, { decision: 'ACCEPT' }, { jar: jars.customer });
    assert.equal(versuch.status, 404, 'nicht gefunden statt gefunden und verweigert');

    assert.equal(await db!.signatureRequest.count({ where: { quoteId: quote.id } }), 0, 'kein Vorgang für eine fremde Offerte');
    assert.notEqual((await quoteLesen(quote.id)).status, 'ACCEPTED');
  });
});

// ---------------------------------------------------------------------------
//  Snapshot und Unveränderlichkeit (§ 54, § 55)
// ---------------------------------------------------------------------------

describe('Der eingefrorene Snapshot', () => {
  it('bleibt bytegenau, und eine Änderung der Offerte bricht den Vorgang ab', ohnePost, async () => {
    const quote = await offerteAnlegen();
    const token = await versendenUndTokenLesen(quote.id);
    assert.ok(token);

    const start = await antworten(token, { decision: 'ACCEPT' });
    assert.equal(start.status, 200, start.text);
    const vorgang = await offenerVorgang(quote.id);
    assert.ok(vorgang);
    const hashA = vorgang.originalDocumentHash;

    const bytesVorher = await db!.fileAsset.findUnique({
      where: { id: vorgang.originalArtifactId },
      include: { storedFile: true },
    });
    assert.ok(bytesVorher?.storedFile?.data, 'der Snapshot liegt im eingebauten Speicher');
    const unversehrt = Buffer.from(bytesVorher.storedFile.data);
    assert.equal(sha256(unversehrt), hashA, 'Hash A bindet genau diese Bytes (§ 3)');

    /**
     * Eine signaturrelevante Änderung: Der alte Snapshot darf nicht still
     * weiter unterschrieben werden (§ 12, § 54).
     */
    const geaendert = await patch(`/api/quotes/${quote.id}`, { title: `Geändert ${Date.now()}` }, { jar: jars.admin });
    assert.equal(geaendert.status, 200, geaendert.text);

    const danach = await db!.signatureRequest.findUniqueOrThrow({ where: { id: vorgang.id } });
    assert.equal(danach.status, 'CANCELLED', 'der Vorgang zur alten Fassung ist abgebrochen');
    assert.equal(danach.originalDocumentHash, hashA, 'Hash A bleibt, was er war');

    const bytesNachher = await db!.fileAsset.findUnique({
      where: { id: vorgang.originalArtifactId },
      include: { storedFile: true },
    });
    assert.equal(sha256(Buffer.from(bytesNachher!.storedFile!.data!)), hashA, 'der alte Snapshot bleibt bytegenau erhalten');

    // Der Zugang zum abgebrochenen Vorgang ist entwertet (§ 38).
    const offen = await db!.publicAccessToken.count({
      where: { purpose: 'SIGNATURE_ACCESS', resourceId: vorgang.participants[0]!.id, revokedAt: null },
    });
    assert.equal(offen, 0, 'die Signaturzugänge des abgebrochenen Vorgangs sind widerrufen');

    assert.notEqual((await quoteLesen(quote.id)).status, 'ACCEPTED');
  });

  it('verweigert den Abschluss, wenn die gespeicherten Originalbytes nicht mehr zu Hash A passen', ohnePost, async () => {
    const quote = await offerteAnlegen();
    const token = await versendenUndTokenLesen(quote.id);
    assert.ok(token);

    const start = await antworten(token, { decision: 'ACCEPT' });
    assert.equal(start.status, 200, start.text);
    const vorgang = await offenerVorgang(quote.id);
    assert.ok(vorgang);

    const jar = await sitzungFuer(vorgang.id, vorgang.participants[0]!.id);
    if (!jar) return; // ohne Schlüssel nicht herstellbar

    const asset = await db!.fileAsset.findUnique({ where: { id: vorgang.originalArtifactId }, include: { storedFile: true } });
    assert.ok(asset?.storedFile?.data);
    const unversehrt = Buffer.from(asset.storedFile.data);

    await db!.storedFile.update({ where: { id: asset.storedFile.id }, data: { data: Buffer.concat([unversehrt, Buffer.from(' ')]) } });
    try {
      const versuch = await abschliessen(vorgang.publicId, jar);
      assert.equal(versuch.status, 422, versuch.text);

      const nachher = await quoteLesen(quote.id);
      assert.notEqual(nachher.status, 'ACCEPTED', 'die Offerte bleibt unangenommen (§ 55)');

      const admin = await vorgangLesen(vorgang.id);
      assert.equal(admin.status, 'PENDING', 'kein Abschluss');
      assert.equal(admin.signedArtifactId, null);
      assert.equal(admin.evidenceArtifactId, null);
      assert.ok(admin.events.some((e) => e.type === 'INTEGRITY_FAILED'), 'INTEGRITY_FAILED protokolliert');
    } finally {
      await db!.storedFile.update({ where: { id: asset.storedFile.id }, data: { data: unversehrt } });
    }
  });
});

// ---------------------------------------------------------------------------
//  Gleichzeitigkeit (§ 56–§ 58)
// ---------------------------------------------------------------------------

describe('Gleichzeitigkeit', () => {
  it('erzeugt bei vier gleichzeitigen Annahmestarts genau einen Vorgang', ohnePost, async () => {
    const quote = await offerteAnlegen();
    const token = await versendenUndTokenLesen(quote.id);
    assert.ok(token);

    const antwortenParallel = await Promise.all([
      antworten(token, { decision: 'ACCEPT' }),
      antworten(token, { decision: 'ACCEPT' }),
      antworten(token, { decision: 'ACCEPT' }),
      antworten(token, { decision: 'ACCEPT' }),
    ]);
    const erfolgreich = antwortenParallel.filter((a) => a.status === 200);
    assert.ok(erfolgreich.length >= 1, `mindestens einer gewinnt: ${antwortenParallel.map((a) => a.status).join(', ')}`);

    /**
     * Der Teilindex entscheidet, nicht die Maske: Egal wie viele Starts
     * gleichzeitig ankommen, es gibt einen fachlichen Vorgang und damit
     * einen Snapshot (§ 27).
     */
    const alle = await db!.signatureRequest.count({ where: { quoteId: quote.id } });
    assert.equal(alle, 1, `genau ein Vorgang, nicht ${alle}`);

    // Und alle erfolgreichen Antworten führen auf denselben Vorgang.
    const vorgang = await offenerVorgang(quote.id);
    assert.ok(vorgang);
    assert.equal(vorgang.participants.length, 1, 'ein Teilnehmer, nicht vier');
  });

  it('nimmt bei vier gleichzeitigen Abschlüssen genau einmal an', ohnePost, async () => {
    const quote = await offerteAnlegen();
    const token = await versendenUndTokenLesen(quote.id);
    assert.ok(token);

    const start = await antworten(token, { decision: 'ACCEPT' });
    assert.equal(start.status, 200, start.text);
    const vorgang = await offenerVorgang(quote.id);
    assert.ok(vorgang);

    const jar = await sitzungFuer(vorgang.id, vorgang.participants[0]!.id);
    if (!jar) return;

    const ergebnisse = await Promise.all([
      abschliessen(vorgang.publicId, jar),
      abschliessen(vorgang.publicId, jar),
      abschliessen(vorgang.publicId, jar),
      abschliessen(vorgang.publicId, jar),
    ]);
    assert.ok(ergebnisse.some((r) => r.status === 200), `mindestens einer schliesst ab: ${ergebnisse.map((r) => r.status).join(', ')}`);

    const admin = await vorgangLesen(vorgang.id);
    assert.equal(admin.status, 'COMPLETED');
    const abschluesse = admin.events.filter((e) => e.type === 'REQUEST_COMPLETED');
    assert.equal(abschluesse.length, 1, `genau ein REQUEST_COMPLETED, nicht ${abschluesse.length}`);

    const nachher = await quoteLesen(quote.id);
    assert.equal(nachher.status, 'ACCEPTED');

    /**
     * Und genau eine Annahme im allgemeinen Prüfprotokoll — vier
     * Abschlüsse dürften nicht vier Meldungen ans Büro auslösen.
     */
    const eintraege = await db!.auditLog.count({
      where: { entity: 'Quote', entityId: quote.id, summary: { contains: 'elektronisch angenommen' } },
    });
    assert.equal(eintraege, 1, `genau ein Annahmeeintrag, nicht ${eintraege}`);
  });

  it('lässt Annahme und Ablehnung nie beide gewinnen', ohnePost, async () => {
    /**
     * Mehrere Läufe: Der Ausgang darf vom Zufall des Schedulings abhängen —
     * die *Invariante* nicht. Verboten ist allein die Kombination
     * „abgelehnt **und** gültig abgeschlossene Annahme" (§ 26, § 56).
     */
    for (let lauf = 0; lauf < 3; lauf++) {
      const quote = await offerteAnlegen();
      const token = await versendenUndTokenLesen(quote.id);
      assert.ok(token);

      const start = await antworten(token, { decision: 'ACCEPT' });
      assert.equal(start.status, 200, start.text);
      const vorgang = await offenerVorgang(quote.id);
      assert.ok(vorgang);

      const jar = await sitzungFuer(vorgang.id, vorgang.participants[0]!.id);
      if (!jar) return;

      const [abschluss, ablehnung] = await Promise.all([
        abschliessen(vorgang.publicId, jar),
        antworten(token, { decision: 'REJECT', reason: 'Doch nicht' }),
      ]);

      const nachher = await quoteLesen(quote.id);
      const request = await db!.signatureRequest.findUniqueOrThrow({ where: { id: vorgang.id } });

      assert.ok(
        ['ACCEPTED', 'REJECTED'].includes(nachher.status),
        `ein terminaler Zustand, nicht ${nachher.status} (Abschluss ${abschluss.status}, Ablehnung ${ablehnung.status})`,
      );

      if (nachher.status === 'ACCEPTED') {
        assert.equal(request.status, 'COMPLETED', 'angenommen ⇒ abgeschlossener Vorgang (§ 23)');
        assert.equal(ablehnung.status >= 400, true, `die Ablehnung danach muss scheitern, war aber ${ablehnung.status}`);
      } else {
        assert.notEqual(
          request.status,
          'COMPLETED',
          'abgelehnt und zugleich gültig unterzeichnet — genau das darf es nicht geben (§ 26)',
        );
        assert.equal(nachher.acceptedAt, null, 'keine Annahmezeit auf einer abgelehnten Offerte');
      }
    }
  });
});

// ---------------------------------------------------------------------------
//  Fristen und der Bruch zwischen Signatur und Geschäft (§ 59, § 63)
// ---------------------------------------------------------------------------

describe('Fristen', () => {
  it('beginnt auf einer abgelaufenen Offerte keinen Vorgang', ohnePost, async () => {
    const quote = await offerteAnlegen();
    const token = await versendenUndTokenLesen(quote.id);
    assert.ok(token);

    // Die Frist zurückdatieren — der Link bleibt gültig, die Offerte nicht.
    await db!.quote.update({ where: { id: quote.id }, data: { validUntil: inTagen(-1) } });

    const versuch = await antworten(token, { decision: 'ACCEPT' });
    assert.equal(versuch.status, 422, versuch.text);
    assert.match(versuch.text, /abgelaufen/i);
    assert.equal(await db!.signatureRequest.count({ where: { quoteId: quote.id } }), 0, 'kein Vorgang auf einer abgelaufenen Offerte (§ 36)');
  });

  it('schliesst nicht ab, wenn die Offerte zwischen Start und Abschluss abläuft', ohnePost, async () => {
    const quote = await offerteAnlegen();
    const token = await versendenUndTokenLesen(quote.id);
    assert.ok(token);

    const start = await antworten(token, { decision: 'ACCEPT' });
    assert.equal(start.status, 200, start.text);
    const vorgang = await offenerVorgang(quote.id);
    assert.ok(vorgang);

    const jar = await sitzungFuer(vorgang.id, vorgang.participants[0]!.id);
    if (!jar) return;

    /**
     * Der Bruch, den § 63 verlangt: Die Unterzeichnung gelingt technisch,
     * die Geschäftstransition nicht mehr. Es darf kein stiller Endzustand
     * „COMPLETED, aber nicht angenommen" entstehen — der Vorgang bekommt
     * einen Namen, ein Ereignis und einen Grund.
     */
    await db!.quote.update({ where: { id: quote.id }, data: { validUntil: inTagen(-1) } });

    const versuch = await abschliessen(vorgang.publicId, jar);
    void versuch;

    const nachher = await quoteLesen(quote.id);
    assert.notEqual(nachher.status, 'ACCEPTED', 'eine abgelaufene Offerte wird nicht angenommen (§ 36)');
    assert.equal(nachher.acceptedAt, null);

    const request = await db!.signatureRequest.findUniqueOrThrow({ where: { id: vorgang.id } });
    assert.notEqual(request.status, 'COMPLETED', 'kein COMPLETED ohne Annahme (§ 23)');

    if (request.status === 'CANCELLED') {
      const ereignis = await db!.signatureEvent.findFirst({
        where: { requestId: vorgang.id, type: 'CANCELLED' },
        orderBy: { at: 'desc' },
      });
      assert.ok(ereignis, 'der Abbruch ist protokolliert — kein stiller Zustand (§ 63)');
      assert.equal(
        (ereignis.details as { reason?: string } | null)?.reason,
        'quote_not_acceptable_at_completion',
        'mit nachvollziehbarem Grund',
      );
    }
  });
});

// ---------------------------------------------------------------------------
//  Altbestand (§ 60, § 33)
// ---------------------------------------------------------------------------

describe('Altbestand', () => {
  it('lässt historische Annahmen unverändert und erfindet keine Beweise', ohneDb, async () => {
    /**
     * Eine Offerte, wie sie vor Gate 4C angenommen wurde: ACCEPTED mit den
     * drei Altfeldern, ohne Vorgang. Sie muss lesbar bleiben — und darf
     * nirgends als Gate-4B-Beweis auftreten (§ 33, § 69).
     */
    const quote = await offerteAnlegen();
    await db!.quote.update({
      where: { id: quote.id },
      data: {
        status: 'ACCEPTED',
        acceptedAt: new Date(),
        signedAt: new Date(),
        signatureName: 'Alt Bestand',
        signatureDataUrl: pngDataUrl(),
      },
    });

    const detail = await get(`/api/quotes/${quote.id}`, { jar: jars.admin });
    assert.equal(detail.status, 200, 'die historische Offerte bleibt lesbar');

    const pdf = await get(`/api/quotes/${quote.id}/pdf`, { jar: jars.admin });
    assert.equal(pdf.status, 200, 'und ihr PDF ebenfalls');
    assert.ok(pdf.text.length > 3000, 'mit Inhalt');

    // Kein nachträglich erfundener Vorgang, kein erfundenes Protokoll.
    assert.equal(await db!.signatureRequest.count({ where: { quoteId: quote.id } }), 0, 'kein SignatureRequest für eine Altannahme');

    const unveraendert = await quoteLesen(quote.id);
    assert.equal(unveraendert.signatureName, 'Alt Bestand', 'die Altfelder bleiben, wie sie waren');
    assert.ok(unveraendert.signedAt, 'auch der Zeitpunkt');
  });
});

// ---------------------------------------------------------------------------
//  Capabilities und Tokenhygiene (§ 61, § 62, § 64)
// ---------------------------------------------------------------------------

describe('Capabilities und Tokenhygiene', () => {
  it('lässt QUOTE_VIEW ansehen, aber nicht annehmen', ohneDb, async () => {
    const quote = await offerteAnlegen();
    const organizationId = (await db!.quote.findUniqueOrThrow({ where: { id: quote.id }, select: { organizationId: true } })).organizationId;

    const roh = randomBytes(32).toString('hex');
    await db!.publicAccessToken.create({
      data: {
        organizationId,
        tokenHash: sha256(Buffer.from(roh)),
        purpose: 'QUOTE_VIEW',
        resourceId: quote.id,
        expiresAt: inTagen(1),
      },
    });

    // Ansehen: ja.
    const seite = await get(`/offerte/${roh}`);
    assert.equal(seite.status, 200, 'QUOTE_VIEW öffnet die Offerte');
    const pdf = await get(`/api/public/quotes/${roh}/pdf`);
    assert.equal(pdf.status, 200, 'und liefert das PDF');

    // Annehmen: nein.
    const versuch = await antworten(roh, { decision: 'ACCEPT' });
    assert.ok(versuch.status === 403 || versuch.status === 404, `QUOTE_VIEW darf nicht annehmen, bekam ${versuch.status}`);
    assert.equal(await db!.signatureRequest.count({ where: { quoteId: quote.id } }), 0, 'und erzeugt keinen Vorgang');
  });

  it('bindet SIGNATURE_ACCESS an genau einen Teilnehmer', ohnePost, async () => {
    const eins = await offerteAnlegen();
    const zwei = await offerteAnlegen();
    const tokenEins = await versendenUndTokenLesen(eins.id);
    const tokenZwei = await versendenUndTokenLesen(zwei.id);
    assert.ok(tokenEins && tokenZwei);

    const startEins = await antworten(tokenEins, { decision: 'ACCEPT' });
    const startZwei = await antworten(tokenZwei, { decision: 'ACCEPT' });
    assert.equal(startEins.status, 200, startEins.text);
    assert.equal(startZwei.status, 200, startZwei.text);

    const vorgangEins = await offenerVorgang(eins.id);
    const vorgangZwei = await offenerVorgang(zwei.id);
    assert.ok(vorgangEins && vorgangZwei);

    const jarEins = await sitzungFuer(vorgangEins.id, vorgangEins.participants[0]!.id);
    if (!jarEins) return;

    /**
     * Die Sitzung des einen Vorgangs darf den anderen nicht erreichen —
     * keine Capability greift seitwärts (§ 61).
     */
    const quer = await abschliessen(vorgangZwei.publicId, jarEins);
    assert.ok(quer.status >= 400, `Quergriff muss scheitern, war aber ${quer.status}`);
    assert.notEqual((await quoteLesen(zwei.id)).status, 'ACCEPTED');
  });

  it('trägt den rohen Zugang nur im Fragment und im Tauschkörper', ohnePost, async () => {
    const quote = await offerteAnlegen();
    const token = await versendenUndTokenLesen(quote.id);
    assert.ok(token);

    /**
     * Die Offert-E-Mail selbst darf keinen Signaturzugang enthalten: Der
     * Vorgang entsteht erst beim Annehmen (§ 64).
     */
    const offertMail = letzteMail({ entityId: quote.id });
    assert.ok(offertMail);
    assert.doesNotMatch(offertMail.html, /\/signieren/, 'kein Signaturlink in der Offert-E-Mail');

    const start = await antworten(token, { decision: 'ACCEPT' });
    assert.equal(start.status, 200, start.text);
    const url = data(start).signatureUrl ?? '';
    const roh = zugangAus(url);

    // Der Rohwert steht im Fragment — nicht im Pfad, nicht in der Abfrage (§ 16).
    assert.ok(url.startsWith('/signieren#t='), `Fragment erwartet, war ${url}`);
    assert.doesNotMatch(url, /\?/, 'kein Querystring');
    assert.equal(url.split('#')[0], '/signieren', 'der Pfad trägt nichts');

    // Die Antwort wird nicht zwischengespeichert.
    assert.equal(start.headers.get('cache-control'), 'no-store');

    const vorgang = await offenerVorgang(quote.id);
    assert.ok(vorgang);

    /**
     * Und nirgends sonst: weder im Signaturprotokoll noch im allgemeinen
     * Prüfprotokoll, noch in der HTML der Signaturseite (§ 62).
     */
    const ereignisse = await db!.signatureEvent.findMany({ where: { requestId: vorgang.id }, select: { details: true } });
    for (const e of ereignisse) {
      assert.doesNotMatch(JSON.stringify(e.details ?? {}), new RegExp(roh), 'kein roher Token im Signaturprotokoll');
    }
    const eintraege = await db!.auditLog.findMany({ where: { entity: 'Quote', entityId: quote.id }, select: { summary: true, changes: true } });
    for (const a of eintraege) {
      assert.doesNotMatch(`${a.summary} ${JSON.stringify(a.changes ?? {})}`, new RegExp(roh), 'kein roher Token im Prüfprotokoll');
    }

    const seite = await get('/signieren');
    assert.doesNotMatch(seite.text, new RegExp(roh), 'die Maske trägt den Token nicht im HTML');

    // Und in der Datenbank liegt nur der Hash.
    const alsKlartext = await db!.publicAccessToken.count({ where: { tokenHash: roh } });
    assert.equal(alsKlartext, 0, 'gespeichert wird der Hash, nicht der Token');
    const alsHash = await db!.publicAccessToken.count({ where: { tokenHash: sha256(Buffer.from(roh)), purpose: 'SIGNATURE_ACCESS' } });
    assert.equal(alsHash, 1, 'und zwar genau einmal');
  });
});
