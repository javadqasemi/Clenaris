import { strict as assert } from 'node:assert';
import { hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { SignJWT } from 'jose';

import { data, del, get, patch, post, put } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb';

/**
 * Die Release-Blocker des Vertragsmoduls aus dem Audit vom 2026-09-23 —
 * jeder mit dem Fall, der ihn belegt hatte, und der Zusicherung, die ihn
 * schliesst.
 *
 * | Blocker | Befund                                                           |
 * |---------|------------------------------------------------------------------|
 * | RB-002  | Folgefassung an laufendem Vertrag nie aktivierbar                 |
 * | RB-003  | Doppelte Einsätze über einen Fassungswechsel                      |
 * | RB-004  | Reaktivierung überschrieb die Gültigkeiten aller Fassungen        |
 * | RB-005  | Unterschrift schloss an storniertem/gelöschtem Vertrag ab         |
 * | RB-006  | Plan und Stichtag einer signierten Fassung änderbar               |
 * | RB-007  | Pause/Ausnahme ohne Wirkung auf geplante Einsätze; Vergangenheit  |
 * | RB-008  | Abrechnung mit aktueller statt damals gültiger Fassung; Überlappung |
 * | RB-011  | Begehung verband Vertrag und Objekt verschiedener Kundschaft      |
 *
 * **Gemessen wird an der Datenbank**, wo es um Mengen und Zustände geht:
 * „kein Termin doppelt" ist eine Aussage über Zeilen, nicht über eine Zahl
 * im Antwortkörper. Die Datenbank wird dabei nur gelesen — mit einer
 * Ausnahme: Der Block „Unveränderlichkeit in der Datenbank" versucht
 * absichtlich, an der Anwendung vorbei zu schreiben, und erwartet, dass die
 * Trigger es verweigern.
 *
 * Verträge, die in Kraft waren, lassen sich nicht löschen; sie werden am Ende
 * beendet. Das ist die Regel des Moduls, keine Lücke der Prüfreihe.
 */

let jars: Record<AccountName, string>;
const db = testDb();
const ohneDb = { skip: db ? false : `Keine Testdatenbank: ${testDbGrund()}` };

let kundeId = '';
let objektId = '';
let fremdesObjektId = '';
let leistungId = '';
const angelegt: string[] = [];

const TAG = 86_400_000;
const heute = new Date();
const tagIn = (n: number) =>
  new Date(Date.UTC(heute.getUTCFullYear(), heute.getUTCMonth(), heute.getUTCDate() + n)).toISOString().slice(0, 10);
const alsDatum = (tag: string) => new Date(`${tag}T00:00:00Z`);

function konditionen(ueber: Record<string, unknown> = {}) {
  return {
    effectiveFrom: tagIn(1),
    reason: 'Fassung aus der Integritätsreihe',
    billingCycle: 'MONTHLY',
    paymentTermDays: 30,
    pricingModel: 'FIXED_PERIOD',
    baseAmount: 1200,
    vatRate: 8.1,
    noticePeriodDays: 90,
    renewalType: 'NONE',
    ...ueber,
  };
}

async function entwurf(ueber: { contract?: Record<string, unknown>; version?: Record<string, unknown> } = {}) {
  const antwort = await post<{ data: { id: string } }>(
    '/api/contracts',
    {
      contract: {
        customerId: kundeId,
        propertyId: objektId,
        title: `Integritätsprüfung ${Date.now()}-${angelegt.length}`,
        startDate: tagIn(1),
        ...ueber.contract,
      },
      version: konditionen(ueber.version),
      services: [
        { serviceId: leistungId, label: 'Unterhaltsreinigung', estimatedMinutes: 120, requiredCrewSize: 1, materialsBy: 'PROVIDER' },
      ],
    },
    { jar: jars.admin },
  );
  assert.equal(antwort.status, 201, JSON.stringify(antwort.payload));
  angelegt.push(data(antwort).id);
  return data(antwort).id;
}

async function akte(id: string) {
  const antwort = await get<{
    data: {
      status: string;
      versions: {
        id: string;
        versionNumber: number;
        status: string;
        effectiveFrom: string;
        effectiveUntil: string | null;
        baseAmount: number;
        acceptedAt: string | null;
        services: { id: string; schedules: { id: string }[] }[];
      }[];
    };
  }>(`/api/contracts/${id}`, { jar: jars.admin });
  assert.equal(antwort.status, 200, JSON.stringify(antwort.payload));
  return data(antwort);
}

/** Ein aktiver Vertrag mit wöchentlicher Serie (Mo, Mi). */
async function vertragMitSerie(ueber: { contract?: Record<string, unknown>; version?: Record<string, unknown> } = {}) {
  const id = await entwurf(ueber);
  const v1 = (await akte(id)).versions[0]!;
  const plan = await post<{ data: { id: string } }>(
    `/api/contract-services/${v1.services[0]!.id}/schedules`,
    {
      frequency: 'WEEKLY',
      weekdays: [1, 3],
      effectiveFrom: (ueber.version?.effectiveFrom as string | undefined) ?? tagIn(1),
      startMinute: 360,
      endMinute: 600,
    },
    { jar: jars.admin },
  );
  assert.equal(plan.status, 201, JSON.stringify(plan.payload));
  const aktiv = await post(`/api/contracts/${id}/activate`, {}, { jar: jars.admin });
  assert.equal(aktiv.status, 200, JSON.stringify(aktiv.payload));
  return { id, v1: v1.id, planId: data(plan).id };
}

async function folgefassung(id: string, ueber: Record<string, unknown>) {
  const antwort = await post<{ data: { id: string; versionNumber: number } }>(
    `/api/contracts/${id}/versions`,
    { version: konditionen(ueber) },
    { jar: jars.admin },
  );
  assert.equal(antwort.status, 201, JSON.stringify(antwort.payload));
  return data(antwort);
}

/** Geltende Einsätze eines Vertrags, gezählt je Serientermin. */
async function doppelteTermine(contractId: string): Promise<number> {
  const zeilen = await db!.job.groupBy({
    by: ['seriesKey', 'scheduleDate'],
    where: { contractId, status: { not: 'CANCELLED' }, deletedAt: null, seriesKey: { not: null } },
    _count: { _all: true },
  });
  return zeilen.filter((z) => z._count._all > 1).length;
}

// ---------------------------------------------------------------------------
//  Signatur-Werkzeuge — dieselbe Bauart wie in `offertannahme.test.ts`
// ---------------------------------------------------------------------------

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
    // keine .env
  }
  return null;
}

function wurzelschluessel(): Buffer | null {
  const enc = envWert('ENCRYPTION_KEY');
  const jwt = envWert('JWT_SECRET');
  if (enc && /^[0-9a-fA-F]{64}$/.test(enc)) return Buffer.from(enc, 'hex');
  if (jwt) return Buffer.from(hkdfSync('sha256', jwt, 'clenaris-feldverschluesselung', 'aes-256-gcm-v1', 32));
  return null;
}

/**
 * Eine Unterzeichnungssitzung wie `issueSignatureSession` — ohne den Tausch
 * zu verbrauchen (begrenzt auf 20 je zehn Minuten und Adresse).
 */
async function sitzungFuerFassung(contractVersionId: string) {
  const vorgang = await db!.signatureRequest.findFirst({
    where: { contractVersionId, status: { in: ['DRAFT', 'PENDING'] } },
    include: { participants: true },
  });
  assert.ok(vorgang, 'Es gibt einen offenen Annahmevorgang');
  const teilnehmer = vorgang.participants.find((p) => p.role === 'SIGNER') ?? vorgang.participants[0]!;
  const anker = await db!.publicAccessToken.findFirst({
    where: { purpose: 'SIGNATURE_ACCESS', resourceId: teilnehmer.id, revokedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(anker, 'Der Zugang des Teilnehmers besteht');
  const wurzel = wurzelschluessel();
  if (!wurzel) return null;
  const token = await new SignJWT({ typ: 'sig', scope: 'sign', req: vorgang.id, part: teilnehmer.id, tok: anker.id })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(randomBytes(16).toString('hex'))
    .setIssuedAt()
    .setExpirationTime('60m')
    .sign(new Uint8Array(Buffer.from(hkdfSync('sha256', wurzel, 'clenaris-abgeleitet', 'clenaris-signature-session-v1', 32))));
  return { jar: `clenaris_sig=${token}`, publicId: vorgang.publicId, requestId: vorgang.id };
}

const unterschreiben = (publicId: string, jar: string) =>
  post<{ data: { requestStatus: string } }>(
    `/api/public/signatures/${publicId}/complete`,
    { accepted: true, method: 'TYPED', name: 'Nicole Wyss' },
    { jar },
  );

// ---------------------------------------------------------------------------

before(async () => {
  jars = await loginAll();
  const kunden = await get<{ data: { id: string }[] }>('/api/customers?pageSize=1', { jar: jars.admin });
  kundeId = data(kunden)[0]!.id;
  const objekte = await get<{ data: { id: string; customerId: string }[] }>('/api/properties?pageSize=100', {
    jar: jars.admin,
  });
  objektId = data(objekte).find((o) => o.customerId === kundeId)?.id ?? data(objekte)[0]!.id;
  fremdesObjektId = data(objekte).find((o) => o.customerId !== kundeId)?.id ?? '';
  const leistungen = await get<{ data: { id: string }[] }>('/api/services?pageSize=1', { jar: jars.admin });
  leistungId = data(leistungen)[0]!.id;
});

after(async () => {
  for (const id of angelegt) {
    const weg = await del(`/api/contracts/${id}`, { jar: jars.admin }).catch(() => null);
    if (weg?.status === 204) continue;
    await post(`/api/contracts/${id}/end`, { reason: 'Aufräumen der Integritätsreihe' }, { jar: jars.admin }).catch(
      () => undefined,
    );
  }
  await testDbSchliessen();
});

// ---------------------------------------------------------------------------
//  RB-005 — Annahme nur an einem Vertrag, der gelten kann
// ---------------------------------------------------------------------------

describe('RB-005 — Unterschrift an storniertem oder gelöschtem Vertrag', () => {
  it('Stornieren bricht den Annahmevorgang ab; die Unterschrift danach schliesst nicht ab', ohneDb, async (t) => {
    const id = await entwurf();
    const fassung = (await akte(id)).versions[0]!.id;
    const start = await post(`/api/contracts/${id}/versions/${fassung}/acceptance`, {}, { jar: jars.admin });
    assert.equal(start.status, 201, JSON.stringify(start.payload));
    const sitzung = await sitzungFuerFassung(fassung);
    if (!sitzung) return t.skip('kein Schlüssel für die Unterzeichnungssitzung');

    const storno = await post(`/api/contracts/${id}/cancel`, { reason: 'Prüfreihe' }, { jar: jars.admin });
    assert.equal(storno.status, 200, JSON.stringify(storno.payload));

    const vorgang = await db!.signatureRequest.findUniqueOrThrow({ where: { id: sitzung.requestId } });
    assert.equal(vorgang.status, 'CANCELLED', 'Der Vorgang ist mit dem Vertrag abgebrochen');
    const offeneZugaenge = await db!.publicAccessToken.count({
      where: { purpose: 'SIGNATURE_ACCESS', revokedAt: null, resourceId: { in: (await db!.signatureParticipant.findMany({ where: { requestId: vorgang.id } })).map((p) => p.id) } },
    });
    assert.equal(offeneZugaenge, 0, 'Der Link der Kundschaft ist entwertet');

    const versuch = await unterschreiben(sitzung.publicId, sitzung.jar);
    assert.ok(versuch.status >= 400, `Die Unterschrift wird abgewiesen, war HTTP ${versuch.status}`);
    const nachher = await db!.contractVersion.findUniqueOrThrow({ where: { id: fassung } });
    assert.equal(nachher.acceptedAt, null, 'Die Fassung ist nicht angenommen');
  });

  it('Stornieren gegen Unterschreiben gleichzeitig: nie storniert und angenommen', ohneDb, async (t) => {
    for (let runde = 0; runde < 3; runde++) {
      const id = await entwurf();
      const fassung = (await akte(id)).versions[0]!.id;
      assert.equal((await post(`/api/contracts/${id}/versions/${fassung}/acceptance`, {}, { jar: jars.admin })).status, 201);
      const sitzung = await sitzungFuerFassung(fassung);
      if (!sitzung) return t.skip('kein Schlüssel für die Unterzeichnungssitzung');

      const [storno, unterschrift] = await Promise.all([
        post(`/api/contracts/${id}/cancel`, { reason: 'Wettlauf' }, { jar: jars.admin }),
        unterschreiben(sitzung.publicId, sitzung.jar),
      ]);

      const vertrag = await db!.contract.findUniqueOrThrow({ where: { id } });
      const version = await db!.contractVersion.findUniqueOrThrow({ where: { id: fassung } });
      assert.ok(
        !(vertrag.status === 'CANCELLED' && version.acceptedAt),
        `Runde ${runde}: storniert UND angenommen (Storno ${storno.status}, Unterschrift ${unterschrift.status})`,
      );
      // Genau einer hat gewonnen.
      if (vertrag.status === 'CANCELLED') {
        assert.equal(version.acceptedAt, null);
      } else {
        assert.ok(version.acceptedAt, `Runde ${runde}: weder storniert noch angenommen`);
        assert.equal(storno.status, 422, 'Die verlorene Stornierung wird abgewiesen');
      }
    }
  });

  it('eine angenommene Fassung macht den Vertrag unwiderruflich — annullieren und löschen 422', ohneDb, async (t) => {
    const id = await entwurf();
    const fassung = (await akte(id)).versions[0]!.id;
    assert.equal((await post(`/api/contracts/${id}/versions/${fassung}/acceptance`, {}, { jar: jars.admin })).status, 201);
    const sitzung = await sitzungFuerFassung(fassung);
    if (!sitzung) return t.skip('kein Schlüssel für die Unterzeichnungssitzung');
    const unterschrift = await unterschreiben(sitzung.publicId, sitzung.jar);
    assert.equal(unterschrift.status, 200, JSON.stringify(unterschrift.payload));
    assert.ok((await db!.contractVersion.findUniqueOrThrow({ where: { id: fassung } })).acceptedAt);

    assert.equal((await post(`/api/contracts/${id}/cancel`, {}, { jar: jars.admin })).status, 422);
    assert.equal((await del(`/api/contracts/${id}`, { jar: jars.admin })).status, 422);

    // RB-006: Plan und Stichtag einer angenommenen Fassung bleiben, wie unterschrieben.
    const leistung = (await akte(id)).versions[0]!.services[0]!.id;
    const plan = await post(
      `/api/contract-services/${leistung}/schedules`,
      { frequency: 'WEEKLY', weekdays: [2], effectiveFrom: tagIn(1), startMinute: 360, endMinute: 600 },
      { jar: jars.admin },
    );
    assert.equal(plan.status, 422, 'Kein neuer Einsatzplan an einer angenommenen Fassung');
    const andererStichtag = await post(`/api/contracts/${id}/activate`, { effectiveFrom: tagIn(9) }, { jar: jars.admin });
    assert.equal(andererStichtag.status, 422, 'Der unterschriebene Stichtag wird nicht überschrieben');

    const aktiv = await post(`/api/contracts/${id}/activate`, {}, { jar: jars.admin });
    assert.equal(aktiv.status, 200, JSON.stringify(aktiv.payload));
    const geltend = await db!.contractVersion.findUniqueOrThrow({ where: { id: fassung } });
    assert.equal(geltend.effectiveFrom.toISOString().slice(0, 10), tagIn(1), 'Er gilt ab dem vereinbarten Tag');
  });

  it('eine Folgefassung an einem laufenden Vertrag lässt sich zur Annahme schicken', ohneDb, async () => {
    const { id } = await vertragMitSerie();
    const v2 = await folgefassung(id, { effectiveFrom: tagIn(20), baseAmount: 1300 });
    const start = await post(`/api/contracts/${id}/versions/${v2.id}/acceptance`, {}, { jar: jars.admin });
    assert.equal(start.status, 201, JSON.stringify(start.payload));
    const wechsel = await post(`/api/contracts/${id}/versions/${v2.id}/activate`, {}, { jar: jars.admin });
    assert.equal(wechsel.status, 422, 'Während der Unterzeichnung wird nicht gewechselt');
  });
});

// ---------------------------------------------------------------------------
//  RB-002, RB-004 — Versionskette und Lebenslauf
// ---------------------------------------------------------------------------

describe('RB-002 — Fassungskette V1 → V2 → V3', () => {
  it('jede Folgefassung wird wirksam, genau eine gilt, die Geschichte bleibt', ohneDb, async () => {
    const { id, v1 } = await vertragMitSerie();
    const v2 = await folgefassung(id, { effectiveFrom: tagIn(10), baseAmount: 1300, reason: 'Zweite Fassung' });
    assert.equal((await post(`/api/contracts/${id}/versions/${v2.id}/activate`, {}, { jar: jars.admin })).status, 200);
    const v3 = await folgefassung(id, { effectiveFrom: tagIn(20), baseAmount: 1400, reason: 'Dritte Fassung' });
    assert.equal((await post(`/api/contracts/${id}/versions/${v3.id}/activate`, {}, { jar: jars.admin })).status, 200);

    const fassungen = await db!.contractVersion.findMany({ where: { contractId: id }, orderBy: { versionNumber: 'asc' } });
    assert.deepEqual(fassungen.map((f) => f.status), ['SUPERSEDED', 'SUPERSEDED', 'ACTIVE']);
    assert.equal(fassungen.filter((f) => f.status === 'ACTIVE').length, 1);
    assert.equal(fassungen[0]!.id, v1);
    assert.equal(fassungen[0]!.effectiveFrom.toISOString().slice(0, 10), tagIn(1), 'V1 beginnt, wo sie begann');
    assert.equal(fassungen[0]!.effectiveUntil?.toISOString().slice(0, 10), tagIn(10), 'V1 endet am Stichtag von V2');
    assert.equal(fassungen[1]!.effectiveUntil?.toISOString().slice(0, 10), tagIn(20), 'V2 endet am Stichtag von V3');
    assert.equal(Number(fassungen[0]!.baseAmount), 1200, 'Der Preis von V1 ist unverändert');
    assert.equal(Number(fassungen[1]!.baseAmount), 1300);
    assert.equal(await doppelteTermine(id), 0, 'Über zwei Wechsel kein Termin doppelt');
  });

  it('weist einen Stichtag in der Vergangenheit oder vor der geltenden Fassung ab (422)', ohneDb, async () => {
    const { id } = await vertragMitSerie({ contract: { startDate: tagIn(-10) }, version: { effectiveFrom: tagIn(-10) } });
    const v2 = await folgefassung(id, { effectiveFrom: tagIn(-3) });
    const rueckwirkend = await post(`/api/contracts/${id}/versions/${v2.id}/activate`, {}, { jar: jars.admin });
    assert.equal(rueckwirkend.status, 422, 'Rückwirkend nicht');
  });

  it('ein Entwurf lässt sich verwerfen — danach ist der Weg für eine neue Fassung frei', ohneDb, async () => {
    const { id } = await vertragMitSerie();
    const v2 = await folgefassung(id, { effectiveFrom: tagIn(30) });
    assert.equal((await post(`/api/contracts/${id}/versions`, { version: konditionen() }, { jar: jars.admin })).status, 422);
    assert.equal((await del(`/api/contracts/${id}/versions/${v2.id}`, { jar: jars.admin })).status, 200);
    assert.equal((await db!.contractVersion.findUniqueOrThrow({ where: { id: v2.id } })).status, 'DISCARDED');
    const v3 = await folgefassung(id, { effectiveFrom: tagIn(30) });
    assert.equal(v3.versionNumber, 3, 'Die Nummer des verworfenen Entwurfs bleibt vergeben');
  });

  it('ein Leistungszusatz im Entwurf behält den kopierten Einsatzplan', ohneDb, async () => {
    const { id } = await vertragMitSerie();
    const v2 = await folgefassung(id, { effectiveFrom: tagIn(30) });
    const vorher = (await akte(id)).versions.find((v) => v.id === v2.id)!;
    assert.equal(vorher.services[0]!.schedules.length, 1, 'Der Plan wurde mitkopiert');

    const antwort = await put(
      `/api/contracts/${id}/versions/${v2.id}/services`,
      {
        services: [
          { id: vorher.services[0]!.id, label: 'Unterhaltsreinigung', estimatedMinutes: 120, requiredCrewSize: 1, materialsBy: 'PROVIDER' },
          { label: 'Fenster', estimatedMinutes: 60, requiredCrewSize: 1, materialsBy: 'PROVIDER' },
        ],
      },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 200, JSON.stringify(antwort.payload));
    const nachher = (await akte(id)).versions.find((v) => v.id === v2.id)!;
    const behalten = nachher.services.find((s) => s.id === vorher.services[0]!.id);
    assert.ok(behalten, 'Die bestehende Zeile bleibt dieselbe');
    assert.equal(behalten!.schedules.length, 1, 'Ihr Einsatzplan ist nicht verloren');
    assert.equal(nachher.services.length, 2);
  });
});

describe('RB-004 — Pause, Kündigung und Rücknahme verändern keine Fassung', () => {
  it('Fortsetzen und Kündigung zurücknehmen lassen die Gültigkeiten stehen', ohneDb, async () => {
    const { id, v1 } = await vertragMitSerie();
    const vorher = await db!.contractVersion.findUniqueOrThrow({ where: { id: v1 } });

    assert.equal((await post(`/api/contracts/${id}/pause`, { pausedFrom: tagIn(3), reason: 'Umbau im Objekt' }, { jar: jars.admin })).status, 200);
    assert.equal((await post(`/api/contracts/${id}/activate`, {}, { jar: jars.admin })).status, 200, 'Aus der Pause über /activate');
    assert.equal((await post(`/api/contracts/${id}/notice`, { noticeGivenBy: 'PROVIDER', noticeGivenAt: tagIn(0) }, { jar: jars.admin })).status, 200);
    const zurueck = await post<{ data: { status: string; noticeGivenAt: string | null } }>(`/api/contracts/${id}/activate`, {}, { jar: jars.admin });
    assert.equal(zurueck.status, 200, JSON.stringify(zurueck.payload));
    assert.equal(data(zurueck).status, 'ACTIVE');
    assert.equal(data(zurueck).noticeGivenAt, null, 'Die Kündigung ist zurückgenommen');

    const nachher = await db!.contractVersion.findUniqueOrThrow({ where: { id: v1 } });
    assert.equal(nachher.status, 'ACTIVE');
    assert.equal(nachher.effectiveFrom.getTime(), vorher.effectiveFrom.getTime(), 'Der Beginn blieb');
    assert.equal(nachher.effectiveUntil, null, 'Kein Ende wurde gesetzt');
  });

  it('die Kündigung trägt den Tag, an dem gekündigt wurde', ohneDb, async () => {
    const { id } = await vertragMitSerie();
    const antwort = await post<{ data: { noticeGivenAt: string } }>(
      `/api/contracts/${id}/notice`,
      { noticeGivenBy: 'CUSTOMER', noticeGivenAt: tagIn(-2) },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 200, JSON.stringify(antwort.payload));
    assert.equal(data(antwort).noticeGivenAt.slice(0, 10), tagIn(-2));
  });
});

// ---------------------------------------------------------------------------
//  C2 — Unveränderlichkeit in der Datenbank
// ---------------------------------------------------------------------------

describe('Unveränderlichkeit in der Datenbank (Trigger)', () => {
  /**
   * Hier wird **absichtlich an der Anwendung vorbei** geschrieben — genau der
   * Weg, den ein künftiger Codepfad, ein `updateMany` oder ein Handgriff in
   * SQL nähme. Der Dienst hätte jeden dieser Versuche schon abgewiesen; die
   * Frage ist, ob die Datenbank es auch tut.
   */
  it('Preis, Stichtag und Zustand einer geltenden Fassung lassen sich nicht direkt ändern', ohneDb, async () => {
    const { v1 } = await vertragMitSerie();
    await assert.rejects(db!.contractVersion.update({ where: { id: v1 }, data: { baseAmount: 9999 } }), /gesperrt/);
    await assert.rejects(db!.contractVersion.updateMany({ where: { id: v1 }, data: { paymentTermDays: 1 } }), /gesperrt/);
    await assert.rejects(db!.contractVersion.update({ where: { id: v1 }, data: { effectiveFrom: new Date(Date.now() + 90 * TAG) } }), /gesperrt/);
    await assert.rejects(db!.contractVersion.update({ where: { id: v1 }, data: { status: 'DRAFT' } }), /nicht zulässig/);
    // Rohes SQL — der direkteste Weg an Dienst und Prisma vorbei.
    await assert.rejects(
      db!.$executeRawUnsafe(`UPDATE "contract_versions" SET "terms" = 'still geändert' WHERE "id" = $1`, v1),
      /gesperrt/,
    );
    const unveraendert = await db!.contractVersion.findUniqueOrThrow({ where: { id: v1 } });
    assert.equal(Number(unveraendert.baseAmount), 1200);
  });

  it('Leistungen und Einsatzplan einer geltenden Fassung ebenso — ausser der Fortschrittsmarke', ohneDb, async () => {
    const { v1, planId } = await vertragMitSerie();
    await assert.rejects(
      db!.contractService.create({ data: { contractVersionId: v1, label: 'Heimlich dazu', estimatedMinutes: 30 } }),
      /gesperrt/,
    );
    await assert.rejects(
      db!.contractVersion.update({ where: { id: v1 }, data: { services: { updateMany: { where: {}, data: { estimatedMinutes: 5 } } } } }),
      /gesperrt/,
    );
    await assert.rejects(db!.serviceSchedule.update({ where: { id: planId }, data: { weekdays: [1, 2, 3, 4, 5] } }), /gesperrt/);
    await assert.rejects(db!.serviceSchedule.delete({ where: { id: planId } }), /gesperrt/);
    // Die eine erlaubte Spalte: die Auskunft des Planers.
    await db!.serviceSchedule.update({ where: { id: planId }, data: { generatedUntil: alsDatum(tagIn(5)) } });
  });
});

// ---------------------------------------------------------------------------
//  RB-003, RB-007 — Planer
// ---------------------------------------------------------------------------

describe('RB-003 — kein Termin doppelt über einen Fassungswechsel', () => {
  it('Wechsel mit gleicher Serie, drei Planer gleichzeitig, Wiederholung: je Termin genau ein Einsatz', ohneDb, async () => {
    const { id, v1 } = await vertragMitSerie();
    assert.equal((await post(`/api/contracts/${id}/schedule`, { bis: tagIn(35) }, { jar: jars.admin })).status, 200);
    const vorWechsel = await db!.job.count({ where: { contractId: id, status: { not: 'CANCELLED' } } });
    assert.ok(vorWechsel > 0);

    // Der Nachtlauf schiebt die Marke der alten Serie weiter — genau die
    // Lage, in der bis 2026-09-23 der Entwurf eine veraltete Marke übernahm.
    const v2 = await folgefassung(id, { effectiveFrom: tagIn(8), baseAmount: 1300 });
    assert.equal((await post(`/api/contracts/${id}/versions/${v2.id}/activate`, {}, { jar: jars.admin })).status, 200);

    await Promise.all([1, 2, 3].map(() => post(`/api/contracts/${id}/schedule`, { bis: tagIn(35) }, { jar: jars.admin })));
    // Wiederholung nach einem „Abbruch": Marke zurücksetzen, erneut planen.
    await db!.serviceSchedule.updateMany({ where: { contractService: { contractVersionId: v2.id } }, data: { generatedUntil: null } });
    await post(`/api/contracts/${id}/schedule`, { bis: tagIn(35) }, { jar: jars.admin });

    assert.equal(await doppelteTermine(id), 0, 'Kein Serientermin hat zwei geltende Einsätze');
    // Im selben Fenster wie vorher gezählt: Der Abgleich nach dem Wechsel
    // plant zusätzlich bis zum Horizont von 60 Tagen — das ist gewollt.
    const nachWechsel = await db!.job.count({
      where: { contractId: id, status: { not: 'CANCELLED' }, scheduleDate: { lte: alsDatum(tagIn(35)) } },
    });
    assert.equal(nachWechsel, vorWechsel, 'Gleiche Serie, gleiche Termine — nur die Fassung wechselt');

    const grenze = alsDatum(tagIn(8));
    const falsch = await db!.job.count({
      where: {
        contractId: id,
        status: { not: 'CANCELLED' },
        OR: [
          { scheduleDate: { lt: grenze }, contractVersionId: { not: v1 } },
          { scheduleDate: { gte: grenze }, contractVersionId: { not: v2.id } },
        ],
      },
    });
    assert.equal(falsch, 0, 'Vor dem Stichtag V1, ab dem Stichtag V2');
  });

  it('eine Folgefassung mit anderem Wochentag sagt die alten Termine ab und plant die neuen', ohneDb, async () => {
    const { id } = await vertragMitSerie();
    await post(`/api/contracts/${id}/schedule`, { bis: tagIn(35) }, { jar: jars.admin });
    const v2 = await folgefassung(id, { effectiveFrom: tagIn(8) });
    const plan = (await akte(id)).versions.find((v) => v.id === v2.id)!.services[0]!.schedules[0]!.id;
    assert.equal(
      (await patch(`/api/contract-schedules/${plan}`, { frequency: 'WEEKLY', weekdays: [5], effectiveFrom: tagIn(1), startMinute: 420, endMinute: 540 }, { jar: jars.admin })).status,
      200,
    );
    assert.equal((await post(`/api/contracts/${id}/versions/${v2.id}/activate`, {}, { jar: jars.admin })).status, 200);

    const ab = await db!.job.findMany({ where: { contractId: id, scheduleDate: { gte: alsDatum(tagIn(8)) }, status: { not: 'CANCELLED' } } });
    assert.ok(ab.length > 0);
    assert.ok(ab.every((j) => j.scheduleDate!.getUTCDay() === 5), 'Ab dem Stichtag nur noch freitags');
    assert.equal(await doppelteTermine(id), 0);
  });
});

describe('RB-007 — Pause, Fortsetzen, Ausnahmen wirken auf geplante Einsätze', () => {
  it('eine Pause sagt die geplanten Einsätze im Zeitraum ab, davor und danach bleibt alles', ohneDb, async () => {
    const { id } = await vertragMitSerie();
    await post(`/api/contracts/${id}/schedule`, { bis: tagIn(35) }, { jar: jars.admin });
    const pause = await post(`/api/contracts/${id}/pause`, { pausedFrom: tagIn(8), pausedUntil: tagIn(15), reason: 'Betriebsferien' }, { jar: jars.admin });
    assert.equal(pause.status, 200, JSON.stringify(pause.payload));

    const imFenster = await db!.job.findMany({
      where: { contractId: id, scheduleDate: { gte: alsDatum(tagIn(8)), lte: alsDatum(tagIn(15)) } },
    });
    assert.ok(imFenster.length > 0);
    assert.ok(imFenster.every((j) => j.status === 'CANCELLED'), 'In der Pause wird nicht gereinigt');
    const danach = await db!.job.count({
      where: { contractId: id, scheduleDate: { gt: alsDatum(tagIn(15)) }, status: { not: 'CANCELLED' } },
    });
    assert.ok(danach > 0, 'Nach der Pause wird weiter gereinigt');
  });

  it('Fortsetzen plant ab heute — nie in die Vergangenheit', ohneDb, async () => {
    const { id } = await vertragMitSerie({ contract: { startDate: tagIn(-21) }, version: { effectiveFrom: tagIn(-21) } });
    assert.equal((await post(`/api/contracts/${id}/schedule`, { bis: tagIn(20) }, { jar: jars.admin })).status, 200);
    const vergangen = await db!.job.count({ where: { contractId: id, scheduledStart: { lt: alsDatum(tagIn(0)) } } });
    assert.equal(vergangen, 0, 'Eine rückdatierte Inkraftsetzung erzeugt keine Einsätze in der Vergangenheit');

    await post(`/api/contracts/${id}/pause`, { pausedFrom: tagIn(0), reason: 'Unbefristet ausgesetzt' }, { jar: jars.admin });
    const weiter = await post(`/api/contracts/${id}/resume`, {}, { jar: jars.admin });
    assert.equal(weiter.status, 200, JSON.stringify(weiter.payload));
    await post(`/api/contracts/${id}/schedule`, { bis: tagIn(20) }, { jar: jars.admin });

    const inVergangenheit = await db!.job.count({
      where: { contractId: id, scheduledStart: { lt: alsDatum(tagIn(0)) }, status: { not: 'CANCELLED' } },
    });
    assert.equal(inVergangenheit, 0, 'Kein Einsatz vor heute');
    assert.ok((await db!.job.count({ where: { contractId: id, status: { not: 'CANCELLED' } } })) > 0, 'Ab heute wird geplant');
  });

  it('MOVE verlegt den geplanten Einsatz, EXTRA auf einem Serientag wird abgewiesen', ohneDb, async () => {
    const { id, planId } = await vertragMitSerie();
    await post(`/api/contracts/${id}/schedule`, { bis: tagIn(35) }, { jar: jars.admin });
    const erster = await db!.job.findFirst({ where: { contractId: id, status: { not: 'CANCELLED' } }, orderBy: { scheduleDate: 'asc' } });
    assert.ok(erster?.scheduleDate);
    const serientag = erster.scheduleDate.toISOString().slice(0, 10);
    const ersatz = new Date(erster.scheduleDate.getTime() + TAG).toISOString().slice(0, 10);

    const verlegt = await post(`/api/contract-schedules/${planId}/exceptions`, { kind: 'MOVE', originalDate: serientag, newDate: ersatz, reason: 'Wunsch der Kundschaft' }, { jar: jars.admin });
    assert.equal(verlegt.status, 201, JSON.stringify(verlegt.payload));
    const nachher = await db!.job.findUniqueOrThrow({ where: { id: erster.id } });
    assert.notEqual(nachher.status, 'CANCELLED', 'Derselbe Einsatz, nicht abgesagt');
    assert.equal(nachher.scheduleDate!.toISOString().slice(0, 10), serientag, 'Der Serientag bleibt die Kennung');
    assert.equal(nachher.scheduledStart.toISOString().slice(0, 10), ersatz, 'Er liegt am Ersatztag (06:00 Zürich)');
    assert.equal(await doppelteTermine(id), 0);

    const zusatz = await post(`/api/contract-schedules/${planId}/exceptions`, { kind: 'EXTRA', originalDate: serientag }, { jar: jars.admin });
    assert.equal(zusatz.status, 422, 'Ein Zusatztermin auf einem Serientag ginge still verloren');
  });
});

// ---------------------------------------------------------------------------
//  RB-008 — Abrechnung mit der Fassung, die damals galt
// ---------------------------------------------------------------------------

describe('RB-008 — periodengerechte Abrechnung', () => {
  const rechnungen: string[] = [];
  after(async () => {
    for (const r of rechnungen) await del(`/api/invoices/${r}`, { jar: jars.admin }).catch(() => undefined);
  });

  it('eine vergangene Periode mit V1, eine spätere mit V2 — V2 ändert V1 nicht', ohneDb, async () => {
    const id = await entwurf({ contract: { startDate: tagIn(-120) }, version: { effectiveFrom: tagIn(-120) } });
    assert.equal((await post(`/api/contracts/${id}/activate`, {}, { jar: jars.admin })).status, 200);
    const v2 = await folgefassung(id, { effectiveFrom: tagIn(1), baseAmount: 2400 });
    assert.equal((await post(`/api/contracts/${id}/versions/${v2.id}/activate`, {}, { jar: jars.admin })).status, 200);

    const alt = await post<{ data: { invoiceId: string; netto: number; versionNumber: number } }>(
      `/api/contracts/${id}/invoices`,
      { stichtag: tagIn(-60) },
      { jar: jars.admin },
    );
    assert.equal(alt.status, 201, JSON.stringify(alt.payload));
    rechnungen.push(data(alt).invoiceId);
    assert.equal(data(alt).versionNumber, 1, 'Vor dem Wechsel galt Fassung 1');
    assert.equal(data(alt).netto, 1200, 'mit ihrem Preis — nicht dem heutigen');

    const neu = await post<{ data: { invoiceId: string; netto: number; versionNumber: number } }>(
      `/api/contracts/${id}/invoices`,
      { stichtag: tagIn(45) },
      { jar: jars.admin },
    );
    assert.equal(neu.status, 201, JSON.stringify(neu.payload));
    rechnungen.push(data(neu).invoiceId);
    assert.equal(data(neu).versionNumber, 2);
  });

  it('Zykluswechsel monatlich → quartalsweise: keine Überlappung, auch nicht an der Datenbank vorbei', ohneDb, async () => {
    const id = await entwurf({ contract: { startDate: tagIn(-120) }, version: { effectiveFrom: tagIn(-120) } });
    assert.equal((await post(`/api/contracts/${id}/activate`, {}, { jar: jars.admin })).status, 200);
    const v2 = await folgefassung(id, { effectiveFrom: tagIn(1), billingCycle: 'QUARTERLY', baseAmount: 3300 });
    assert.equal((await post(`/api/contracts/${id}/versions/${v2.id}/activate`, {}, { jar: jars.admin })).status, 200);

    const monat = await post<{ data: { invoiceId: string; periodStart: string; periodEnd: string; versionNumber: number } }>(
      `/api/contracts/${id}/invoices`,
      { stichtag: tagIn(0) },
      { jar: jars.admin },
    );
    assert.equal(monat.status, 201, JSON.stringify(monat.payload));
    rechnungen.push(data(monat).invoiceId);
    assert.equal(data(monat).versionNumber, 1);
    assert.equal(data(monat).periodEnd.slice(0, 10), tagIn(0), 'Der Monat unter V1 endet vor dem Stichtag von V2');

    const quartal = await post<{ data: { invoiceId: string; periodStart: string; versionNumber: number } }>(
      `/api/contracts/${id}/invoices`,
      { stichtag: tagIn(1) },
      { jar: jars.admin },
    );
    assert.equal(quartal.status, 201, JSON.stringify(quartal.payload));
    rechnungen.push(data(quartal).invoiceId);
    assert.equal(data(quartal).versionNumber, 2);
    assert.equal(data(quartal).periodStart.slice(0, 10), tagIn(1), 'Das Quartal unter V2 beginnt am Stichtag');

    // An der Anwendung vorbei: eine Rechnung, die in den Monat hineinreicht.
    const vorlage = await db!.invoice.findUniqueOrThrow({ where: { id: data(monat).invoiceId } });
    await assert.rejects(
      db!.invoice.create({
        data: {
          organizationId: vorlage.organizationId,
          customerId: vorlage.customerId,
          number: `TEST-UEBERLAPPUNG-${Date.now()}`,
          contractId: id,
          contractVersionId: vorlage.contractVersionId,
          contractPeriodStart: new Date(vorlage.contractPeriodStart!.getTime() + 2 * TAG),
          contractPeriodEnd: new Date(vorlage.contractPeriodEnd!.getTime() + 10 * TAG),
          issueDate: vorlage.issueDate,
          dueDate: vorlage.dueDate,
          billToName: vorlage.billToName,
          billToStreet: vorlage.billToStreet,
          billToZip: vorlage.billToZip,
          billToCity: vorlage.billToCity,
        },
      }),
      /ueberlappungsfrei|23P01|exclusion/i,
      'Die Ausschlussbedingung verhindert jede zeitliche Überlappung',
    );
  });

  it('ein an der Fassungsgrenze gekürzter Zeitraum wird anteilig verrechnet', ohneDb, async () => {
    const id = await entwurf({ contract: { startDate: tagIn(-120) }, version: { effectiveFrom: tagIn(-120) } });
    assert.equal((await post(`/api/contracts/${id}/activate`, {}, { jar: jars.admin })).status, 200);
    const v2 = await folgefassung(id, { effectiveFrom: tagIn(1), baseAmount: 1500 });
    assert.equal((await post(`/api/contracts/${id}/versions/${v2.id}/activate`, {}, { jar: jars.admin })).status, 200);

    const antwort = await post<{ data: { invoiceId: string; netto: number; periodStart: string; periodEnd: string } }>(
      `/api/contracts/${id}/invoices`,
      { stichtag: tagIn(0) },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 201, JSON.stringify(antwort.payload));
    rechnungen.push(data(antwort).invoiceId);
    const start = new Date(data(antwort).periodStart);
    const tageImMonat = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
    const tage = Math.round((new Date(data(antwort).periodEnd).getTime() - start.getTime()) / TAG) + 1;
    const erwartet = Math.round(1200 * (tage / tageImMonat) * 100) / 100;
    assert.equal(data(antwort).netto, erwartet, `${tage} von ${tageImMonat} Tagen zu 1200`);
  });
});

// ---------------------------------------------------------------------------
//  RB-011 — Qualitätsbegehung verbindet nur, was zusammengehört
// ---------------------------------------------------------------------------

describe('RB-011 — Zugehörigkeit der Begehung', () => {
  it('Vertrag der einen und Objekt einer anderen Kundschaft: 422', ohneDb, async (t) => {
    if (!fremdesObjektId) return t.skip('kein Objekt einer zweiten Kundschaft im Bestand');
    const { id } = await vertragMitSerie();
    const antwort = await post(
      '/api/quality-inspections',
      {
        contractId: id,
        propertyId: fremdesObjektId,
        inspectedAt: tagIn(0),
        items: [{ label: 'Böden', points: 4, maxPoints: 5, weight: 1 }],
      },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 422, JSON.stringify(antwort.payload));
  });

  it('eine Kundschaft ist keine prüfende Person: 422', ohneDb, async () => {
    const kundenkonto = await db!.user.findFirstOrThrow({ where: { role: 'CUSTOMER', deletedAt: null } });
    const antwort = await post(
      '/api/quality-inspections',
      {
        propertyId: objektId,
        inspectorId: kundenkonto.id,
        inspectedAt: tagIn(0),
        items: [{ label: 'Böden', points: 4, maxPoints: 5, weight: 1 }],
      },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 422, JSON.stringify(antwort.payload));
  });
});
