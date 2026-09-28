import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { data, del, get, patch, post, put, requireServer } from '../helpers/client';
import { ACCOUNTS, loginAll, type AccountName } from '../helpers/accounts';
import { eigeneOrganisationId, testDb } from '../helpers/testdb';

/**
 * Einsätze: bearbeiten, Team mit mehreren Personen, Material und die
 * Herleitung der Nachkalkulation.
 *
 * Es gibt kein Anlegeformular für Einsätze — sie entstehen aus Buchungen.
 * Die Prüfung nimmt deshalb einen geplanten Demo-Einsatz, verschiebt ihn weit
 * in die Zukunft (damit keine Doppelverplanung mit anderen Demo-Einsätzen
 * dazwischenfunkt), macht ihre Änderungen und stellt am Ende Termin, Team,
 * Material und Nachkalkulation wieder her.
 */

type Jars = Record<AccountName, string>;

interface CalendarEvent {
  id: string;
  start: string;
  end: string;
  extendedProps: { status: string };
}

interface JobDetail {
  id: string;
  title: string;
  status: string;
  scheduledStart: string;
  scheduledEnd: string;
  estimatedMin: number;
  travelMin: number;
  internalNote: string | null;
  revenue: string | number;
  laborCost: string | number;
  materialCost: string | number;
  assignments: { employeeId: string; role: string }[];
  materials: { name: string; quantity: string | number; unitCost: string | number; total: string | number }[];
  timeEntries: { minutes: number }[];
}

interface Employee {
  id: string;
  active: boolean;
  user: { email: string; firstName: string };
}

const window = (vonTagen = -30, bisTagen = 30) => {
  const from = new Date(Date.now() + vonTagen * 864e5).toISOString();
  const to = new Date(Date.now() + bisTagen * 864e5).toISOString();
  return `from=${from}&to=${to}`;
};

/** Ein Termin weit in der Zukunft, an dem garantiert kein anderer Demo-Einsatz liegt. */
function farFuture(hourOffset = 0): { start: string; end: string } {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 500);
  start.setUTCHours(7 + hourOffset, 0, 0, 0);
  const end = new Date(start.getTime() + 3 * 60 * 60_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

describe('Einsätze — bearbeiten, Team, Material, Nachkalkulation', () => {
  let jars: Jars;
  let jobId: string;
  let original: JobDetail;

  const detail = async (): Promise<JobDetail> =>
    data(await get<{ data: JobDetail }>(`/api/jobs/${jobId}`, { jar: jars.admin }));

  before(async () => {
    await requireServer();
    jars = await loginAll();

    // Zwei Fenster statt eines: Der Kalender lädt seit 2026-09-27 höchstens
    // 62 Tage auf einmal (so viel wie die Monatsansicht braucht).
    const events = [
      ...data(await get<{ data: CalendarEvent[] }>(`/api/jobs/calendar?${window(-60, 0)}`, { jar: jars.admin })),
      ...data(await get<{ data: CalendarEvent[] }>(`/api/jobs/calendar?${window(0, 60)}`, { jar: jars.admin })),
    ];
    /*
      Ein Einsatz **ohne verlangte Qualifikation** (2026-09-27): Der Fall
      teilt zwei Demo-Personen zu, und seit die Zuteilung Qualifikationen
      prüft, scheitert das an einem Einsatz, der eine verlangt, die beide
      nicht haben. Welcher Einsatz zuerst im Kalender steht, hängt vom
      Datenbestand ab — Vertragseinsätze anderer Prüfreihen bleiben nach dem
      Vertragsende stehen. Die Wahl darf davon nicht abhängen.
    */
    const geplant = events.filter((event) => ['SCHEDULED', 'DISPATCHED', 'UNASSIGNED'].includes(event.extendedProps.status));
    let candidate: CalendarEvent | undefined;
    for (const event of geplant) {
      const kandidat = data(await get<{ data: { requiredSkills?: string[] } }>(`/api/jobs/${event.id}`, { jar: jars.admin }));
      if ((kandidat.requiredSkills ?? []).length === 0) {
        candidate = event;
        break;
      }
    }
    assert.ok(candidate, 'kein geplanter Demo-Einsatz ohne verlangte Qualifikation im Kalender — Datenbank mit db:seed:demo befüllt?');
    jobId = candidate.id;
    original = await detail();
  });

  after(async () => {
    if (!jobId || !original) return;
    // Alles zurück: Material leeren, Team wie vorher, Termin und Notiz wie
    // vorher, Nachkalkulation wie vorher.
    await put(`/api/jobs/${jobId}/costing`, { materials: [] }, { jar: jars.admin });
    await patch(
      `/api/jobs/${jobId}`,
      {
        title: original.title,
        scheduledStart: original.scheduledStart,
        scheduledEnd: original.scheduledEnd,
        estimatedMin: original.estimatedMin,
        travelMin: original.travelMin,
        internalNote: original.internalNote ?? '',
      },
      { jar: jars.admin },
    );
    await put(
      `/api/jobs/${jobId}/team`,
      {
        notify: false,
        members: original.assignments.map((a) => ({ employeeId: a.employeeId, role: a.role })),
      },
      { jar: jars.admin },
    );
    await patch(
      `/api/jobs/${jobId}/costing`,
      {
        revenue: Number(original.revenue),
        laborCost: Number(original.laborCost),
        materialCost: Number(original.materialCost),
      },
      { jar: jars.admin },
    );
  });

  it('bearbeiten darf, wer Einsätze führt — nicht das Team, nicht die Kundschaft', async () => {
    const employee = await patch(`/api/jobs/${jobId}`, { title: 'Verboten' }, { jar: jars.employee });
    assert.equal(employee.status, 403, 'Mitarbeitende ändern keine Einsätze');

    const customer = await patch(`/api/jobs/${jobId}`, { title: 'Verboten' }, { jar: jars.customer });
    assert.equal(customer.status, 403, 'Kundschaft ändert keine Einsätze');

    const anonymous = await patch(`/api/jobs/${jobId}`, { title: 'Verboten' });
    assert.equal(anonymous.status, 401);
  });

  it('Titel, Termin, Dauer und Notiz ändern — und eine Notiz wieder leeren', async () => {
    const slot = farFuture();
    const changed = await patch(
      `/api/jobs/${jobId}`,
      {
        title: 'Prüf-Einsatz bearbeitet',
        scheduledStart: slot.start,
        scheduledEnd: slot.end,
        estimatedMin: 120,
        travelMin: 30,
        internalNote: 'Prüfnotiz',
      },
      { jar: jars.manager },
    );
    assert.equal(changed.status, 200, changed.text);

    let job = await detail();
    assert.equal(job.title, 'Prüf-Einsatz bearbeitet');
    assert.equal(job.estimatedMin, 120);
    assert.equal(job.travelMin, 30);
    assert.equal(job.internalNote, 'Prüfnotiz');
    assert.equal(new Date(job.scheduledStart).toISOString(), slot.start);

    // Leere Zeichenkette leert das Feld — das Formular schickt sie beim Löschen.
    const cleared = await patch(`/api/jobs/${jobId}`, { internalNote: '' }, { jar: jars.manager });
    assert.equal(cleared.status, 200, cleared.text);
    job = await detail();
    assert.equal(job.internalNote, null, 'geleerte Notiz ist null, nicht ""');
  });

  it('Ende vor Beginn wird abgelehnt', async () => {
    const slot = farFuture();
    const rejected = await patch(
      `/api/jobs/${jobId}`,
      { scheduledStart: slot.end, scheduledEnd: slot.start },
      { jar: jars.admin },
    );
    assert.equal(rejected.status, 422, rejected.text);
  });

  it('Team mit mehreren Personen und Rollen setzen', async () => {
    const employees = data(
      await get<{ data: Employee[] }>('/api/employees', { jar: jars.admin }),
    ).filter((e) => e.active);
    assert.ok(employees.length >= 2, 'mindestens zwei aktive Mitarbeitende im Demo-Datensatz');

    const [lead, member] = employees;
    const saved = await put(
      `/api/jobs/${jobId}/team`,
      {
        notify: false,
        members: [
          { employeeId: lead.id, role: 'LEAD' },
          { employeeId: member.id, role: 'MEMBER' },
        ],
      },
      { jar: jars.manager },
    );
    assert.equal(saved.status, 200, saved.text);

    const job = await detail();
    assert.equal(job.assignments.length, 2, 'zwei Personen eingeteilt');
    assert.equal(job.assignments.find((a) => a.employeeId === lead.id)?.role, 'LEAD');
    assert.equal(job.assignments.find((a) => a.employeeId === member.id)?.role, 'MEMBER');
    assert.notEqual(job.status, 'UNASSIGNED');

    const duplicate = await put(
      `/api/jobs/${jobId}/team`,
      {
        members: [
          { employeeId: lead.id, role: 'LEAD' },
          { employeeId: lead.id, role: 'MEMBER' },
        ],
      },
      { jar: jars.manager },
    );
    assert.equal(duplicate.status, 422, 'dieselbe Person zweimal wird abgelehnt');
  });

  it('Material erfassen — Menge mal Stückpreis wird zum Materialaufwand', async () => {
    const saved = await put<{ data: { materialCost: number } }>(
      `/api/jobs/${jobId}/costing`,
      {
        materials: [
          { name: 'Allzweckreiniger 5 l', quantity: 2, unit: 'Stk.', unitCost: 12.5, billable: false },
          { name: 'Mikrofasertücher', quantity: 10, unit: 'Stk.', unitCost: 1.2, billable: true },
        ],
      },
      { jar: jars.manager },
    );
    assert.equal(saved.status, 200, saved.text);
    assert.equal(data(saved).materialCost, 37);

    const job = await detail();
    assert.equal(job.materials.length, 2);
    assert.equal(Number(job.materialCost), 37, 'Materialaufwand steht in der Nachkalkulation');
    assert.equal(
      Number(job.materials.find((m) => m.name === 'Mikrofasertücher')?.total),
      12,
      'Betrag je Position ist Menge mal Stückpreis',
    );

    const employee = await put(
      `/api/jobs/${jobId}/costing`,
      { materials: [] },
      { jar: jars.employee },
    );
    assert.equal(employee.status, 403, 'Mitarbeitende setzen kein Material über die Verwaltung');
  });

  it('Neu berechnen leitet die Lohnkosten aus Team und Plan her', async () => {
    const job = await detail();
    assert.equal(job.assignments.length, 2, 'Voraussetzung: zwei Personen im Team');
    assert.equal(job.timeEntries.length, 0, 'Voraussetzung: keine erfasste Zeit am geplanten Einsatz');

    const result = await patch<{
      data: { revenue: number; laborCost: number; materialCost: number; margin: number };
    }>(`/api/jobs/${jobId}/costing`, { recalculate: true }, { jar: jars.admin });
    assert.equal(result.status, 200, result.text);
    const costing = data(result);

    // Zwei Personen à (120 + 30) Minuten mit Stundenlohn: Der Betrag ist
    // grösser als null und entspricht 2.5 Stunden je Person — jede Person
    // trägt mindestens einen Stundenansatz von 20 CHF bei (Demo-Löhne liegen
    // zwischen 29 und 48 CHF), also liegt der Wert in einem plausiblen Band.
    assert.ok(costing.laborCost > 0, 'Lohnkosten ohne Zeiterfassung sind nicht null');
    assert.ok(
      costing.laborCost >= 2 * 2.5 * 20 && costing.laborCost <= 2 * 2.5 * 100,
      `Lohnkosten im Band einer Planung mit zwei Personen: ${costing.laborCost}`,
    );
    assert.equal(costing.materialCost, 37, 'Material aus dem erfassten Verbrauch');
    assert.equal(costing.margin, Math.round((costing.revenue - costing.laborCost - 37) * 100) / 100);

    const persisted = await detail();
    assert.equal(Number(persisted.laborCost), costing.laborCost);

    // Neu berechnen und Werte von Hand schliessen sich aus.
    const mixed = await patch(
      `/api/jobs/${jobId}/costing`,
      { recalculate: true, laborCost: 1 },
      { jar: jars.admin },
    );
    assert.equal(mixed.status, 422);
  });
});

/**
 * Einsatzfotos binden nur über die eine Bindungsregel (F-09b, 2026-09-27).
 *
 * `POST /api/jobs/:id/photos` band Dateien bis dahin im Routenhandler selbst:
 * Datei lesen, dann bedingungslos an den Einsatz schreiben. Geprüft wurden
 * Organisation, Zweck und Prüfsumme — nicht, **wer** die Datei hochgeladen hat,
 * und nicht, ob die Schadsoftwareprüfung sie als schädlich erkannt hat. Eine
 * Kennung war damit eine Berechtigung: Wer die Kennung eines fremden
 * Einsatzbildes kannte, hängte es an einen Einsatz, den er sieht.
 *
 * Die Dateien entstehen direkt in der Testdatenbank — so wie
 * `buchung-integritaet.test.ts` es für Buchungsdateien tut: Ein echter Upload
 * von zwei verschiedenen Konten samt Prüfbefund liesse sich über HTTP nur mit
 * einem Schadsoftwareprüfer herstellen, den die Prüfreihe nicht hat. Geprüft
 * wird jeweils die Abweisung **und** dass nichts geschah: Datei ungebunden,
 * kein Foto.
 */
describe('Einsatzfotos — nur über die eine Bindungsregel', () => {
  const db = testDb();
  const RUN = Date.now();
  const MARKE = 'FOTO-PRUEF-';
  let jars: Jars;
  let org = '';
  let adminUserId = '';
  let managerUserId = '';
  const einsaetze: string[] = [];
  const dateien = { eigen: '', fremd: '', infiziert: '' };

  async function datei(name: string, uploadedById: string, scanStatus: 'CLEAN' | 'INFECTED' = 'CLEAN') {
    const pfad = `pruef/${MARKE}${RUN}-${name}.jpg`;
    const angelegt = await db!.fileAsset.create({
      data: {
        organizationId: org,
        scope: 'JOB',
        scanStatus,
        checksum: 'b'.repeat(64),
        isPublic: false,
        path: pfad,
        url: pfad,
        filename: `${MARKE}${RUN}-${name}.jpg`,
        mimeType: 'image/jpeg',
        sizeBytes: 10,
        uploadedById,
      },
    });
    return angelegt.id;
  }

  async function aufraeumen() {
    if (!db) return;
    // Alle Läufe, nicht nur dieser: Ein abgebrochener Lauf hinterliesse sonst
    // Fotos und Dateien, die niemand mehr zuordnet.
    await db.jobPhoto.deleteMany({ where: { url: { startsWith: `pruef/${MARKE}` } } });
    await db.fileAsset.deleteMany({ where: { filename: { startsWith: MARKE } } });
  }

  before(async () => {
    if (!db) return;
    await requireServer();
    jars = await loginAll();
    await aufraeumen();

    org = (await eigeneOrganisationId()) ?? '';
    adminUserId = (await db.user.findFirstOrThrow({ where: { email: ACCOUNTS.admin.email }, select: { id: true } })).id;
    managerUserId = (await db.user.findFirstOrThrow({ where: { email: ACCOUNTS.manager.email }, select: { id: true } })).id;

    const objekte = data(await get<{ data: { customer: { id: string } }[] }>('/api/properties', { jar: jars.admin }));
    const customerId = objekte[0]!.customer.id;
    for (const nr of [1, 2]) {
      const start = new Date(Date.now() + (900 + nr) * 864e5);
      start.setUTCHours(7, 0, 0, 0);
      const angelegt = await post<{ data: { id: string } }>(
        '/api/jobs',
        {
          customerId,
          title: `Prüfeinsatz Fotos ${RUN} ${nr}`,
          scheduledStart: start.toISOString(),
          scheduledEnd: new Date(start.getTime() + 2 * 3_600_000).toISOString(),
        },
        { jar: jars.admin },
      );
      assert.equal(angelegt.status, 201, angelegt.text);
      einsaetze.push(data(angelegt).id);
    }

    dateien.eigen = await datei('eigen', adminUserId);
    dateien.fremd = await datei('fremd', managerUserId);
    dateien.infiziert = await datei('infiziert', adminUserId, 'INFECTED');
  });

  after(async () => {
    if (!db) return;
    await aufraeumen();
    for (const id of einsaetze) await del(`/api/jobs/${id}`, { jar: jars.admin });
  });

  const binden = (jobId: string, fileId: string) =>
    post(`/api/jobs/${jobId}/photos`, { fileId, type: 'BEFORE' }, { jar: jars.admin });

  async function nichtsGeschehen(fileId: string) {
    const nachher = await db!.fileAsset.findUniqueOrThrow({ where: { id: fileId }, select: { jobId: true, url: true } });
    assert.equal(nachher.jobId, null, 'die Datei wurde trotz Abweisung an einen Einsatz gebunden');
    assert.equal(await db!.jobPhoto.count({ where: { url: nachher.url } }), 0, 'Foto trotz Abweisung angelegt');
  }

  it('die eigene, geprüfte Datei wird Foto dieses Einsatzes', async (t) => {
    if (!db) return t.skip('keine Testdatenbank');
    const antwort = await binden(einsaetze[0]!, dateien.eigen);
    assert.equal(antwort.status, 201, antwort.text);

    const nachher = await db.fileAsset.findUniqueOrThrow({ where: { id: dateien.eigen }, select: { jobId: true, url: true } });
    assert.equal(nachher.jobId, einsaetze[0], 'die Datei hängt am Einsatz');
    assert.equal(await db.jobPhoto.count({ where: { jobId: einsaetze[0], url: nachher.url } }), 1);
  });

  it('die Datei einer anderen Person wird kein Einsatzfoto — 404, die Datei bleibt ungebunden', async (t) => {
    if (!db) return t.skip('keine Testdatenbank');
    const antwort = await binden(einsaetze[0]!, dateien.fremd);
    assert.equal(antwort.status, 404, antwort.text);
    await nichtsGeschehen(dateien.fremd);
  });

  it('eine als schädlich erkannte Datei wird kein Einsatzfoto — 404', async (t) => {
    if (!db) return t.skip('keine Testdatenbank');
    const antwort = await binden(einsaetze[0]!, dateien.infiziert);
    assert.equal(antwort.status, 404, antwort.text);
    await nichtsGeschehen(dateien.infiziert);
  });

  it('eine bereits gebundene Datei lässt sich nicht an einen zweiten Einsatz hängen — 404', async (t) => {
    if (!db) return t.skip('keine Testdatenbank');
    const antwort = await binden(einsaetze[1]!, dateien.eigen);
    assert.equal(antwort.status, 404, antwort.text);

    const nachher = await db.fileAsset.findUniqueOrThrow({ where: { id: dateien.eigen }, select: { jobId: true, url: true } });
    assert.equal(nachher.jobId, einsaetze[0], 'die Datei hängt weiter am ersten Einsatz');
    assert.equal(await db.jobPhoto.count({ where: { jobId: einsaetze[1], url: nachher.url } }), 0, 'kein Foto am zweiten Einsatz');
  });
});
