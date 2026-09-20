import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { after, before, describe, it } from 'node:test';

import { PDFDocument } from 'pdf-lib';

import { BASE_URL, data, del, get, patch, post, put } from '../helpers/client.js';
import { ACCOUNTS, login, loginAll } from '../helpers/accounts.js';
import { testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb.js';

/**
 * Vor-Ort-Abnahme des Rapports auf dem übergebenen Gerät (Gate 4D).
 *
 * **Der Fall, der hier geprüft wird, ist kein gewöhnlicher.** Bei der Abnahme
 * reicht die Reinigungskraft ihr eigenes, angemeldetes Telefon der
 * Kundschaft. Für die Dauer der Unterschrift sitzen zwei verschiedene
 * Personen hintereinander an **derselben Sitzung** — und die Cookies der
 * einen liegen im Browser, den die andere in der Hand hält.
 *
 * Eine Maske ohne Navigation genügt dagegen nicht. Diese Reihe fährt deshalb
 * genau die Wege an, die eine Maske nicht schliesst:
 *
 *  • Während der Übergabe antwortet **jeder** angemeldete Endpunkt mit 423 —
 *    auch aus einem zweiten Tab, auch nach einer direkt eingetippten
 *    Adresse, auch wenn das Zugangstoken gelöscht und erneuert wird.
 *  • Die Sperre hängt an der Rotationsfamilie *dieses* Browsers: Ein zweites
 *    Gerät derselben Person bleibt benutzbar.
 *  • Der Mitarbeiter wird dabei **nicht** abgemeldet. Nach der Rückgabe
 *    genügt sein Passwort — dieselbe Sitzung, dieselbe Familie, keine
 *    Neuanmeldung.
 *  • Unterschrieben hat die Kundschaft, nicht das Personal. Der Beweis nennt
 *    die Person aus dem Betrieb ausschliesslich als diejenige, die das Gerät
 *    bereitgestellt hat — nicht als Zeugin und nicht als Prüferin einer
 *    Identität.
 *
 * **Warum die Sitzungen teils selbst gebaut werden.** Der Signaturtausch ist
 * auf 20 je zehn Minuten und Adresse begrenzt, und ohne
 * `TRUSTED_PROXY_MODE` teilen sich alle Aufrufer eine Adresse. Die
 * Vor-Ort-Abnahme tauscht ohnehin nie — sie stellt die Sitzung direkt aus —,
 * deshalb liest diese Reihe das Signaturcookie aus der Startantwort.
 */

type Zugaenge = Awaited<ReturnType<typeof loginAll>>;
let jars: Zugaenge;

const db = testDb();
const ohneDb = { skip: db ? false : `Keine Testdatenbank: ${testDbGrund()}` };

// ---------------------------------------------------------------------------
//  Werkzeuge
// ---------------------------------------------------------------------------

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * Anders als `signatur.test.ts` baut diese Datei **keine** Signatursitzung
 * von Hand — sie braucht es nicht.
 *
 * Der Link-Ablauf muss dort den Tausch umgehen, weil er auf 20 Aufrufe je
 * zehn Minuten und Adresse begrenzt ist. Die Vor-Ort-Abnahme tauscht
 * überhaupt nie: Sie stellt die Sitzung direkt auf dem Gerät aus und setzt
 * sie als Cookie. Die Prüfung liest genau dieses Cookie aus der Startantwort
 * — also denselben Weg, den auch der Browser nimmt.
 */

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
  ihdr[8] = 8;
  ihdr[9] = 6;
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

// ---------------------------------------------------------------------------
//  Vorbereitung: Stammdaten aus dem Demobestand
// ---------------------------------------------------------------------------

let customerId = '';
let addressId = '';
let propertyId = '';
let serviceId = '';
let annaEmployeeId = '';
let annaUserId = '';

const angelegteJobs: string[] = [];
let tagVersatz = 40;

const inTagen = (n: number, stunde: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(stunde, 0, 0, 0);
  return d.toISOString();
};

/**
 * Ein frischer, abgeschlossener und Anna zugeteilter Einsatz.
 *
 * Jede Prüfung bekommt ihren eigenen: Ein Einsatz mit terminaler Abnahme
 * wäre für alle folgenden Fälle verbraucht, und der Teilindex lässt je
 * Einsatz ohnehin nur eine offene Abnahme zu.
 */
async function einsatzVorbereiten(opts: { abschliessen?: boolean } = {}): Promise<{ id: string; number: string }> {
  tagVersatz += 1;
  const antwort = await post<{ data: { id: string; number: string } }>(
    '/api/jobs',
    {
      customerId,
      addressId,
      propertyId,
      serviceId,
      title: `Gate-4D-Prüfung ${Date.now()}-${tagVersatz}`,
      scheduledStart: inTagen(tagVersatz, 8),
      scheduledEnd: inTagen(tagVersatz, 11),
      estimatedMin: 180,
    },
    { jar: jars.admin },
  );
  assert.equal(antwort.status, 201, antwort.text);
  const job = data(antwort);
  angelegteJobs.push(job.id);

  const zuteilung = await post(
    `/api/jobs/${job.id}/assign`,
    { employeeIds: [annaEmployeeId], notify: false },
    { jar: jars.admin },
  );
  assert.equal(zuteilung.status, 200, zuteilung.text);

  if (opts.abschliessen !== false) {
    const abschluss = await post(
      `/api/jobs/${job.id}/complete`,
      { completionNote: 'Alles erledigt.', materials: [] },
      { jar: jars.employee },
    );
    assert.equal(abschluss.status, 200, abschluss.text);
  }
  return job;
}

interface StartAntwort {
  handoffId: string;
  signatureUrl: string;
  publicId: string;
}

/**
 * Die Übergabe starten — mit einem **eigenen** Anmeldecookie.
 *
 * Wichtig: nicht `jars.employee` verwenden. Dieses Cookie teilen sich alle
 * Dateien über den Sitzungs-Cache; es zu sperren hiesse, die halbe Prüfreihe
 * mitzusperren. Jede Übergabe bekommt deshalb eine frisch angemeldete
 * Sitzung, also eine eigene Rotationsfamilie — was zugleich der Fall ist,
 * den § 32 verlangt: Eine Sperre gilt genau einem Browser.
 */
async function frischeMitarbeiterSitzung(): Promise<string> {
  const angemeldet = await login(ACCOUNTS.employee.email, ACCOUNTS.employee.password);
  assert.equal(angemeldet.status, 200, angemeldet.text);
  return angemeldet.jar;
}

async function uebergeben(jobId: string, jar: string) {
  return post<{ data: StartAntwort }>(`/api/jobs/${jobId}/handoff`, undefined, { jar });
}

/** Das Signaturcookie aus der Startantwort — der Kundenmodus läuft damit. */
function signaturJar(antwort: { cookies: string }): string {
  const treffer = /clenaris_sig=[^;]+/.exec(antwort.cookies);
  assert.ok(treffer, `kein Signaturcookie in der Antwort: ${antwort.cookies}`);
  return treffer[0];
}

const abschliessen = (publicId: string, jar: string, body: Record<string, unknown> = {}) =>
  post<{ data: { participantStatus: string; requestStatus: string } }>(
    `/api/public/signatures/${publicId}/complete`,
    { accepted: true, method: 'TYPED', name: 'Nicole Wyss', ...body },
    { jar },
  );

const jobLesen = (id: string) =>
  db!.job.findUniqueOrThrow({
    where: { id },
    select: {
      status: true,
      customerAcceptedAt: true,
      signatureDataUrl: true,
      signatureName: true,
      signedAt: true,
      deletedAt: true,
    },
  });

const offenerVorgang = (jobId: string) =>
  db!.signatureRequest.findFirst({
    where: { jobId, ceremonyMode: 'IN_PERSON_HANDOFF', status: { in: ['DRAFT', 'PENDING', 'FINALIZING'] } },
    include: { participants: { orderBy: { order: 'asc' } } },
  });

/** Die Rotationsfamilie eines Anmeldecookies — über die Datenbank, nie den Rohwert. */
async function familieVon(jar: string): Promise<string | null> {
  const roh = /clenaris_rt=([^;]+)/.exec(jar)?.[1];
  if (!roh) return null;
  const treffer = await db!.refreshToken.findUnique({
    where: { tokenHash: sha256(Buffer.from(roh)) },
    select: { family: true },
  });
  return treffer?.family ?? null;
}

before(async () => {
  jars = await loginAll();
  if (!db) return;

  const objekte = data(
    await get<{ data: { id: string; address: { id: string } | null; customer: { id: string } }[] }>(
      '/api/properties',
      { jar: jars.admin },
    ),
  );
  const mitAdresse = objekte.find((objekt) => objekt.address !== null);
  assert.ok(mitAdresse, 'Der Demobestand enthält ein Objekt mit Adresse');
  propertyId = mitAdresse.id;
  addressId = mitAdresse.address!.id;
  customerId = mitAdresse.customer.id;

  serviceId = data(await get<{ data: { id: string }[] }>('/api/services', { jar: jars.admin }))[0]!.id;

  const personal = data(
    await get<{ data: { id: string; user: { id: string; email: string } }[] }>('/api/employees', {
      jar: jars.admin,
    }),
  );
  const anna = personal.find((p) => p.user.email === ACCOUNTS.employee.email);
  assert.ok(anna, `kein Personaldatensatz zu ${ACCOUNTS.employee.email}`);
  annaEmployeeId = anna.id;
  annaUserId = anna.user.id;
});

after(async () => {
  /**
   * Offene Sperren aus fehlgeschlagenen Fällen aufheben, damit ein
   * Wiederholungslauf nicht an einer Familie hängenbleibt, die niemand mehr
   * benutzt. Vorgänge und Ereignisse bleiben liegen — sie sind der Beweis.
   */
  if (db) {
    await db.deviceHandoffSession.updateMany({
      where: { userId: annaUserId, status: 'ACTIVE' },
      data: { status: 'RELEASED', releasedAt: new Date() },
    });
    for (const jobId of angelegteJobs) {
      await del(`/api/jobs/${jobId}`, { jar: jars.admin }).catch(() => undefined);
    }
  }
  await testDbSchliessen();
});

// ---------------------------------------------------------------------------
//  Berechtigung zum Start (§ 64)
// ---------------------------------------------------------------------------

describe('Wer die Abnahme starten darf', () => {
  it('lässt die zugeteilte Person starten und niemanden sonst', ohneDb, async () => {
    const job = await einsatzVorbereiten();

    // Kundschaft: kein Zugriff auf Einsatzendpunkte.
    const alsKunde = await uebergeben(job.id, jars.customer);
    assert.ok(alsKunde.status === 403 || alsKunde.status === 404, `Kundschaft darf nicht: ${alsKunde.status}`);

    // Nicht zugeteiltes Personal: die Berechtigung genügt nicht (§ 7).
    const zweiterEinsatz = await einsatzVorbereiten();
    await post(
      `/api/jobs/${zweiterEinsatz.id}/assign`,
      { employeeIds: [annaEmployeeId], notify: false },
      { jar: jars.admin },
    );
    // Anna ist zugeteilt — die Gegenprobe macht der nächste Fall über die DB.

    const mitarbeiter = await frischeMitarbeiterSitzung();
    const erlaubt = await uebergeben(job.id, mitarbeiter);
    assert.equal(erlaubt.status, 200, erlaubt.text);
    assert.match(data(erlaubt).signatureUrl, /^\/abnahme\/[0-9a-f]{32}$/);

    // Aufräumen: entsperren, damit die Sitzung nicht offen bleibt.
    const frei = await post('/api/handoff/unlock', { password: ACCOUNTS.employee.password }, { jar: mitarbeiter });
    assert.equal(frei.status, 200, frei.text);
  });

  it('verweigert den Start auf einem Einsatz ohne Zuteilung', ohneDb, async () => {
    const job = await einsatzVorbereiten();
    // Zuteilung entfernen — die Berechtigung bleibt, die Zuständigkeit nicht.
    await db!.jobAssignment.deleteMany({ where: { jobId: job.id } });

    const mitarbeiter = await frischeMitarbeiterSitzung();
    const versuch = await uebergeben(job.id, mitarbeiter);
    assert.equal(versuch.status, 403, versuch.text);
    assert.equal(await db!.signatureRequest.count({ where: { jobId: job.id } }), 0, 'kein Vorgang');
    assert.equal(
      await db!.deviceHandoffSession.count({ where: { jobId: job.id } }),
      0,
      'und keine Sperre',
    );
  });

  it('verweigert den Start auf einem noch nicht abgeschlossenen Einsatz', ohneDb, async () => {
    const job = await einsatzVorbereiten({ abschliessen: false });
    const mitarbeiter = await frischeMitarbeiterSitzung();
    const versuch = await uebergeben(job.id, mitarbeiter);
    assert.equal(versuch.status, 422, versuch.text);
    assert.match(versuch.text, /noch nicht abgeschlossen/i);
    assert.equal(await db!.signatureRequest.count({ where: { jobId: job.id } }), 0);
  });
});

// ---------------------------------------------------------------------------
//  Der vollständige Weg (§ 72, § 73)
// ---------------------------------------------------------------------------

describe('Der vollständige Weg über das Gerät', () => {
  it('führt getippt von der Übergabe bis zur Rückgabe', ohneDb, async () => {
    const job = await einsatzVorbereiten();
    const mitarbeiter = await frischeMitarbeiterSitzung();
    const familieVorher = await familieVon(mitarbeiter);
    assert.ok(familieVorher, 'die frische Anmeldung hat eine Rotationsfamilie');

    const start = await uebergeben(job.id, mitarbeiter);
    assert.equal(start.status, 200, start.text);
    const publicId = data(start).publicId;
    const sigJar = signaturJar(start);

    // Der Einsatz ist noch nicht abgenommen — der Start entscheidet nichts.
    assert.equal((await jobLesen(job.id)).customerAcceptedAt, null);

    const vorgang = await offenerVorgang(job.id);
    assert.ok(vorgang, 'ein Abnahmevorgang ist entstanden');
    assert.equal(vorgang.ceremonyMode, 'IN_PERSON_HANDOFF');
    assert.equal(vorgang.assuranceLevel, 'LINK_ONLY');
    assert.equal(vorgang.consentVersion, 'rapport-v1', 'der rapportspezifische Zustimmungstext (§ 16)');
    assert.equal(vorgang.participants.length, 1);

    /**
     * Der Hergang steht als **Spalte**, nicht nur in einer JSON-Notiz — und
     * er benennt die Person aus dem Betrieb als diejenige, die das Gerät
     * bereitgestellt hat (§ 5, § 53).
     */
    assert.equal(vorgang.presentedById, annaUserId);
    assert.ok(vorgang.presentedByName, 'der Name ist als Schnappschuss festgehalten');

    // Die Sperre hängt an genau dieser Familie (§ 24).
    const sperre = await db!.deviceHandoffSession.findFirstOrThrow({ where: { jobId: job.id } });
    assert.equal(sperre.status, 'ACTIVE');
    assert.equal(sperre.sessionFamily, familieVorher);
    assert.equal(sperre.userId, annaUserId);

    // Der Kundenmodus sieht genau Hash A (§ 11, § 66).
    const dokument = await fetch(`${BASE_URL}/api/public/signatures/${publicId}/document`, {
      headers: { cookie: sigJar },
    });
    assert.equal(dokument.status, 200);
    const gezeigt = Buffer.from(await dokument.arrayBuffer());
    assert.equal(sha256(gezeigt), vorgang.originalDocumentHash, 'gezeigt wird bytegenau A');
    assert.match(
      dokument.headers.get('cache-control') ?? '',
      /no-store/,
      'der Rapport landet in keinem Zwischenspeicher (§ 35)',
    );

    const fertig = await abschliessen(publicId, sigJar, { method: 'TYPED', name: 'Nicole Wyss' });
    assert.equal(fertig.status, 200, fertig.text);
    assert.equal(data(fertig).requestStatus, 'COMPLETED');

    // Erst jetzt ist der Einsatz abgenommen (§ 23).
    const nachher = await jobLesen(job.id);
    assert.ok(nachher.customerAcceptedAt, 'die Abnahme ist gebucht');
    assert.equal(nachher.signatureDataUrl, null, 'kein Altbestandsfeld geschrieben (§ 59)');
    assert.equal(nachher.signatureName, null, 'kein Altbestandsfeld geschrieben (§ 59)');
    assert.equal(
      nachher.status,
      'COMPLETED',
      'die Kundenabnahme macht keinen VERIFIED daraus — das bleibt die Bürokontrolle (§ 3)',
    );

    // A, B und C (§ 56).
    const admin = await db!.signatureRequest.findUniqueOrThrow({ where: { id: vorgang.id } });
    assert.equal(admin.status, 'COMPLETED');
    assert.ok(admin.signedArtifactHash && admin.evidenceArtifactHash);
    assert.notEqual(admin.originalDocumentHash, admin.signedArtifactHash, 'A ≠ B');
    assert.notEqual(admin.signedArtifactHash, admin.evidenceArtifactHash, 'B ≠ C');
    assert.equal(admin.originalDocumentHash, vorgang.originalDocumentHash, 'A ist unverändert (§ 56)');

    /**
     * § 37: Die Unterschrift gibt das Gerät **nicht** frei. Sonst zeigte ein
     * liegengelassenes Telefon direkt nach der Unterschrift wieder den
     * Mitarbeiterbereich.
     */
    const nochGesperrt = await get('/api/jobs', { jar: mitarbeiter });
    assert.equal(nochGesperrt.status, 423, 'nach der Unterschrift bleibt gesperrt');

    // Rückgabe: Passwort bestätigen, keine Anmeldung (§ 38, § 78).
    const frei = await post<{ data: { jobId: string } }>(
      '/api/handoff/unlock',
      { password: ACCOUNTS.employee.password },
      { jar: mitarbeiter },
    );
    assert.equal(frei.status, 200, frei.text);
    assert.equal(data(frei).jobId, job.id);

    const nachFreigabe = frei.cookies || mitarbeiter;
    const familieNachher = await familieVon(nachFreigabe);
    assert.equal(
      familieNachher,
      familieVorher,
      'dieselbe Rotationsfamilie — kein Abmelden, keine zweite Anmeldung (§ 78)',
    );

    const wiederOffen = await get('/api/jobs', { jar: nachFreigabe });
    assert.equal(wiederOffen.status, 200, 'der Mitarbeiterbereich ist wieder da');
  });

  it('führt gezeichnet zum selben Ergebnis', ohneDb, async () => {
    const job = await einsatzVorbereiten();
    const mitarbeiter = await frischeMitarbeiterSitzung();
    const start = await uebergeben(job.id, mitarbeiter);
    assert.equal(start.status, 200, start.text);

    const fertig = await abschliessen(data(start).publicId, signaturJar(start), {
      method: 'DRAWN',
      name: 'Nicole Wyss',
      imageDataUrl: pngDataUrl(),
    });
    assert.equal(fertig.status, 200, fertig.text);

    assert.ok((await jobLesen(job.id)).customerAcceptedAt, 'auch gezeichnet wird abgenommen');
    const vorgang = await db!.signatureRequest.findFirstOrThrow({
      where: { jobId: job.id },
      include: { participants: true },
    });
    assert.equal(vorgang.participants[0]!.signatureMethod, 'DRAWN');
    assert.ok(vorgang.signedArtifactHash && vorgang.evidenceArtifactHash);

    // Das signierte PDF trägt Original plus Signaturseite (§ 57).
    const asset = await db!.fileAsset.findUniqueOrThrow({
      where: { id: vorgang.signedArtifactId! },
      include: { storedFile: true },
    });
    const doc = await PDFDocument.load(Buffer.from(asset.storedFile!.data!));
    assert.ok(doc.getPageCount() >= 2, `Rapport plus Signaturseite, nicht ${doc.getPageCount()}`);

    await post('/api/handoff/unlock', { password: ACCOUNTS.employee.password }, { jar: mitarbeiter });
  });
});

// ---------------------------------------------------------------------------
//  Die Sperre (§ 67–§ 70, § 76)
// ---------------------------------------------------------------------------

describe('Die Gerätesperre', () => {
  it('sperrt jeden angemeldeten Endpunkt — auch aus einem zweiten Tab', ohneDb, async () => {
    const job = await einsatzVorbereiten();
    const mitarbeiter = await frischeMitarbeiterSitzung();
    const start = await uebergeben(job.id, mitarbeiter);
    assert.equal(start.status, 200, start.text);

    /**
     * Ein zweiter Tab ist technisch derselbe Cookie-Vorrat — genau das ist
     * der Punkt (§ 31, § 68). Eine Umleitung in der Maske hülfe hier nicht;
     * geprüft wird der Server.
     */
    const gesperrt = [
      await get('/api/jobs', { jar: mitarbeiter }),
      await get('/api/customers', { jar: mitarbeiter }),
      await get('/api/messages/threads', { jar: mitarbeiter }),
      await get('/api/notifications', { jar: mitarbeiter }),
      await get(`/api/jobs/${job.id}`, { jar: mitarbeiter }),
      await post(`/api/jobs/${job.id}/complete`, { materials: [] }, { jar: mitarbeiter }),
      await patch(`/api/jobs/${job.id}`, { title: 'Umbenannt' }, { jar: mitarbeiter }),
    ];
    for (const antwort of gesperrt) {
      assert.equal(antwort.status, 423, `423 erwartet, war ${antwort.status}: ${antwort.text.slice(0, 120)}`);
    }

    // Auch eine Seite, nicht nur die API (§ 76).
    const seite = await get('/portal', { jar: mitarbeiter, redirect: 'manual' });
    assert.ok(
      [302, 303, 307, 308, 423].includes(seite.status),
      `die Seite darf keinen Mitarbeiterinhalt zeigen, war ${seite.status}`,
    );

    await post('/api/handoff/unlock', { password: ACCOUNTS.employee.password }, { jar: mitarbeiter });
  });

  it('bleibt gesperrt, wenn das Zugangstoken gelöscht und erneuert wird', ohneDb, async () => {
    const job = await einsatzVorbereiten();
    const mitarbeiter = await frischeMitarbeiterSitzung();
    const start = await uebergeben(job.id, mitarbeiter);
    assert.equal(start.status, 200, start.text);

    /**
     * Der Umweg, den § 70 verlangt: Das Zugangstoken — der Träger der Sperre —
     * wird weggeworfen, nur der Refresh-Token bleibt. Wäre die Sperre allein
     * ein Anspruch im Token, käme jetzt ein unbelastetes zurück. Sie steht
     * aber in der Datenbank, und `createSession` schlägt sie bei **jeder**
     * Ausstellung nach.
     */
    const nurRefresh = /clenaris_rt=[^;]+/.exec(mitarbeiter)![0];

    const erneuert = await post('/api/auth/refresh', undefined, { jar: nurRefresh });
    assert.equal(erneuert.status, 200, `die Erneuerung selbst gelingt: ${erneuert.text}`);

    const neuesJar = erneuert.cookies;
    assert.match(neuesJar, /clenaris_at=/, 'ein frisches Zugangstoken ist gesetzt');

    const weiterhin = await get('/api/jobs', { jar: neuesJar });
    assert.equal(weiterhin.status, 423, 'das erneuerte Token trägt die Sperre erneut (§ 70)');

    await post('/api/handoff/unlock', { password: ACCOUNTS.employee.password }, { jar: neuesJar });
  });

  it('sperrt ein zweites Gerät derselben Person nicht mit', ohneDb, async () => {
    const job = await einsatzVorbereiten();
    const geraetA = await frischeMitarbeiterSitzung();
    const geraetB = await frischeMitarbeiterSitzung();
    assert.notEqual(await familieVon(geraetA), await familieVon(geraetB), 'zwei Familien');

    const start = await uebergeben(job.id, geraetA);
    assert.equal(start.status, 200, start.text);

    assert.equal((await get('/api/jobs', { jar: geraetA })).status, 423, 'Gerät A ist gesperrt');
    assert.equal(
      (await get('/api/jobs', { jar: geraetB })).status,
      200,
      'Gerät B arbeitet weiter — die Sperre gilt einem Browser, nicht einer Person (§ 32)',
    );

    await post('/api/handoff/unlock', { password: ACCOUNTS.employee.password }, { jar: geraetA });
  });

  it('lässt die beiden Endpunkte durch, die den Weg zurück bilden', ohneDb, async () => {
    const job = await einsatzVorbereiten();
    const mitarbeiter = await frischeMitarbeiterSitzung();
    const start = await uebergeben(job.id, mitarbeiter);
    assert.equal(start.status, 200, start.text);

    const zustand = await get<{ data: { active: boolean; jobNumber: string } }>('/api/handoff', {
      jar: mitarbeiter,
    });
    assert.equal(zustand.status, 200, 'die Statusabfrage antwortet trotz Sperre (§ 29)');
    assert.equal(data(zustand).active, true);
    assert.equal(data(zustand).jobNumber, job.number);

    // Und sie gibt keine Rapport- oder Kundendaten preis.
    assert.doesNotMatch(zustand.text, /Nicole|Wyss|Bahnhofstrasse/i, 'keine Kundendaten im Zustand');

    await post('/api/handoff/unlock', { password: ACCOUNTS.employee.password }, { jar: mitarbeiter });
  });
});

// ---------------------------------------------------------------------------
//  Entsperren (§ 77, § 78)
// ---------------------------------------------------------------------------

describe('Das Entsperren', () => {
  it('verlangt das richtige Passwort und akzeptiert kein fremdes', ohneDb, async () => {
    const job = await einsatzVorbereiten();
    const mitarbeiter = await frischeMitarbeiterSitzung();
    const start = await uebergeben(job.id, mitarbeiter);
    assert.equal(start.status, 200, start.text);

    const falsch = await post('/api/handoff/unlock', { password: 'Falsch#2026' }, { jar: mitarbeiter });
    assert.equal(falsch.status, 401, falsch.text);
    assert.equal((await get('/api/jobs', { jar: mitarbeiter })).status, 423, 'weiterhin gesperrt');

    // Das Passwort einer anderen Person hilft nicht.
    const fremd = await post(
      '/api/handoff/unlock',
      { password: ACCOUNTS.admin.password },
      { jar: mitarbeiter },
    );
    assert.equal(fremd.status, 401, fremd.text);
    assert.equal((await get('/api/jobs', { jar: mitarbeiter })).status, 423, 'immer noch gesperrt');

    const richtig = await post(
      '/api/handoff/unlock',
      { password: ACCOUNTS.employee.password },
      { jar: mitarbeiter },
    );
    assert.equal(richtig.status, 200, richtig.text);

    const sperre = await db!.deviceHandoffSession.findFirstOrThrow({ where: { jobId: job.id } });
    assert.equal(sperre.status, 'RELEASED');
    assert.ok(sperre.releasedAt, 'mit Zeitpunkt');
  });

  it('entsperrt die Sitzung einer anderen Person nicht', ohneDb, async () => {
    const job = await einsatzVorbereiten();
    const mitarbeiter = await frischeMitarbeiterSitzung();
    const start = await uebergeben(job.id, mitarbeiter);
    assert.equal(start.status, 200, start.text);

    /**
     * Die Verwaltung ist nicht gesperrt — ihr Browser hat nichts übergeben.
     * Ihr Entsperrversuch findet deshalb keine Übergabe und darf die fremde
     * auf keinen Fall aufheben.
     */
    const durchAdmin = await post(
      '/api/handoff/unlock',
      { password: ACCOUNTS.admin.password },
      { jar: jars.admin },
    );
    assert.equal(durchAdmin.status, 404, durchAdmin.text);

    assert.equal(
      (await get('/api/jobs', { jar: mitarbeiter })).status,
      423,
      'die fremde Sperre besteht unverändert',
    );

    await post('/api/handoff/unlock', { password: ACCOUNTS.employee.password }, { jar: mitarbeiter });
  });
});

// ---------------------------------------------------------------------------
//  Rapport einfrieren (§ 65, § 79, § 83)
// ---------------------------------------------------------------------------

describe('Der eingefrorene Rapport', () => {
  it('verweigert jede signaturrelevante Änderung während der Übergabe', ohneDb, async () => {
    const job = await einsatzVorbereiten();
    const mitarbeiter = await frischeMitarbeiterSitzung();
    const start = await uebergeben(job.id, mitarbeiter);
    assert.equal(start.status, 200, start.text);

    const vorgang = await offenerVorgang(job.id);
    assert.ok(vorgang);
    const hashA = vorgang.originalDocumentHash;

    /**
     * Die Sperre der eigenen Sitzung ist das eine — aber der Rapport muss
     * auch gegen **andere** Zugänge eingefroren sein (§ 13). Die Verwaltung
     * ist nicht gesperrt; ihre Änderung trifft trotzdem auf die
     * Geschäftsregel.
     */
    const durchAdmin = await patch(`/api/jobs/${job.id}`, { title: 'Heimlich umbenannt' }, { jar: jars.admin });
    assert.equal(durchAdmin.status, 422, durchAdmin.text);
    assert.match(durchAdmin.text, /Kundenabnahme|festgehalten/i);

    const checkliste = await put(`/api/jobs/${job.id}/checklist`, { items: [] }, { jar: jars.admin });
    assert.equal(checkliste.status, 422, checkliste.text);

    // Der Snapshot ist unverändert geblieben.
    const asset = await db!.fileAsset.findUniqueOrThrow({
      where: { id: vorgang.originalArtifactId },
      include: { storedFile: true },
    });
    assert.equal(sha256(Buffer.from(asset.storedFile!.data!)), hashA, 'A bytegenau (§ 65)');

    await post('/api/handoff/unlock', { password: ACCOUNTS.employee.password }, { jar: mitarbeiter });

    // Nach dem Abbruch ist der Rapport wieder bearbeitbar (§ 83).
    const abbruch = await del(`/api/jobs/${job.id}/handoff`, { jar: mitarbeiter });
    assert.equal(abbruch.status, 200, abbruch.text);

    const danach = await db!.signatureRequest.findUniqueOrThrow({ where: { id: vorgang.id } });
    assert.equal(danach.status, 'CANCELLED');
    assert.equal(danach.originalDocumentHash, hashA, 'der alte Snapshot bleibt als Beleg');

    const jetztErlaubt = await patch(`/api/jobs/${job.id}`, { title: 'Korrigiert' }, { jar: jars.admin });
    assert.equal(jetztErlaubt.status, 200, jetztErlaubt.text);
    assert.equal((await jobLesen(job.id)).customerAcceptedAt, null, 'nichts abgenommen');
  });

  it('verweigert den Abschluss, wenn die Originalbytes manipuliert wurden', ohneDb, async () => {
    const job = await einsatzVorbereiten();
    const mitarbeiter = await frischeMitarbeiterSitzung();
    const start = await uebergeben(job.id, mitarbeiter);
    assert.equal(start.status, 200, start.text);
    const sigJar = signaturJar(start);

    const vorgang = await offenerVorgang(job.id);
    assert.ok(vorgang);
    const asset = await db!.fileAsset.findUniqueOrThrow({
      where: { id: vorgang.originalArtifactId },
      include: { storedFile: true },
    });
    const unversehrt = Buffer.from(asset.storedFile!.data!);

    await db!.storedFile.update({
      where: { id: asset.storedFile!.id },
      data: { data: Buffer.concat([unversehrt, Buffer.from(' ')]) },
    });
    try {
      const versuch = await abschliessen(data(start).publicId, sigJar);
      assert.equal(versuch.status, 422, versuch.text);

      assert.equal((await jobLesen(job.id)).customerAcceptedAt, null, 'nicht abgenommen (§ 79)');
      const nachher = await db!.signatureRequest.findUniqueOrThrow({ where: { id: vorgang.id } });
      assert.equal(nachher.status, 'PENDING', 'kein Abschluss');
      assert.equal(nachher.signedArtifactId, null);
      const ereignis = await db!.signatureEvent.findFirst({
        where: { requestId: vorgang.id, type: 'INTEGRITY_FAILED' },
      });
      assert.ok(ereignis, 'INTEGRITY_FAILED protokolliert');
    } finally {
      await db!.storedFile.update({ where: { id: asset.storedFile!.id }, data: { data: unversehrt } });
      await post('/api/handoff/unlock', { password: ACCOUNTS.employee.password }, { jar: mitarbeiter });
    }
  });
});

// ---------------------------------------------------------------------------
//  Gleichzeitigkeit (§ 80–§ 82)
// ---------------------------------------------------------------------------

describe('Gleichzeitigkeit', () => {
  it('erzeugt bei vier gleichzeitigen Starts einen Vorgang und eine Sperre', ohneDb, async () => {
    const job = await einsatzVorbereiten();
    const mitarbeiter = await frischeMitarbeiterSitzung();

    const antworten = await Promise.all([
      uebergeben(job.id, mitarbeiter),
      uebergeben(job.id, mitarbeiter),
      uebergeben(job.id, mitarbeiter),
      uebergeben(job.id, mitarbeiter),
    ]);
    assert.ok(
      antworten.some((a) => a.status === 200),
      `mindestens einer gewinnt: ${antworten.map((a) => a.status).join(', ')}`,
    );

    assert.equal(
      await db!.signatureRequest.count({ where: { jobId: job.id } }),
      1,
      'genau ein Vorgang, nicht vier Snapshots (§ 80)',
    );
    assert.equal(
      await db!.deviceHandoffSession.count({ where: { jobId: job.id, status: 'ACTIVE' } }),
      1,
      'genau eine aktive Sperre',
    );

    await post('/api/handoff/unlock', { password: ACCOUNTS.employee.password }, { jar: mitarbeiter });
  });

  it('nimmt bei vier gleichzeitigen Abschlüssen genau einmal ab', ohneDb, async () => {
    const job = await einsatzVorbereiten();
    const mitarbeiter = await frischeMitarbeiterSitzung();
    const start = await uebergeben(job.id, mitarbeiter);
    assert.equal(start.status, 200, start.text);
    const publicId = data(start).publicId;
    const sigJar = signaturJar(start);

    const ergebnisse = await Promise.all([
      abschliessen(publicId, sigJar),
      abschliessen(publicId, sigJar),
      abschliessen(publicId, sigJar),
      abschliessen(publicId, sigJar),
    ]);
    assert.ok(
      ergebnisse.some((r) => r.status === 200),
      `mindestens einer schliesst ab: ${ergebnisse.map((r) => r.status).join(', ')}`,
    );

    const vorgang = await db!.signatureRequest.findFirstOrThrow({ where: { jobId: job.id } });
    assert.equal(vorgang.status, 'COMPLETED');
    assert.equal(
      await db!.signatureEvent.count({ where: { requestId: vorgang.id, type: 'REQUEST_COMPLETED' } }),
      1,
      'genau ein REQUEST_COMPLETED (§ 81)',
    );
    assert.equal(
      await db!.auditLog.count({
        where: { entity: 'Job', entityId: job.id, summary: { contains: 'elektronisch abgenommen' } },
      }),
      1,
      'genau eine Abnahme im Prüfprotokoll',
    );

    await post('/api/handoff/unlock', { password: ACCOUNTS.employee.password }, { jar: mitarbeiter });
  });

  it('nimmt einen abgesagten Einsatz nicht mehr ab', ohneDb, async () => {
    const job = await einsatzVorbereiten();
    const mitarbeiter = await frischeMitarbeiterSitzung();
    const start = await uebergeben(job.id, mitarbeiter);
    assert.equal(start.status, 200, start.text);

    /**
     * Der Bruch aus § 82/§ 50: Zwischen Snapshot und Abschluss verliert der
     * Einsatz seine Abnahmefähigkeit. Die Unterschrift gelingt technisch,
     * trifft aber nichts mehr — und darf keinen stillen Endzustand
     * hinterlassen.
     */
    await db!.job.update({ where: { id: job.id }, data: { status: 'CANCELLED' } });

    const versuch = await abschliessen(data(start).publicId, signaturJar(start));
    void versuch;

    const nachher = await jobLesen(job.id);
    assert.equal(nachher.customerAcceptedAt, null, 'kein abgesagter Einsatz wird abgenommen');

    const vorgang = await db!.signatureRequest.findFirstOrThrow({ where: { jobId: job.id } });
    assert.notEqual(vorgang.status, 'COMPLETED', 'kein COMPLETED ohne Abnahme (§ 50)');
    if (vorgang.status === 'CANCELLED') {
      const ereignis = await db!.signatureEvent.findFirst({
        where: { requestId: vorgang.id, type: 'CANCELLED' },
        orderBy: { at: 'desc' },
      });
      assert.equal(
        (ereignis?.details as { reason?: string } | null)?.reason,
        'job_not_acceptable_at_completion',
        'mit nachvollziehbarem Grund',
      );
    }

    await post('/api/handoff/unlock', { password: ACCOUNTS.employee.password }, { jar: mitarbeiter });
  });
});

// ---------------------------------------------------------------------------
//  Ablehnung, Zuschreibung, Altbestand (§ 71, § 74, § 84, § 85)
// ---------------------------------------------------------------------------

describe('Ablehnung, Zuschreibung und Altbestand', () => {
  it('behandelt eine Ablehnung als Ablehnung — und lässt das Gerät gesperrt', ohneDb, async () => {
    const job = await einsatzVorbereiten();
    const mitarbeiter = await frischeMitarbeiterSitzung();
    const start = await uebergeben(job.id, mitarbeiter);
    assert.equal(start.status, 200, start.text);

    const abgelehnt = await post(
      `/api/public/signatures/${data(start).publicId}/decline`,
      { reason: 'Fenster fehlen' },
      { jar: signaturJar(start) },
    );
    assert.ok([200, 204].includes(abgelehnt.status), `Ablehnung angenommen: ${abgelehnt.status}`);

    const nachher = await jobLesen(job.id);
    assert.equal(nachher.customerAcceptedAt, null, 'nicht abgenommen (§ 74)');
    assert.equal(nachher.status, 'COMPLETED', 'der Einsatz bleibt, was er war');

    const vorgang = await db!.signatureRequest.findFirstOrThrow({ where: { jobId: job.id } });
    assert.equal(vorgang.signedArtifactId, null, 'kein signiertes Artefakt bei Ablehnung');

    assert.equal(
      (await get('/api/jobs', { jar: mitarbeiter })).status,
      423,
      'auch nach einer Ablehnung bleibt das Gerät gesperrt (§ 74)',
    );

    await post('/api/handoff/unlock', { password: ACCOUNTS.employee.password }, { jar: mitarbeiter });
  });

  it('schreibt die Unterschrift der Kundschaft zu, nie dem Personal', ohneDb, async () => {
    const job = await einsatzVorbereiten();
    const mitarbeiter = await frischeMitarbeiterSitzung();
    const start = await uebergeben(job.id, mitarbeiter);
    assert.equal(start.status, 200, start.text);

    const fertig = await abschliessen(data(start).publicId, signaturJar(start), {
      method: 'TYPED',
      name: 'Vertretung Vor Ort',
    });
    assert.equal(fertig.status, 200, fertig.text);

    const vorgang = await db!.signatureRequest.findFirstOrThrow({
      where: { jobId: job.id },
      include: { participants: true },
    });
    const teilnehmer = vorgang.participants[0]!;

    // Das Personal stellt bereit — es unterschreibt nicht (§ 18, § 71).
    assert.equal(vorgang.presentedById, annaUserId, 'Gerät bereitgestellt durch das Personal');
    assert.notEqual(teilnehmer.customerId, null, 'der Teilnehmer ist die Kundschaft');
    assert.equal(
      teilnehmer.signedName,
      'Vertretung Vor Ort',
      'der vor Ort eingegebene Name steht getrennt vom erwarteten (§ 14, § 15)',
    );
    assert.notEqual(
      teilnehmer.nameSnapshot,
      'Vertretung Vor Ort',
      'der erwartete Name bleibt der aus dem Kundendatensatz',
    );

    // Das Prüfprotokoll nennt keinen Mitarbeiter als Unterzeichner (§ 51).
    const eintraege = await db!.auditLog.findMany({
      where: { entity: 'Job', entityId: job.id },
      select: { summary: true, userId: true },
    });
    const abnahme = eintraege.find((e) => e.summary?.includes('elektronisch abgenommen'));
    assert.ok(abnahme, 'die Abnahme steht im Prüfprotokoll');
    assert.equal(abnahme.userId, null, 'ohne Personalkonto als Urheber (§ 51)');
    assert.match(abnahme.summary!, /Gerät bereitgestellt durch/, 'mit der richtigen Rolle benannt');

    /**
     * § 85: Der Beweis darf nicht mehr behaupten, als erhoben wurde. Kein
     * „QES", keine geprüfte Identität, keine Vollmacht.
     */
    const evidence = await db!.fileAsset.findUniqueOrThrow({
      where: { id: vorgang.evidenceArtifactId! },
      include: { storedFile: true },
    });
    const protokoll = await PDFDocument.load(Buffer.from(evidence.storedFile!.data!));
    assert.ok(protokoll.getPageCount() >= 1, 'das Protokoll ist ein lesbares PDF');

    const texte = [
      vorgang.presentedByName ?? '',
      teilnehmer.consentTextSnapshot ?? '',
      abnahme.summary ?? '',
    ].join(' ');
    for (const verboten of [
      /qualifizierte elektronische Signatur/i,
      /\bQES\b/,
      /Identität (wurde )?(geprüft|verifiziert)/i,
      /Ausweis/i,
      /bevollmächtigt/i,
    ]) {
      assert.doesNotMatch(texte, verboten, `keine Überbehauptung: ${verboten}`);
    }

    await post('/api/handoff/unlock', { password: ACCOUNTS.employee.password }, { jar: mitarbeiter });
  });

  it('lässt historische Einsatzsignaturen unverändert', ohneDb, async () => {
    const job = await einsatzVorbereiten();

    /**
     * Ein Einsatz, wie er vor Gate 4D abgenommen wurde: die drei Altfelder,
     * kein Vorgang. Er muss lesbar bleiben — und darf keinen erfundenen
     * Beweis bekommen (§ 84, § 4).
     */
    await db!.job.update({
      where: { id: job.id },
      data: { signatureDataUrl: pngDataUrl(), signatureName: 'Alt Bestand', signedAt: new Date() },
    });

    const detail = await get(`/api/jobs/${job.id}`, { jar: jars.admin });
    assert.equal(detail.status, 200, 'der historische Einsatz bleibt lesbar');

    const bericht = await get(`/api/jobs/${job.id}/report`, { jar: jars.admin });
    assert.ok([200, 201].includes(bericht.status), `und sein Bericht ebenfalls: ${bericht.status}`);

    assert.equal(
      await db!.signatureRequest.count({ where: { jobId: job.id } }),
      0,
      'kein nachträglich erfundener Vorgang',
    );
    const unveraendert = await jobLesen(job.id);
    assert.equal(unveraendert.signatureName, 'Alt Bestand', 'die Altfelder bleiben, wie sie waren');
    assert.equal(unveraendert.customerAcceptedAt, null, 'und gelten nicht als Gate-4D-Abnahme');
  });
});
