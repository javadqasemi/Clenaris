import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { data, del, get, patch, post, put, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { testDb } from '../helpers/testdb';

/**
 * Buchung → Einsatz → Zuteilung: der Weg, auf dem ein Auftrag zu Arbeit wird.
 *
 * Diese Datei hält die Lücken fest, die Phase 2 geschlossen hat:
 *
 *  • Eine Buchung liess sich nur über die **öffentliche** Route anlegen. Das
 *    Büro musste den Umweg über eine bestehende Adresse nehmen, jede
 *    telefonische Buchung zählte in den Auswertungen als „Website", und das
 *    Rate-Limit des Buchungstrichters galt auch für die Sachbearbeitung.
 *  • `GET`/`POST /api/jobs` gab es nicht. Ein Einsatz ohne vorangehende
 *    Buchung — Nachbesserung, Sonderauftrag — war nicht erfassbar, obwohl der
 *    Dienst dafür fertig war.
 *  • **Abwesenheiten wurden bei der Zuteilung nirgends geprüft.** Wer in den
 *    bewilligten Ferien war, liess sich widerspruchslos einteilen. Die
 *    Routenregistrierung versprach die Prüfung sogar ausdrücklich.
 *
 * Aufgeräumt wird vollständig: Alles, was hier entsteht, trägt `RUN` im Titel
 * und wandert am Ende in den Papierkorb. Ausgestellte Belege entstehen keine.
 */

type Jars = Record<AccountName, string>;

interface JobSummary {
  id: string;
  number: string;
  status: string;
  title: string;
}

interface Fehler {
  error: { code: string; message: string; details?: { conflicts?: { code: string }[] } };
}

const RUN = Date.now();
const TITEL = `Prüfeinsatz ${RUN}`;

function tag(offsetTage: number, stunde: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetTage);
  date.setHours(stunde, 0, 0, 0);
  return date.toISOString();
}

/**
 * Das Kalenderfenster dieses Laufs — erst im `before` bestimmt, nicht geraten.
 *
 * **Warum es nicht einfach ein Zufallswert sein kann.** Der Lauf bewilligt
 * eine Abwesenheit, und eine bewilligte Abwesenheit lässt sich über die
 * Schnittstelle nicht mehr entfernen: `withdrawAbsence` nimmt nur beantragte
 * Gesuche zurück, und das ist richtig so — eine Bewilligung, die sich
 * zurücknehmen liesse, wäre keine. In `clenaris_test` sammeln sich diese
 * Einträge also an, Lauf für Lauf.
 *
 * Der erste Versuch war ein über ein Jahr gestreuter Zufallswert. Das
 * verschiebt das Problem nur: Jeder Lauf belegt eine gute Woche, und
 * irgendwann trifft ein neues Fenster ein altes. Genau das ist passiert —
 * „Anna Keller ist vom 28.06.–30.06. abwesend (Ferien, bewilligt)", mitten in
 * einer Prüfung, die mit Abwesenheiten nichts zu tun hatte.
 *
 * Jetzt fragt der Lauf nach, statt zu hoffen: Er liest die vorhandenen
 * Abwesenheiten und legt sein Fenster dahinter. Das ist auch die ehrlichere
 * Prüfung — sie hängt nicht mehr davon ab, wie oft sie schon gelaufen ist.
 */
let TAG0 = 0;
let T_START = '';
let T_ENDE = '';
let T_UEBERLAPPEND_START = '';
let T_UEBERLAPPEND_ENDE = '';
let T_FREI_START = '';
let T_FREI_ENDE = '';

/** Setzt `TAG0` auf den ersten freien Dienstag hinter allem Bestehenden. */
function fensterFestlegen(belegtBisTage: number): void {
  /**
   * Der Anker ist ein **Dienstag**, und das ist keine Kosmetik.
   *
   * `requestAbsence` zählt die effektiven Arbeitstage und weist einen Antrag
   * ab, der keinen enthält („Der gewählte Zeitraum enthält keine
   * Arbeitstage."). Ein auf ein Wochenende gefallenes Fenster liesse die
   * Prüfung scheitern, ohne dass am Produkt etwas falsch wäre.
   *
   * Von einem Dienstag aus liegen alle hier verwendeten Abstände (+1, +3,
   * +30, +31) auf Werktagen — nachgerechnet, nicht gehofft.
   */
  const roh = Math.max(300, belegtBisTage + 14);
  const date = new Date();
  date.setDate(date.getDate() + roh);
  // 0 = Sonntag … 2 = Dienstag
  TAG0 = roh + ((2 - date.getDay() + 7) % 7);

  T_START = tag(TAG0, 8);
  T_ENDE = tag(TAG0, 11);
  // Überlappt T_START–T_ENDE um eine halbe Stunde.
  T_UEBERLAPPEND_START = tag(TAG0, 10);
  T_UEBERLAPPEND_ENDE = tag(TAG0, 13);
  // Anderer Tag, damit die Abwesenheitsprüfung isoliert bleibt.
  T_FREI_START = tag(TAG0 + 2, 8);
  T_FREI_ENDE = tag(TAG0 + 2, 11);
}

describe('Disposition — Buchung, Einsatz, Zuteilung', () => {
  let jars: Jars;
  let customerId = '';
  let addressId = '';
  let propertyId = '';
  let serviceId = '';
  let annaId = '';
  let zweiteKraftId = '';

  const angelegteJobs: string[] = [];
  const angelegteBuchungen: string[] = [];

  const jobAnlegen = async (body: Record<string, unknown>, jar = jars.admin) =>
    post<{ data: { id: string; number: string } }>('/api/jobs', body, { jar });

  before(async () => {
    await requireServer();
    jars = await loginAll();

    /**
     * Ausgangspunkt ist das **Objekt**, nicht die Kundschaft.
     *
     * Der Grund ist eine Falle, in die diese Datei einmal gelaufen ist: Die
     * Kundenliste kommt mit der neuesten zuerst, und die neueste ist nach
     * einem vorangegangenen Lauf von `flows.test.ts` eine Prüfkundschaft ohne
     * Objekt und ohne Adresse. „Die erste Kundschaft" ist also nicht stabil.
     * Ein Objekt mit Adresse dagegen stammt sicher aus dem Demo-Seed, und die
     * zugehörige Kundschaft steht gleich daneben.
     */
    const objekte = data(
      await get<{
        data: { id: string; address: { id: string } | null; customer: { id: string } }[];
      }>('/api/properties', { jar: jars.admin }),
    );
    const mitAdresse = objekte.find((objekt) => objekt.address !== null);
    assert.ok(mitAdresse, 'Der Demobestand enthält ein Objekt mit Adresse');
    propertyId = mitAdresse.id;
    addressId = mitAdresse.address!.id;
    customerId = mitAdresse.customer.id;

    const leistungen = data(
      await get<{ data: { id: string }[] }>('/api/services', { jar: jars.admin }),
    );
    serviceId = leistungen[0]!.id;

    const personal = data(
      await get<{ data: { id: string; user: { email: string } }[] }>('/api/employees', {
        jar: jars.admin,
      }),
    );
    annaId = personal.find((person) => person.user.email === 'anna.keller@clenaris.ch')!.id;
    zweiteKraftId = personal.find((person) => person.id !== annaId)!.id;
    assert.ok(annaId && zweiteKraftId, 'zwei Mitarbeitende im Demobestand');
    // Reste früherer Läufe (siehe `after` im Block „Abwesenheit"): nur die
    // eigenen Prüfgesuche, erkennbar am Grund.
    await testDb()?.absence.deleteMany({ where: { employeeId: annaId, reason: { startsWith: 'Prüflauf ' } } });

    /**
     * Das Fenster hinter alles legen, was Anna schon an Abwesenheiten hat —
     * bewilligte lassen sich nicht mehr entfernen und blieben sonst als
     * Minen früherer Läufe liegen.
     */
    const abwesenheiten = data(
      await get<{ data: { endDate: string; status: string }[] }>(
        `/api/absences?employeeId=${annaId}`,
        { jar: jars.admin },
      ),
    );
    const heute = Date.now();
    const spaetestesEnde = abwesenheiten
      .filter((a) => a.status === 'APPROVED' || a.status === 'REQUESTED')
      .reduce((max, a) => Math.max(max, new Date(a.endDate).getTime()), heute);
    fensterFestlegen(Math.ceil((spaetestesEnde - heute) / 86_400_000));
  });

  after(async () => {
    for (const jobId of angelegteJobs) {
      await del(`/api/jobs/${jobId}`, { jar: jars.admin });
    }
    for (const bookingId of angelegteBuchungen) {
      await del(`/api/bookings/${bookingId}`, { jar: jars.admin });
    }
  });

  // =========================================================================
  //  Buchung im Büro
  // =========================================================================

  it('POST /api/bookings: nur mit booking:create — Team und Kundschaft abgewiesen', async () => {
    for (const rolle of ['employee', 'customer'] as const) {
      const abgewiesen = await post(
        '/api/bookings',
        { customerId, serviceId, scheduledStart: T_FREI_START, addressId },
        { jar: jars[rolle] },
      );
      assert.equal(abgewiesen.status, 403, `${rolle} erfasst keine Buchung`);
    }
  });

  it('POST /api/bookings: erfasst im Büro, mit eigener Herkunft und serverseitigem Preis', async () => {
    const antwort = await post<{
      data: { id: string; number: string; status: string; grossTotal: string | number };
    }>(
      '/api/bookings',
      {
        customerId,
        serviceId,
        addressId,
        scheduledStart: T_FREI_START,
        squareMeters: 80,
        source: 'PHONE',
        internalNote: `Telefonisch, Prüflauf ${RUN}`,
        // Ein mitgeschickter Preis darf nichts bewirken: Der Server rechnet
        // selbst, und Zod wirft unbekannte Felder weg. Käme dieser Betrag je
        // in der Antwort an, wäre der Preis vom Klienten bestimmbar.
        grossTotal: 1,
        netTotal: 1,
      },
      { jar: jars.admin },
    );

    assert.equal(antwort.status, 201, antwort.text);
    const buchung = data(antwort);
    angelegteBuchungen.push(buchung.id);

    assert.ok(buchung.number.length > 0, 'Belegnummer vergeben');
    assert.equal(buchung.status, 'PENDING');
    assert.ok(
      Number(buchung.grossTotal) > 1,
      `Preis kommt vom Server, nicht aus der Anfrage (${buchung.grossTotal})`,
    );
  });

  it('POST /api/bookings: fremde oder erfundene Kundschaft ergibt 404', async () => {
    const antwort = await post(
      '/api/bookings',
      { customerId: 'clxxxxxxxxxxxxxxxxxxxxxxx', serviceId, addressId, scheduledStart: T_FREI_START },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 404, antwort.text);
  });

  it('POST /api/bookings: ohne Adresse 422', async () => {
    const antwort = await post(
      '/api/bookings',
      { customerId, serviceId, scheduledStart: T_FREI_START },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 422, antwort.text);
  });

  // =========================================================================
  //  Einsätze
  // =========================================================================

  it('GET /api/jobs: Verwaltung sieht alle, Kundschaft gar nichts', async () => {
    const alle = await get<{
      data: JobSummary[];
      meta: { page: number; pageSize: number; total: number; totalPages: number };
    }>('/api/jobs?pageSize=5', { jar: jars.admin });
    assert.equal(alle.status, 200, alle.text);
    assert.ok(Array.isArray(data(alle)), 'Liste');
    assert.equal(alle.payload.meta?.pageSize, 5, 'mit Blätterangaben');
    assert.ok(typeof alle.payload.meta?.total === 'number', 'mit Gesamtzahl');
    assert.ok(data(alle).length <= 5, 'Seitengrösse wird eingehalten');

    const kundschaft = await get('/api/jobs', { jar: jars.customer });
    assert.equal(kundschaft.status, 403, 'Kundschaft hat keine Betriebssicht');
  });

  it('GET /api/jobs: Mitarbeitende sehen nur die eigenen — auch mit fremdem Filter', async () => {
    const eigene = await get<{ data: { assignments: { employeeId: string }[] }[] }>(
      `/api/jobs?employeeId=${zweiteKraftId}&pageSize=50`,
      { jar: jars.employee },
    );
    assert.equal(eigene.status, 200, eigene.text);

    // Der mitgeschickte fremde Filter wird vom eigenen überschrieben. Jeder
    // gelieferte Einsatz muss eine Zuteilung auf Anna tragen.
    for (const job of data(eigene)) {
      assert.ok(
        job.assignments.some((zuteilung) => zuteilung.employeeId === annaId),
        'nur eigene Einsätze',
      );
    }
  });

  it('POST /api/jobs: legt einen Einsatz ohne Buchung an', async () => {
    const antwort = await jobAnlegen({
      customerId,
      addressId,
      propertyId,
      serviceId,
      title: TITEL,
      scheduledStart: T_START,
      scheduledEnd: T_ENDE,
      estimatedMin: 180,
    });

    assert.equal(antwort.status, 201, antwort.text);
    const job = data(antwort);
    angelegteJobs.push(job.id);
    assert.ok(job.number.length > 0, 'Einsatznummer vergeben');

    const gelesen = await get<{ data: JobSummary }>(`/api/jobs/${job.id}`, { jar: jars.admin });
    assert.equal(gelesen.status, 200);
    assert.equal(data(gelesen).status, 'UNASSIGNED', 'ohne Team unbesetzt');
  });

  it('POST /api/jobs: Adresse einer fremden Kundschaft wird abgewiesen', async () => {
    const objekte = data(
      await get<{ data: { customer: { id: string } }[] }>('/api/properties', { jar: jars.admin }),
    );
    const zweiteKundschaft = objekte.find((objekt) => objekt.customer.id !== customerId)?.customer;
    assert.ok(zweiteKundschaft, 'zweite Kundschaft im Demobestand');

    const antwort = await jobAnlegen({
      customerId: zweiteKundschaft.id,
      addressId, // gehört der ersten Kundschaft
      title: `${TITEL} fremd`,
      scheduledStart: T_START,
      scheduledEnd: T_ENDE,
    });
    assert.equal(antwort.status, 404, antwort.text);
  });

  it('POST /api/jobs: Kundschaft und Mitarbeitende dürfen nicht anlegen', async () => {
    for (const rolle of ['employee', 'customer'] as const) {
      const antwort = await jobAnlegen(
        { customerId, title: `${TITEL} verboten`, scheduledStart: T_START, scheduledEnd: T_ENDE },
        jars[rolle],
      );
      assert.equal(antwort.status, 403, `${rolle} legt keinen Einsatz an`);
    }
  });

  // =========================================================================
  //  Zuteilung
  // =========================================================================

  it('teilt aktives Personal zu', async () => {
    const jobId = angelegteJobs[0]!;
    const antwort = await post(
      `/api/jobs/${jobId}/assign`,
      { employeeIds: [annaId], notify: false },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 200, antwort.text);

    const job = await get<{ data: { status: string; assignments: { employeeId: string }[] } }>(
      `/api/jobs/${jobId}`,
      { jar: jars.admin },
    );
    assert.equal(data(job).status, 'SCHEDULED');
    assert.deepEqual(
      data(job).assignments.map((zuteilung) => zuteilung.employeeId),
      [annaId],
    );
  });

  it('erkennt die Überschneidung: 08–11 und 10:30–13 gehen nicht zusammen', async () => {
    const zweiter = await jobAnlegen({
      customerId,
      addressId,
      title: `${TITEL} überlappend`,
      scheduledStart: T_UEBERLAPPEND_START,
      scheduledEnd: T_UEBERLAPPEND_ENDE,
    });
    assert.equal(zweiter.status, 201, zweiter.text);
    angelegteJobs.push(data(zweiter).id);

    const antwort = await post<Fehler>(
      `/api/jobs/${data(zweiter).id}/assign`,
      { employeeIds: [annaId], notify: false },
      { jar: jars.admin },
    );

    assert.equal(antwort.status, 422, antwort.text);
    assert.equal(
      antwort.payload.error.details?.conflicts?.[0]?.code,
      'ASSIGNMENT_OVERLAP',
      antwort.text,
    );
  });

  it('weist eine erfundene Personal-ID ab, ohne ihre Existenz zu verraten', async () => {
    const antwort = await post<Fehler>(
      `/api/jobs/${angelegteJobs[0]}/assign`,
      { employeeIds: ['clxxxxxxxxxxxxxxxxxxxxxxx'], notify: false },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 422, antwort.text);
    assert.equal(antwort.payload.error.details?.conflicts?.[0]?.code, 'EMPLOYEE_NOT_FOUND');
  });

  it('Kundschaft und Mitarbeitende teilen niemanden zu', async () => {
    for (const rolle of ['employee', 'customer'] as const) {
      const antwort = await post(
        `/api/jobs/${angelegteJobs[0]}/assign`,
        { employeeIds: [annaId], notify: false },
        { jar: jars[rolle] },
      );
      assert.equal(antwort.status, 403, `${rolle} teilt nicht zu`);
    }
  });

  /**
   * Gleichzeitigkeit (2026-09-27). Prüfung und Schreiben standen schon in
   * einer Transaktion — aber zwei Transaktionen, die *verschiedene* Einsätze
   * anfassen, sperren einander nicht: Beide lasen „frei" und schrieben beide.
   * Jetzt sperrt die Prüfung je Person. Fünf Paare, weil ein Wettlauf ohne
   * Sperre nicht jedes Mal auftritt; mit Sperre muss jedes Paar genau eine
   * Zuteilung ergeben.
   */
  it('zwei gleichzeitige Zuteilungen derselben Person auf überlappende Einsätze: genau eine gelingt — fünfmal', async () => {
    for (let paar = 0; paar < 5; paar++) {
      const a = await jobAnlegen({ customerId, addressId, title: `${TITEL} parallel ${paar}A`, scheduledStart: tag(TAG0 + 5 + paar, 8), scheduledEnd: tag(TAG0 + 5 + paar, 11) });
      const b = await jobAnlegen({ customerId, addressId, title: `${TITEL} parallel ${paar}B`, scheduledStart: tag(TAG0 + 5 + paar, 9), scheduledEnd: tag(TAG0 + 5 + paar, 12) });
      assert.equal(a.status, 201, a.text);
      assert.equal(b.status, 201, b.text);
      angelegteJobs.push(data(a).id, data(b).id);

      const antworten = await Promise.all(
        [data(a).id, data(b).id].map((id) => post(`/api/jobs/${id}/assign`, { employeeIds: [zweiteKraftId], notify: false }, { jar: jars.admin })),
      );
      assert.deepEqual(antworten.map((r) => r.status).sort(), [200, 422], `Paar ${paar}: ${antworten.map((r) => r.text).join(' | ')}`);
    }
  });

  /**
   * Qualifikationen (2026-09-27). Verlangt waren sie bis dahin nur an der
   * Vertragsleistung, geprüft nirgends. Jetzt trägt der Einsatz die
   * Qualifikationen seiner Leistung, und die Zuteilung prüft sie — samt
   * Ablaufdatum.
   */
  describe('Qualifikationen', () => {
    const QUALI = `Prüfqualifikation ${RUN}`;
    let leistungMitQuali = '';

    before(async () => {
      const db = testDb()!;
      const vorlage = await db.service.findUniqueOrThrow({ where: { id: serviceId } });
      leistungMitQuali = (
        await db.service.create({
          data: {
            organizationId: vorlage.organizationId,
            slug: `pruef-quali-${RUN}`,
            kind: vorlage.kind,
            name: `Prüfleistung Qualifikation ${RUN}`,
            shortDesc: 'Nur für die Prüfreihe.',
            description: 'Nur für die Prüfreihe.',
            active: false,
            requiredSkills: [QUALI],
          },
        })
      ).id;
    });

    after(async () => {
      const db = testDb()!;
      await db.employeeSkill.deleteMany({ where: { name: QUALI } });
      await db.job.updateMany({ where: { serviceId: leistungMitQuali }, data: { serviceId: null } });
      await db.service.deleteMany({ where: { id: leistungMitQuali } });
    });

    const einsatzMitQuali = async (offset: number) => {
      const r = await jobAnlegen({ customerId, addressId, serviceId: leistungMitQuali, title: `${TITEL} Qualifikation ${offset}`, scheduledStart: tag(TAG0 + 12 + offset, 8), scheduledEnd: tag(TAG0 + 12 + offset, 10) });
      assert.equal(r.status, 201, r.text);
      angelegteJobs.push(data(r).id);
      return data(r).id;
    };
    const zuteilen = (jobId: string) => post<Fehler>(`/api/jobs/${jobId}/assign`, { employeeIds: [zweiteKraftId], notify: false }, { jar: jars.admin });

    it('der Einsatz übernimmt die Qualifikation seiner Leistung', async () => {
      const id = await einsatzMitQuali(0);
      assert.deepEqual((await testDb()!.job.findUniqueOrThrow({ where: { id } })).requiredSkills, [QUALI]);
    });

    it('ohne Qualifikation → 422 MISSING_SKILL; mit → 200; abgelaufen → 422', async () => {
      const db = testDb()!;
      const ohne = await zuteilen(await einsatzMitQuali(1));
      assert.equal(ohne.status, 422, ohne.text);
      assert.equal(ohne.payload.error.details?.conflicts?.[0]?.code, 'MISSING_SKILL', ohne.text);

      await db.employeeSkill.create({ data: { employeeId: zweiteKraftId, name: QUALI.toUpperCase() } });
      const mit = await zuteilen(await einsatzMitQuali(2));
      assert.equal(mit.status, 200, `gleicher Name, andere Schreibweise: ${mit.text}`);

      await db.employeeSkill.updateMany({ where: { employeeId: zweiteKraftId, name: QUALI.toUpperCase() }, data: { certifiedUntil: new Date(Date.now() - 86_400_000) } });
      const abgelaufen = await zuteilen(await einsatzMitQuali(3));
      assert.equal(abgelaufen.status, 422, abgelaufen.text);
      assert.equal(abgelaufen.payload.error.details?.conflicts?.[0]?.code, 'MISSING_SKILL');
    });
  });

  // =========================================================================
  //  Abwesenheit — der Kern von Phase 2
  // =========================================================================

  describe('Abwesenheit', () => {
    let gesuchId = '';
    let freierJobId = '';

    const gesuchStellen = async (von: string, bis: string) => {
      const antwort = await post<{ data: { id: string } }>(
        '/api/absences',
        { type: 'VACATION', startDate: von, endDate: bis, reason: `Prüflauf ${RUN}` },
        { jar: jars.employee },
      );
      assert.equal(antwort.status, 201, antwort.text);
      return data(antwort).id;
    };

    /**
     * Ein Kalendertag als `JJJJ-MM-TT` — **aus der lokalen Zeit**, nicht aus
     * UTC.
     *
     * Hier stand `toISOString().slice(0, 10)`. Das liefert das UTC-Datum,
     * während `tag()` und `fensterFestlegen` mit `setDate`/`getDay` lokal
     * rechnen. Zwischen Mitternacht und zwei Uhr Zürcher Sommerzeit ist UTC
     * noch der Vortag — und genau dann rutschte das Abwesenheitsfenster um
     * einen Tag nach vorn, auf den Einsatz vom Dienstag, den die
     * Zuteilungsprüfung davor angelegt hatte. Die Bewilligung scheiterte mit
     * „noch 1 Einsätze zugeteilt", obwohl am Produkt nichts falsch war.
     *
     * Aufgefallen am 20.09.2026 bei einem Lauf kurz nach Mitternacht; an
     * jeder anderen Tageszeit war der Fehler unsichtbar.
     */
    const tagOhneZeit = (offsetTage: number) => {
      const date = new Date();
      date.setDate(date.getDate() + offsetTage);
      const jjjj = date.getFullYear();
      const mm = String(date.getMonth() + 1).padStart(2, '0');
      const tt = String(date.getDate()).padStart(2, '0');
      return `${jjjj}-${mm}-${tt}`;
    };

    before(async () => {
      const job = await jobAnlegen({
        customerId,
        addressId,
        title: `${TITEL} Abwesenheit`,
        scheduledStart: T_FREI_START,
        scheduledEnd: T_FREI_ENDE,
      });
      assert.equal(job.status, 201, job.text);
      freierJobId = data(job).id;
      angelegteJobs.push(freierJobId);
    });

    after(async () => {
      if (gesuchId) await post(`/api/absences/${gesuchId}/withdraw`, undefined, { jar: jars.employee });
      /**
       * Bewilligte Gesuche dieses Laufs direkt aus der Testdatenbank entfernen
       * (2026-09-27). Über die Schnittstelle geht das nicht — zu Recht, siehe
       * `fensterFestlegen` —, und so sammelten sie sich Lauf für Lauf an. Die
       * Fenster wichen einander aus, der **Feriensaldo** des Jahres aber nicht:
       * Nach einigen Läufen am selben Tag meldete „ein abgelehntes Gesuch
       * blockiert nicht" plötzlich „Feriensaldo reicht nicht aus". Das war
       * Prüfstand, kein Produkt.
       */
      await testDb()?.absence.deleteMany({ where: { employeeId: annaId, reason: `Prüflauf ${RUN}` } });
    });

    it('ein beantragtes Gesuch blockiert noch nicht', async () => {
      gesuchId = await gesuchStellen(tagOhneZeit(TAG0 + 1), tagOhneZeit(TAG0 + 3));

      const antwort = await post(
        `/api/jobs/${freierJobId}/assign`,
        { employeeIds: [annaId], notify: false },
        { jar: jars.admin },
      );
      assert.equal(antwort.status, 200, `beantragt, nicht entschieden — ${antwort.text}`);

      /**
       * Für die nächste Prüfung wieder freiräumen — und zwar mit `PUT`, denn
       * `/team` *setzt* das Team, es fügt nichts hinzu.
       *
       * Der Grund fürs Freiräumen ist die Gegenrichtung derselben Regel:
       * `decideAbsence` verweigert die Bewilligung, solange im Zeitraum
       * Einsätze zugeteilt sind („erst umplanen, dann bewilligen"). Die beiden
       * Regeln greifen also ineinander — genau das soll so sein.
       */
      const geleert = await put(
        `/api/jobs/${freierJobId}/team`,
        { members: [], notify: false },
        { jar: jars.admin },
      );
      assert.equal(geleert.status, 200, geleert.text);
    });

    it('ein bewilligtes Gesuch blockiert die Zuteilung', async () => {
      const bewilligt = await post(
        `/api/absences/${gesuchId}/decide`,
        { status: 'APPROVED', decisionNote: 'Prüflauf' },
        { jar: jars.admin },
      );
      assert.equal(bewilligt.status, 200, bewilligt.text);

      const antwort = await post<Fehler>(
        `/api/jobs/${freierJobId}/assign`,
        { employeeIds: [annaId], notify: false },
        { jar: jars.admin },
      );

      assert.equal(antwort.status, 422, antwort.text);
      assert.equal(antwort.payload.error.details?.conflicts?.[0]?.code, 'EMPLOYEE_ABSENT');
      assert.match(antwort.payload.error.message, /abwesend/i);
    });

    it('auch das Verschieben in die Ferien hinein wird abgewiesen', async () => {
      // Der Einsatz bekommt zuerst ein Team an einem freien Tag …
      const frei = await jobAnlegen({
        customerId,
        addressId,
        title: `${TITEL} verschieben`,
        scheduledStart: tag(TAG0 + 5, 8),
        scheduledEnd: tag(TAG0 + 5, 11),
      });
      assert.equal(frei.status, 201, frei.text);
      const jobId = data(frei).id;
      angelegteJobs.push(jobId);

      const zugeteilt = await post(
        `/api/jobs/${jobId}/assign`,
        { employeeIds: [annaId], notify: false },
        { jar: jars.admin },
      );
      assert.equal(zugeteilt.status, 200, zugeteilt.text);

      // … und wird dann in den bewilligten Ferienzeitraum gezogen.
      const verschoben = await post<Fehler>(
        `/api/jobs/${jobId}/move`,
        { scheduledStart: T_FREI_START, scheduledEnd: T_FREI_ENDE },
        { jar: jars.admin },
      );
      assert.equal(verschoben.status, 422, verschoben.text);
      assert.equal(verschoben.payload.error.details?.conflicts?.[0]?.code, 'EMPLOYEE_ABSENT');
    });

    it('ein abgelehntes Gesuch blockiert nicht', async () => {
      /**
       * Ein **zweites** Gesuch, kein umentschiedenes erstes: `decideAbsence`
       * lässt jeden Antrag genau einmal entscheiden („Dieser Antrag wurde
       * bereits entschieden."), und das ist richtig so — eine Bewilligung, die
       * sich zurücknehmen liesse, wäre keine.
       */
      const zweitesGesuch = await gesuchStellen(tagOhneZeit(TAG0 + 30), tagOhneZeit(TAG0 + 31));
      const abgelehnt = await post(
        `/api/absences/${zweitesGesuch}/decide`,
        { status: 'REJECTED', decisionNote: 'Prüflauf' },
        { jar: jars.admin },
      );
      assert.equal(abgelehnt.status, 200, abgelehnt.text);

      const job = await jobAnlegen({
        customerId,
        addressId,
        title: `${TITEL} trotz Absage`,
        scheduledStart: tag(TAG0 + 30, 8),
        scheduledEnd: tag(TAG0 + 30, 11),
      });
      assert.equal(job.status, 201, job.text);
      angelegteJobs.push(data(job).id);

      const antwort = await post(
        `/api/jobs/${data(job).id}/assign`,
        { employeeIds: [annaId], notify: false },
        { jar: jars.admin },
      );
      assert.equal(antwort.status, 200, `abgelehnt heisst anwesend — ${antwort.text}`);
    });

    /**
     * Halber Tag (2026-09-27): Vorher ergab „halber Tag" immer 0.5 Tage, egal
     * über welchen Zeitraum und egal an welchem Wochentag — zwei Wochen
     * Abwesenheit für einen halben Ferientag, oder ein halber Samstag vom
     * Saldo.
     */
    it('halber Tag: nur ein Tag, nur an einem Arbeitstag, dann 0.5', async () => {
      const angelegt: string[] = [];
      const antrag = async (von: string, bis: string) => {
        const r = await post<{ data: { id: string; days: string | number } }>(
          '/api/absences',
          { type: 'VACATION', startDate: von, endDate: bis, halfDay: true, reason: `Prüflauf ${RUN}` },
          { jar: jars.employee },
        );
        // Auch ein fälschlich angenommener Antrag wird wieder zurückgezogen —
        // sonst blockierte er Anna in allen folgenden Läufen.
        if (r.status === 201) angelegt.push(data(r).id);
        return r;
      };
      // Ein Montag und der Samstag davor, weit genug voraus, dass nichts anderes dort liegt.
      let montag = TAG0 + 60;
      while (new Date(`${tagOhneZeit(montag)}T12:00:00Z`).getUTCDay() !== 1) montag += 1;

      try {
        const ueberMehrereTage = await antrag(tagOhneZeit(montag), tagOhneZeit(montag + 11));
        assert.equal(ueberMehrereTage.status, 422, `halber Tag über zwölf Tage: ${ueberMehrereTage.text}`);

        const samstag = await antrag(tagOhneZeit(montag - 2), tagOhneZeit(montag - 2));
        assert.equal(samstag.status, 422, `halber Samstag: ${samstag.text}`);

        const gueltig = await antrag(tagOhneZeit(montag), tagOhneZeit(montag));
        assert.equal(gueltig.status, 201, gueltig.text);
        assert.equal(Number(data(gueltig).days), 0.5);
      } finally {
        for (const id of angelegt) await post(`/api/absences/${id}/withdraw`, undefined, { jar: jars.employee });
      }
    });
  });

  // =========================================================================
  //  Zugangsdaten
  // =========================================================================

  describe('Zugangsdaten am Objekt', () => {
    const CODE = `9${RUN % 1000}#`;
    let jobId = '';
    let jobNummer = '';

    before(async () => {
      const gesetzt = await patch(
        `/api/properties/${propertyId}`,
        { alarmCode: CODE },
        { jar: jars.admin },
      );
      assert.equal(gesetzt.status, 200, gesetzt.text);

      const job = await jobAnlegen({
        customerId,
        addressId,
        propertyId,
        title: `${TITEL} Zugang`,
        scheduledStart: tag(TAG0 + 10, 8),
        scheduledEnd: tag(TAG0 + 10, 11),
      });
      assert.equal(job.status, 201, job.text);
      jobId = data(job).id;
      jobNummer = data(job).number;
      angelegteJobs.push(jobId);

      const zugeteilt = await post(
        `/api/jobs/${jobId}/assign`,
        { employeeIds: [annaId], notify: false },
        { jar: jars.admin },
      );
      assert.equal(zugeteilt.status, 200, zugeteilt.text);
    });

    it('erscheint weder im Klartext noch als Chiffrat in der Einsatzliste', async () => {
      const liste = await get('/api/jobs?pageSize=50', { jar: jars.admin });
      assert.equal(liste.status, 200);
      assert.ok(!liste.text.includes(CODE), 'kein Klartext in der Liste');
      assert.ok(!liste.text.includes('enc:v1:'), 'kein Chiffrat in der Liste');
      assert.ok(!liste.text.includes('alarmCode'), 'das Feld ist gar nicht Teil der Liste');
    });

    it('erscheint auch im Einsatzdetail der Schnittstelle nicht', async () => {
      // Die Schnittstelle liefert den Einsatz ohne Zugangsgeheimnisse; den
      // Code bekommt nur der Rapport im Portal, der ihn wirklich braucht.
      const detail = await get(`/api/jobs/${jobId}`, { jar: jars.admin });
      assert.equal(detail.status, 200, detail.text);
      assert.ok(!detail.text.includes(CODE), 'kein Klartext');
      assert.ok(!detail.text.includes('enc:v1:'), 'kein Chiffrat');
    });

    it('steht auf dem Rapport der zugeteilten Person', async () => {
      const seite = await get(`/portal/einsaetze/${jobId}`, { jar: jars.employee });
      assert.equal(seite.status, 200, `Rapport erreichbar (${seite.status})`);
      assert.ok(seite.text.includes(CODE), 'die zugeteilte Person sieht den Alarmcode');
    });

    it('bleibt für nicht zugeteilte Mitarbeitende unerreichbar', async () => {
      // Anna abziehen, zweite Kraft einteilen — Anna darf danach weder den
      // Einsatz noch den Code zu sehen bekommen.
      const umgeteilt = await post(
        `/api/jobs/${jobId}/assign`,
        { employeeIds: [zweiteKraftId], notify: false },
        { jar: jars.admin },
      );
      assert.equal(umgeteilt.status, 200, umgeteilt.text);

      const seite = await get(`/portal/einsaetze/${jobId}`, { jar: jars.employee });

      /**
       * Geprüft wird der **Inhalt**, nicht der Statuscode — und das ist kein
       * nachgiebiger Test, sondern der genauere.
       *
       * Die Seite hat ein `loading.tsx`. Next liefert deshalb sofort die
       * Hülle mit 200 aus und schiebt den fertigen Inhalt im selben Strom
       * nach. Wenn die Server Component danach `notFound()` wirft, ist der
       * Statuscode längst abgeschickt und lässt sich nicht mehr ändern; die
       * Nicht-gefunden-Darstellung kommt als Nachtrag im Strom. Das gilt für
       * jede gestreamte Seite dieser Anwendung und ist keine Eigenheit dieses
       * Einsatzes.
       *
       * Die Sicherheitsaussage hängt daran nicht: Entscheidend ist, dass von
       * dem Einsatz nichts durchkommt — weder Nummer noch Alarmcode. Genau das
       * steht hier.
       */
      assert.ok(!seite.text.includes(CODE), 'kein Alarmcode für eine fremde Person');
      assert.ok(!seite.text.includes(jobNummer), 'und auch sonst nichts von diesem Einsatz');
    });
  });

  // =========================================================================
  //  Doppelte Einsätze aus einer Buchung
  // =========================================================================

  it('zweimaliges Bestätigen einer Buchung erzeugt keinen zweiten Einsatz', async () => {
    const angelegt = await post<{ data: { id: string; number: string } }>(
      '/api/bookings',
      {
        customerId,
        serviceId,
        addressId,
        scheduledStart: tag(TAG0 + 20, 9),
        squareMeters: 60,
        source: 'PHONE',
      },
      { jar: jars.admin },
    );
    assert.equal(angelegt.status, 201, angelegt.text);
    const bookingId = data(angelegt).id;
    angelegteBuchungen.push(bookingId);

    const zaehleEinsaetze = async () => {
      const liste = await get<{ data: { bookingId: string | null }[] }>(
        '/api/jobs?pageSize=100&from=' + encodeURIComponent(tag(TAG0 + 19, 0)) + '&to=' + encodeURIComponent(tag(TAG0 + 21, 0)),
        { jar: jars.admin },
      );
      return data(liste).filter((job) => job.bookingId === bookingId).length;
    };

    const ersteBestaetigung = await post(`/api/bookings/${bookingId}/confirm`, undefined, {
      jar: jars.admin,
    });
    assert.equal(ersteBestaetigung.status, 200, ersteBestaetigung.text);
    assert.equal(await zaehleEinsaetze(), 1, 'ein Einsatz nach der ersten Bestätigung');

    // Wiederholung — ob sie mit 200 oder 422 endet, entscheidet die
    // Statusregel; entscheidend ist, dass kein zweiter Einsatz entsteht.
    const zweiteBestaetigung = await post(`/api/bookings/${bookingId}/confirm`, undefined, {
      jar: jars.admin,
    });
    assert.ok(zweiteBestaetigung.status < 500, zweiteBestaetigung.text);
    assert.equal(await zaehleEinsaetze(), 1, 'auch nach der zweiten Bestätigung nur einer');
  });
});

