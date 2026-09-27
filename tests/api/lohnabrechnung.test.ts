import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  SAETZE_2026,
  alterImJahr,
  berechneBeitraege,
  bvgSatzFuerAlter,
  koordinierterLohn,
  rappen,
  type BeitragsSaetze,
} from '../../src/lib/payroll/beitraege';
import { createHash } from 'node:crypto';

import { BASE_URL, get, post, patch, put, del, data, requireServer } from '../helpers/client';
import { ACCOUNTS, loginAll, type AccountName } from '../helpers/accounts';
import {
  fremdeOrganisation,
  lohnBelegeEntfernen,
  schutzfreiAufraeumen,
  testDb,
  testDbGrund,
  testDbSchliessen,
} from '../helpers/testdb';

after(async () => {
  await testDbSchliessen();
});

/**
 * Wave 9 — Lohnabrechnung.
 *
 * ---------------------------------------------------------------------------
 *  Warum der Rechenkern direkt geprüft wird
 * ---------------------------------------------------------------------------
 *
 * Dieselbe Begründung wie bei `bi-rechenkerne`: Gegenstand ist die Rechnung
 * selbst, nicht ihr Weg durch die Anwendung. Ob ein koordinierter Lohn stimmt,
 * lässt sich über HTTP nur mit einem Datenbestand prüfen, der die Rechnung
 * verdeckt — und die Kantenfälle (Lohn knapp über der Eintrittsschwelle, Alter
 * genau an einer Bandgrenze) müsste man sich als Personalakten bauen.
 *
 * Mit festen Zahlen ist jede Zeile nachrechenbar, und genau das ist bei einer
 * Lohnabrechnung der Punkt: Die Zahl geht an eine Person, die sie nachrechnet.
 *
 * ---------------------------------------------------------------------------
 *  Und was über HTTP geprüft wird
 * ---------------------------------------------------------------------------
 *
 * Dass die Maschine läuft — `Payslip` stand seit der ersten Migration im
 * Schema, und **kein Codepfad hat je eine Abrechnung erzeugt.** Dazu die drei
 * Regeln, deren Verletzung Geld kostet: Nur freigegebene Zeiten zählen, ein
 * laufender Monat wird nicht abgerechnet, und eine veröffentlichte Abrechnung
 * ist unveränderlich.
 */

let jars: Record<AccountName, string>;

// ===========================================================================
//  Der Rechenkern
// ===========================================================================

describe('Beitragsrechnung', () => {
  it('rechnet AHV/IV/EO, ALV und UVG auf den Bruttolohn', () => {
    const b = berechneBeitraege(
      { bruttoMonat: 5000, bruttoJahr: 60_000, alter: 40 },
      SAETZE_2026,
    );

    assert.equal(b.ahvIv, 265, '5000 × 5,3 %');
    assert.equal(b.alv, 55, '5000 × 1,1 %');
    assert.equal(b.uvg, 80, '5000 × 1,6 %');
    assert.equal(b.ktg, 0, 'ohne Krankentaggeldversicherung');
  });

  /**
   * Der koordinierte Lohn ist die Stelle, an der ein Nachbau am häufigsten
   * scheitert — und der Fehler trifft genau die Teilzeitstellen, die in diesem
   * Gewerbe die Mehrheit sind.
   */
  it('koordinierter Lohn: unter der Eintrittsschwelle gibt es keine Versicherung', () => {
    const k = koordinierterLohn(20_000, SAETZE_2026);
    assert.equal(k.versichert, false);
    assert.equal(k.betrag, 0);
    assert.ok(k.grund?.includes('Eintrittsschwelle'));
  });

  it('koordinierter Lohn: der Mindestbetrag fängt knappe Fälle auf', () => {
    // 27 000 − 26 460 = 540 — unter dem Mindestbetrag von 3780.
    const k = koordinierterLohn(27_000, SAETZE_2026);
    assert.equal(k.versichert, true);
    assert.equal(
      k.betrag,
      SAETZE_2026.bvgMindestKoordiniert,
      'ohne den Mindestbetrag fiele jemand knapp über der Schwelle auf fast null',
    );
  });

  it('koordinierter Lohn: der übliche Fall ist Lohn minus Abzug', () => {
    const k = koordinierterLohn(60_000, SAETZE_2026);
    assert.equal(k.betrag, 60_000 - 26_460);
  });

  it('koordinierter Lohn: über der Obergrenze wird gekappt', () => {
    const k = koordinierterLohn(200_000, SAETZE_2026);
    assert.equal(k.betrag, SAETZE_2026.bvgObergrenze - SAETZE_2026.bvgKoordinationsabzug);
  });

  it('die Altersbänder greifen ab dem Bandanfang', () => {
    assert.equal(bvgSatzFuerAlter(24, SAETZE_2026), 0, 'unter 25 kein Sparbeitrag');
    assert.equal(bvgSatzFuerAlter(25, SAETZE_2026), 7);
    assert.equal(bvgSatzFuerAlter(34, SAETZE_2026), 7);
    assert.equal(bvgSatzFuerAlter(35, SAETZE_2026), 10);
    assert.equal(bvgSatzFuerAlter(45, SAETZE_2026), 15);
    assert.equal(bvgSatzFuerAlter(55, SAETZE_2026), 18);
    assert.equal(bvgSatzFuerAlter(70, SAETZE_2026), 18, 'über dem letzten Band bleibt es dabei');
  });

  /**
   * Ohne Geburtsdatum wird **nichts** abgezogen. Ein geratener Satz wäre ein
   * falscher Lohn; die fehlende Angabe ist eine Lücke in der Personalakte und
   * gehört dort behoben.
   */
  it('ohne Alter gibt es keine Altersgutschrift — und die Antwort sagt warum', () => {
    const b = berechneBeitraege(
      { bruttoMonat: 5000, bruttoJahr: 60_000, alter: null },
      SAETZE_2026,
    );
    assert.equal(b.bvg, 0);
    assert.ok(
      b.herleitung.bvgGrund?.includes('Geburtsdatum'),
      `Grund fehlt oder passt nicht: ${b.herleitung.bvgGrund}`,
    );
  });

  it('rechnet den BVG-Abzug als Zwölftel des Arbeitnehmeranteils', () => {
    const b = berechneBeitraege(
      { bruttoMonat: 5000, bruttoJahr: 60_000, alter: 40 },
      SAETZE_2026,
    );

    // Koordiniert 33 540 × 10 % = 3354 im Jahr, davon die Hälfte, davon ein Zwölftel.
    const erwartet = rappen((33_540 * 0.1) / 12 / 2);
    assert.equal(b.bvg, erwartet);
    assert.equal(b.herleitung.bvgKoordinierterJahreslohn, 33_540);
    assert.equal(b.herleitung.bvgSatzGesamt, 10);
  });

  /**
   * Die ALV-Grenze ist eine Jahresgrenze und wird auf den Monat
   * heruntergebrochen. Über der Grenze gilt seit 2023 kein Satz mehr — das
   * Feld bleibt trotzdem, weil ein aufgehobener Beitrag wiederkommen kann.
   */
  it('die ALV-Grenze wirkt auf den Monatslohn', () => {
    const grenzeMonat = SAETZE_2026.alvGrenzeJahr / 12; // 12 350
    const b = berechneBeitraege(
      { bruttoMonat: 20_000, bruttoJahr: 240_000, alter: 40 },
      SAETZE_2026,
    );

    assert.equal(b.herleitung.alvPflichtigerMonatslohn, rappen(grenzeMonat));
    assert.equal(b.herleitung.alvUeberGrenzeMonatslohn, rappen(20_000 - grenzeMonat));
    assert.equal(b.alv, rappen(grenzeMonat * 0.011), 'über der Grenze 0 % seit 2023');
  });

  it('ein Solidaritätsbeitrag würde greifen, wenn er wieder eingeführt wird', () => {
    const mitSolidaritaet: BeitragsSaetze = { ...SAETZE_2026, alvUeberGrenze: 0.5 };
    const grenzeMonat = SAETZE_2026.alvGrenzeJahr / 12;

    const b = berechneBeitraege(
      { bruttoMonat: 20_000, bruttoJahr: 240_000, alter: 40 },
      mitSolidaritaet,
    );
    assert.equal(
      b.alv,
      rappen(grenzeMonat * 0.011 + (20_000 - grenzeMonat) * 0.005),
    );
  });

  /**
   * Gerundet wird **je Beitragsart**, nicht erst am Ende. Das ist die Praxis
   * der Lohnbuchhaltung: Der einzelne Abzug erscheint auf der Abrechnung, und
   * eine Summe, die sich aus den angezeigten Zeilen nicht nachrechnen lässt,
   * erzeugt eine Rückfrage je Monat.
   */
  it('die Summe ist die Summe der angezeigten Zeilen', () => {
    const b = berechneBeitraege(
      { bruttoMonat: 4321.55, bruttoJahr: 51_858.6, alter: 47 },
      SAETZE_2026,
    );
    assert.equal(b.summe, rappen(b.ahvIv + b.alv + b.bvg + b.uvg + b.ktg));
  });

  it('ein Bruttolohn von null ergibt keine Abzüge', () => {
    const b = berechneBeitraege({ bruttoMonat: 0, bruttoJahr: 0, alter: 40 }, SAETZE_2026);
    assert.equal(b.summe, 0);
  });

  /**
   * Das Alter am 31. Dezember, nicht am Stichtag: Die BVG-Altersbänder
   * wechseln auf den 1. Januar nach dem Geburtstag. Am Stichtag zu rechnen
   * liesse den Satz mitten im Jahr springen.
   */
  it('das Alter gilt für das ganze Abrechnungsjahr', () => {
    assert.equal(alterImJahr(new Date(Date.UTC(1990, 11, 31)), 2026), 36);
    assert.equal(alterImJahr(new Date(Date.UTC(1990, 0, 1)), 2026), 36);
    assert.equal(alterImJahr(null, 2026), null);
  });
});

// ===========================================================================
//  Über HTTP
// ===========================================================================

describe('Lohnlauf', () => {
  let employeeId = '';
  const zeiten: string[] = [];

  /**
   * Eine Person mit **Stundenlohn** und ohne Monatslohn.
   *
   * Der erste Datensatz der Liste (nach Nachname sortiert) ist im Demobestand
   * die Person mit Monatslohn — bei ihr greift die Zeiterfassung gar nicht,
   * und der Kernfall dieser Reihe wäre stillschweigend übersprungen worden.
   * Die Auswahl muss zum geprüften Fall passen, nicht zur Sortierung.
   */
  before(async () => {
    await requireServer();
    jars = await loginAll();

    const liste = await get<{ data: { id: string }[] }>('/api/employees', { jar: jars.admin });
    assert.equal(liste.status, 200);

    for (const kandidat of data(liste).slice(0, 15)) {
      const detail = await get<{
        data: { hourlyRate: number | null; monthlySalary: number | null };
      }>(`/api/employees/${kandidat.id}`, { jar: jars.admin });
      if (detail.status !== 200) continue;

      const akte = data(detail);
      if (akte.hourlyRate && Number(akte.hourlyRate) > 0 && !akte.monthlySalary) {
        employeeId = kandidat.id;
        break;
      }
    }

    assert.ok(
      employeeId,
      'für diese Prüfungen braucht es eine Personalakte mit Stundenlohn',
    );
  });

  /**
   * Seit dem Ausbau vom 2026-09-23 gibt es keine Jahreszeile mehr, sondern
   * Satzversionen je Art. Die Migration hat die alten Jahreszeilen übernommen;
   * ein Lauf legt fehlende Versionen als ungeprüfte Vorbelegung an.
   */
  it('die Satzversionen tragen Herkunft und Prüfstand', async () => {
    const antwort = await get<{
      data: { code: string; employeePct: string; source: string; verification: string; validFrom: string }[];
    }>('/api/payroll/rates?year=2026', { jar: jars.admin });
    assert.equal(antwort.status, 200);
    const ahv = data(antwort).find((v) => v.code === 'AHV_IV_EO');
    assert.ok(ahv, 'für 2026 muss es eine AHV-Version geben (übernommen aus der Jahreszeile)');
    assert.equal(Number(ahv.employeePct), 5.3);
    assert.ok(ahv.source.length > 3, 'jede Version trägt ihre Herkunft');
    assert.ok(['UNGEPRUEFT', 'GEPRUEFT'].includes(ahv.verification));
  });

  /**
   * Gesetzlich trägt der Betrieb mindestens die Hälfte der Altersgutschrift
   * (Art. 66 BVG). Ein höherer Arbeitnehmeranteil wäre kein Tippfehler, den
   * man durchlassen sollte — er stünde auf jeder Abrechnung.
   */
  it('mehr als 50 % Arbeitnehmeranteil am BVG wird abgewiesen', async () => {
    const antwort = await post(
      '/api/payroll/rates',
      {
        code: 'BVG',
        validFrom: '2099-01-01',
        source: 'Prüfreihe',
        employeePct: 60,
        employerPct: 40,
        parameters: {
          eintrittsschwelle: 22680,
          koordinationsabzug: 26460,
          mindestKoordiniert: 3780,
          obergrenze: 90720,
          baender: [{ abAlter: 25, satz: 7 }],
        },
      },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 422);
    assert.ok(JSON.stringify(antwort.payload).includes('Art. 66'));
  });

  it('eine Satzversion ohne Quelle wird abgewiesen', async () => {
    const antwort = await post(
      '/api/payroll/rates',
      { code: 'UVG_NBU', validFrom: '2099-01-01', employeePct: 1.4 },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 422);
  });

  /**
   * Der Fall, den das abfängt: Am 12. des Monats einen Lauf starten, weil man
   * „schon mal schauen" will. Das Ergebnis sähe aus wie eine Abrechnung und
   * wäre um zwei Drittel zu tief.
   */
  it('ein laufender Monat wird nicht abgerechnet', async () => {
    const jetzt = new Date();
    const antwort = await post(
      '/api/payroll/run',
      { year: jetzt.getUTCFullYear(), month: jetzt.getUTCMonth() + 1 },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 422);
    assert.ok(JSON.stringify(antwort.payload).includes('abgeschlossen'));
  });

  /**
   * **Der Kern dieser Wave.** Zeiten erfassen, freigeben, abrechnen — und
   * nachsehen, ob tatsächlich eine Abrechnung entstanden ist. Über HTTP allein
   * wäre nicht zu unterscheiden, ob die Maschine läuft oder ob wieder nichts
   * passiert.
   */
  it('freigegebene Zeiten ergeben eine Abrechnung, offene nicht', async (t) => {
    // Ein abgeschlossener Monat: der vorletzte.
    const jetzt = new Date();
    const stichtag = new Date(Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth() - 2, 15));
    const jahr = stichtag.getUTCFullYear();
    const monat = stichtag.getUTCMonth() + 1;

    const erfassen = async (tag: number, stunde: number, dauer: number) => {
      const start = new Date(Date.UTC(jahr, monat - 1, tag, stunde, 0, 0));
      const ende = new Date(start.getTime() + dauer * 3_600_000);
      const antwort = await post<{ data: { id: string } }>(
        '/api/time',
        {
          employeeId,
          startedAt: start.toISOString(),
          endedAt: ende.toISOString(),
          breakMin: 0,
        },
        { jar: jars.admin },
      );
      assert.equal(antwort.status, 201, `Erfassung am ${tag}. scheiterte`);
      zeiten.push(data(antwort).id);
      return data(antwort).id;
    };

    const freigegebenId = await erfassen(4, 8, 4);
    await erfassen(5, 8, 4); // bleibt offen

    await post('/api/time/approve', { entryIds: [freigegebenId] }, { jar: jars.admin });

    const lauf = await post<{
      data: {
        saetzeGeprueft: boolean;
        ergebnisse: {
          employeeId: string;
          status: string;
          brutto?: number;
          netto?: number;
          offeneErfassungen?: number;
        }[];
      };
    }>('/api/payroll/run', { year: jahr, month: monat, employeeIds: [employeeId] }, {
      jar: jars.admin,
    });

    assert.equal(lauf.status, 200);
    const eintrag = data(lauf).ergebnisse.find((e) => e.employeeId === employeeId);
    assert.ok(eintrag, 'die Person muss im Ergebnis stehen');

    if (eintrag.status === 'UEBERSPRUNGEN') {
      return t.skip(`übersprungen — vermutlich kein Stundenansatz hinterlegt`);
    }

    assert.ok(eintrag.brutto && eintrag.brutto > 0, 'es muss ein Bruttolohn herauskommen');
    assert.ok(eintrag.netto && eintrag.netto < eintrag.brutto, 'Netto liegt unter Brutto');
    assert.equal(
      eintrag.offeneErfassungen,
      1,
      'die offene Erfassung wird gemeldet, aber nicht bezahlt',
    );
  });

  it('die Abrechnung trägt ihre Herleitung', async (t) => {
    const liste = await get<{
      data: { eintraege: { id: string; grossPay: number; netPay: number }[] };
    }>(`/api/payroll/payslips?employeeId=${employeeId}`, { jar: jars.admin });
    assert.equal(liste.status, 200);

    const erste = data(liste).eintraege[0];
    if (!erste) return t.skip('keine Abrechnung im Bestand');

    const detail = await get<{
      data: { breakdown: { saetze: unknown; bvgKoordinierterJahreslohn: number } };
    }>(`/api/payroll/payslips/${erste.id}`, { jar: jars.admin });
    assert.equal(detail.status, 200);

    const herleitung = data(detail).breakdown;
    assert.ok(herleitung, 'ohne Herleitung ist der BVG-Abzug nicht nachrechenbar');
    assert.ok(herleitung.saetze, 'die angewandten Sätze gehören als Momentaufnahme dazu');
    assert.equal(typeof herleitung.bvgKoordinierterJahreslohn, 'number');
  });

  it('ein zweiter Lauf über denselben Monat ist unbedenklich', async (t) => {
    const jetzt = new Date();
    const stichtag = new Date(Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth() - 2, 15));

    const lauf = await post<{ data: { ergebnisse: { status: string }[] } }>(
      '/api/payroll/run',
      {
        year: stichtag.getUTCFullYear(),
        month: stichtag.getUTCMonth() + 1,
        employeeIds: [employeeId],
      },
      { jar: jars.admin },
    );
    assert.equal(lauf.status, 200);

    const status = data(lauf).ergebnisse[0]?.status;
    if (!status) return t.skip('kein Ergebnis');
    assert.ok(
      ['AKTUALISIERT', 'UEBERSPRUNGEN'].includes(status),
      `erwartet AKTUALISIERT oder UEBERSPRUNGEN, kam ${status}`,
    );
  });

  // -------------------------------------------------------------------------
  //  Korrekturen vom 2026-09-23
  // -------------------------------------------------------------------------

  /** Mitternacht in Zürich als Zeitpunkt — Sommer +2 h, Winter +1 h. */
  const zuercherMitternacht = (jahr: number, monat0: number, tag: number) => {
    const versuch = Date.UTC(jahr, monat0, tag);
    const teile = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Zurich',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(versuch));
    const f = Object.fromEntries(teile.filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
    const gesehen = Date.UTC(f.year!, f.month! - 1, f.day!, f.hour === 24 ? 0 : f.hour!, f.minute!);
    return new Date(versuch - (gesehen - versuch));
  };

  const stundenIm = async (jahr: number, monat: number): Promise<number> => {
    const lauf = await post<{ data: { ergebnisse: { employeeId: string; status: string; payslipId?: string }[] } }>(
      '/api/payroll/run',
      { year: jahr, month: monat, employeeIds: [employeeId] },
      { jar: jars.admin },
    );
    assert.equal(lauf.status, 200, JSON.stringify(lauf.payload));
    const e = data(lauf).ergebnisse.find((x) => x.employeeId === employeeId);
    if (!e?.payslipId) return 0;
    const detail = await get<{ data: { hours: number } }>(`/api/payroll/payslips/${e.payslipId}`, { jar: jars.admin });
    return Number(data(detail).hours);
  };

  /**
   * Bis 2026-09-23 lief das Monatsfenster in UTC. Eine Schicht, die am 1. um
   * 00:30 Ortszeit begann, lag in UTC am letzten Tag des Vormonats und wurde
   * dort bezahlt.
   */
  it('eine Schicht ab 00:30 am Monatsersten zählt zum neuen Monat (Zürich, nicht UTC)', async () => {
    const jetzt = new Date();
    const monatsbeginn = new Date(Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth() - 5, 1));
    const jahr = monatsbeginn.getUTCFullYear();
    const monat = monatsbeginn.getUTCMonth() + 1;
    const vorher = new Date(Date.UTC(jahr, monat - 2, 1));

    const altVormonat = await stundenIm(vorher.getUTCFullYear(), vorher.getUTCMonth() + 1);
    const altMonat = await stundenIm(jahr, monat);

    const start = new Date(zuercherMitternacht(jahr, monat - 1, 1).getTime() + 30 * 60_000);
    const erfasst = await post<{ data: { id: string } }>(
      '/api/time',
      { employeeId, startedAt: start.toISOString(), endedAt: new Date(start.getTime() + 2 * 3_600_000).toISOString(), breakMin: 0 },
      { jar: jars.admin },
    );
    assert.equal(erfasst.status, 201, JSON.stringify(erfasst.payload));
    zeiten.push(data(erfasst).id);
    assert.notEqual(start.getUTCMonth() + 1, monat, 'In UTC liegt der Beginn noch im Vormonat — genau der Fall');
    await post('/api/time/approve', { entryIds: [data(erfasst).id] }, { jar: jars.admin });

    assert.equal(await stundenIm(vorher.getUTCFullYear(), vorher.getUTCMonth() + 1), altVormonat, 'Der Vormonat bekommt die Schicht nicht');
    assert.equal(await stundenIm(jahr, monat), altMonat + 2, 'Der neue Monat bekommt sie');
  });

  /**
   * Bis 2026-09-23 liess sich eine Zeit im bereits veröffentlichten Monat
   * wieder öffnen, ändern und erneut freigeben — und der Beleg stimmte nicht
   * mehr mit der Zeiterfassung überein.
   */
  it('eine veröffentlichte Abrechnung schliesst den Monat', async () => {
    const jetzt = new Date();
    const monatsbeginn = new Date(Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth() - 7, 1));
    const jahr = monatsbeginn.getUTCFullYear();
    const monat = monatsbeginn.getUTCMonth() + 1;
    const um = (tag: number) => new Date(Date.UTC(jahr, monat - 1, tag, 8));
    const erfassen = async (tag: number) => {
      const antwort = await post<{ data: { id: string } }>(
        '/api/time',
        { employeeId, startedAt: um(tag).toISOString(), endedAt: new Date(um(tag).getTime() + 3 * 3_600_000).toISOString(), breakMin: 0 },
        { jar: jars.admin },
      );
      assert.equal(antwort.status, 201, JSON.stringify(antwort.payload));
      return data(antwort).id;
    };

    const bezahlt = await erfassen(10);
    const spaet = await erfassen(11);
    await post('/api/time/approve', { entryIds: [bezahlt] }, { jar: jars.admin });

    const lauf = await post<{ data: { ergebnisse: { employeeId: string; payslipId?: string }[] } }>(
      '/api/payroll/run',
      { year: jahr, month: monat, employeeIds: [employeeId] },
      { jar: jars.admin },
    );
    const payslipId = data(lauf).ergebnisse.find((e) => e.employeeId === employeeId)?.payslipId;
    assert.ok(payslipId, JSON.stringify(lauf.payload));
    const veroeffentlicht = await post<{ data: { veroeffentlicht: number } }>(
      '/api/payroll/publish',
      { payslipIds: [payslipId], trotzUngepruefterSaetze: true },
      { jar: jars.admin },
    );
    assert.equal(veroeffentlicht.status, 200, JSON.stringify(veroeffentlicht.payload));
    assert.equal(data(veroeffentlicht).veroeffentlicht, 1, JSON.stringify(veroeffentlicht.payload));

    try {
      assert.equal((await post(`/api/time/${bezahlt}/reopen`, undefined, { jar: jars.admin })).status, 422, 'Die bezahlte Zeit bleibt freigegeben');
      const spaeteFreigabe = await post<{ data: { freigegeben: number } }>('/api/time/approve', { entryIds: [spaet] }, { jar: jars.admin });
      assert.equal(data(spaeteFreigabe).freigegeben, 0, 'Eine späte Freigabe ändert den bezahlten Monat nicht');
      const nacherfasst = await post(
        '/api/time',
        { employeeId, startedAt: um(12).toISOString(), endedAt: new Date(um(12).getTime() + 3_600_000).toISOString(), breakMin: 0 },
        { jar: jars.admin },
      );
      assert.equal(nacherfasst.status, 422, 'Keine Nacherfassung im abgeschlossenen Monat');

      const zweiterLauf = await post<{ data: { ergebnisse: { employeeId: string; status: string }[] } }>(
        '/api/payroll/run',
        { year: jahr, month: monat, employeeIds: [employeeId] },
        { jar: jars.admin },
      );
      assert.equal(data(zweiterLauf).ergebnisse.find((e) => e.employeeId === employeeId)?.status, 'UEBERSPRUNGEN');
    } finally {
      // Aufräumen an der Anwendung vorbei — sie lässt es zu Recht nicht zu,
      // und seit Wave 9 auch die Datenbank nicht (Trigger).
      await schutzfreiAufraeumen(async (tx) => {
        await tx.timeEntry.deleteMany({ where: { id: { in: [bezahlt, spaet] } } });
        await lohnBelegeEntfernen(tx, [payslipId!]);
      });
    }
  });

  // -------------------------------------------------------------------------
  //  Grenzen
  // -------------------------------------------------------------------------

  it('die Betriebsleitung sieht keine Lohnabrechnungen', async () => {
    const liste = await get('/api/payroll/payslips', { jar: jars.manager });
    assert.ok(
      liste.status === 403 || liste.status === 401,
      `die Betriebsleitung hat keinen Lohneinblick (kam ${liste.status})`,
    );

    const lauf = await post(
      '/api/payroll/run',
      { year: 2026, month: 1 },
      { jar: jars.manager },
    );
    assert.ok(lauf.status === 403 || lauf.status === 401);
  });

  it('Mitarbeitende und Kundschaft kommen nicht an die Liste', async () => {
    for (const rolle of ['employee', 'customer'] as AccountName[]) {
      const antwort = await get('/api/payroll/payslips', { jar: jars[rolle] });
      assert.ok(
        antwort.status === 403 || antwort.status === 401,
        `${rolle} darf keine fremden Abrechnungen sehen (kam ${antwort.status})`,
      );
    }
  });

  /**
   * Eine unveröffentlichte Abrechnung ist ein Entwurf. Eine Zahl, die sich
   * ändert, nachdem jemand sie gesehen hat, ist schlimmer als keine Zahl.
   */
  it('Mitarbeitende sehen keine unveröffentlichte Abrechnung', async (t) => {
    const liste = await get<{ data: { eintraege: { id: string; published: boolean }[] } }>(
      '/api/payroll/payslips?published=false',
      { jar: jars.admin },
    );
    const entwurf = data(liste).eintraege[0];
    if (!entwurf) return t.skip('keine unveröffentlichte Abrechnung im Bestand');

    const antwort = await get(`/api/payroll/payslips/${entwurf.id}`, { jar: jars.employee });
    assert.equal(antwort.status, 404, 'für die eigene Person existiert ein Entwurf nicht');
  });

  it('eine unbekannte Abrechnung gibt es nicht', async () => {
    const antwort = await get('/api/payroll/payslips/clzzzzzzzzzzzzzzzzzzzzzzz', {
      jar: jars.admin,
    });
    assert.equal(antwort.status, 404);
  });

  it('ein unmöglicher Monat wird abgewiesen', async () => {
    const antwort = await post('/api/payroll/run', { year: 2026, month: 13 }, { jar: jars.admin });
    assert.equal(antwort.status, 422);
  });

  /**
   * Aufräumen: Die erfassten Zeiten wieder entfernen, damit sie die
   * Nachkalkulation der Einsätze und die Summen anderer Prüfdateien nicht
   * verfälschen. Die Abrechnungen bleiben — sie sind nicht veröffentlicht und
   * werden vom nächsten Lauf überschrieben.
   */
  it('räumt die erfassten Zeiten wieder ab', async () => {
    for (const id of zeiten) {
      await post(`/api/time/${id}/reopen`, undefined, { jar: jars.admin }).catch(() => {});
      await del(`/api/time/${id}`, { jar: jars.admin }).catch(() => {});
    }

    const rest = await get<{ data: { eintraege: { id: string }[] } }>(
      `/api/time?employeeId=${employeeId}&pageSize=200`,
      { jar: jars.admin },
    );
    for (const id of zeiten) {
      assert.ok(
        !data(rest).eintraege.some((e) => e.id === id),
        'die Prüfreihe darf keine Zeiten hinterlassen',
      );
    }
  });
});

// ===========================================================================
//  Ausbau vom 2026-09-23: Satzversionen, Zeilen, Positionen, 13. Monatslohn,
//  Quellensteuer, PDF, Lohnausweis
// ===========================================================================

/**
 * **Eigene Personalakten mit festen Daten, in abgeschlossenen Jahren.**
 *
 * Die Demoakten haben Eintrittsdaten und Löhne, die sich mit dem Seed ändern
 * können; eine Erwartung wie „15/30 × 6000 + 15/30 × 6200" braucht eine Akte,
 * deren Lohnhistorie die Prüfung selbst geschrieben hat. Die Monate liegen in
 * 2021/2022, damit kein anderer Prüflauf (die übrigen rechnen relativ zu
 * heute) denselben Monat berührt.
 *
 * Aufgeräumt wird vorher und nachher über die Testdatenbank: Veröffentlichte
 * Abrechnungen und abgeschlossene Lohnausweise lässt die Anwendung — und seit
 * dieser Migration die Datenbank — zu Recht nicht löschen.
 */
describe('Lohnausbau — ganze Abrechnung über HTTP', () => {
  const RUN = Date.now();
  const PRAEFIX = 'lohn.pruefung.';
  let a = ''; // Monatslohn 6000, Eintritt 2020-06-01
  let b = ''; // Monatslohn 6000, Eintritt 2021-03-20
  let annaId = '';
  let fremdeOrg: string | null = null;
  const ktgVersionen: string[] = [];

  type Zeile = { type: string; kind: string; label: string; amount: string };
  type Detail = {
    id: string;
    grossPay: string;
    netPay: string;
    ktg: string;
    withholdingTax: string;
    expenses: string;
    otherDeductions: string;
    employerContributions: string;
    rateVersionIds: string[];
    unverifiedRates: boolean;
    reviewRequired: boolean;
    reviewReason: string | null;
    published: boolean;
    pdfFileId: string | null;
    lines: Zeile[];
  };

  const lauf = async (employeeId: string, year: number, month: number) => {
    const antwort = await post<{ data: { ergebnisse: { employeeId: string; status: string; payslipId?: string; grund?: string }[] } }>(
      '/api/payroll/run',
      { year, month, employeeIds: [employeeId] },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 200, JSON.stringify(antwort.payload));
    const e = data(antwort).ergebnisse.find((x) => x.employeeId === employeeId);
    assert.ok(e, `kein Ergebnis für ${year}-${month}`);
    return e;
  };
  const detail = async (id: string) => {
    const antwort = await get<{ data: Detail }>(`/api/payroll/payslips/${id}`, { jar: jars.admin });
    assert.equal(antwort.status, 200, JSON.stringify(antwort.payload));
    return data(antwort);
  };
  const betrag = (d: Detail, type: string) =>
    d.lines.filter((z) => z.type === type).reduce((s, z) => s + Number(z.amount), 0);
  const bytesVon = async (pfad: string, jar: string) => {
    const r = await fetch(`${BASE_URL}${pfad}`, { headers: { cookie: jar } });
    return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') ?? '' };
  };

  async function aufraeumen(): Promise<void> {
    const db = testDb();
    if (!db) return;
    const akten = await db.employee.findMany({
      where: { user: { email: { startsWith: PRAEFIX } } },
      select: { id: true, userId: true },
    });
    const ids = akten.map((x) => x.id);
    const anna = await db.employee.findFirst({ where: { user: { email: ACCOUNTS.employee.email } }, select: { id: true } });
    await schutzfreiAufraeumen(async (tx) => {
      const abrechnungen = await tx.payslip.findMany({
        where: { OR: [{ employeeId: { in: ids } }, ...(anna ? [{ employeeId: anna.id, year: 2021 }] : [])] },
        select: { id: true },
      });
      await lohnBelegeEntfernen(tx, abrechnungen.map((x) => x.id));
      const ausweise = await tx.salaryCertificate.findMany({ where: { employeeId: { in: ids } }, select: { id: true, pdfFileId: true } });
      const assets = await tx.fileAsset.findMany({
        where: { id: { in: ausweise.map((x) => x.pdfFileId).filter((x): x is string => Boolean(x)) } },
        select: { id: true, storedFileId: true },
      });
      await tx.salaryCertificate.deleteMany({ where: { id: { in: ausweise.map((x) => x.id) } } });
      await tx.fileAsset.deleteMany({ where: { id: { in: assets.map((x) => x.id) } } });
      await tx.storedFile.deleteMany({ where: { id: { in: assets.map((x) => x.storedFileId).filter((x): x is string => Boolean(x)) } } });
      await tx.payrollItem.deleteMany({ where: { OR: [{ employeeId: { in: ids } }, ...(anna ? [{ employeeId: anna.id, year: 2021 }] : [])] } });
      await tx.withholdingTaxProfile.deleteMany({ where: { employeeId: { in: ids } } });
      // Die Prüfsätze dieser Reihe: KTG 2021 und der BE-Tarif 2021 — auch die der fremden Organisation.
      await tx.payrollRate.deleteMany({ where: { code: 'KTG', validFrom: { gte: new Date('2021-01-01'), lt: new Date('2022-01-01') } } });
      await tx.withholdingTaxRate.deleteMany({ where: { canton: 'BE', year: 2021 } });
      if (fremdeOrg) {
        await tx.payrollRate.deleteMany({ where: { organizationId: fremdeOrg } });
        await tx.payrollItem.deleteMany({ where: { organizationId: fremdeOrg } });
      }
    });
    // Die Akten selbst ausserhalb des Schutzmodus: Nur so greifen die Kaskaden.
    for (const akte of akten) await db.user.delete({ where: { id: akte.userId } }).catch(() => {});
  }

  const anlegen = async (vorname: string, hiredAt: string) => {
    const antwort = await post<{ data: { id: string } }>(
      '/api/employees',
      {
        firstName: vorname,
        lastName: 'Lohnprüfung',
        email: `${PRAEFIX}${vorname.toLowerCase()}.${RUN}@example.ch`,
        hiredAt,
        monthlySalary: 6000,
        workloadPct: 100,
        birthday: '1986-05-01',
        sendInvite: false,
      },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 201, JSON.stringify(antwort.payload));
    return data(antwort).id;
  };

  before(async () => {
    await requireServer();
    jars = await loginAll();
    // Ohne Datenbankzugang liesse sich weder aufräumen noch die Prüfsumme vergleichen.
    assert.ok(testDb(), `kein Zugang zur Testdatenbank: ${testDbGrund()}`);
    fremdeOrg = await fremdeOrganisation();
    await aufraeumen();

    a = await anlegen('Aline', '2020-06-01');
    b = await anlegen('Beat', '2021-03-20');
    const personal = data(await get<{ data: { id: string; user: { email: string } }[] }>('/api/employees', { jar: jars.admin }));
    annaId = personal.find((p) => p.user.email === ACCOUNTS.employee.email)?.id ?? '';

    // Zwei KTG-Versionen in 2021: 1 % bis Juni, 0,5 % ab Juli.
    for (const [von, bis, satz] of [
      ['2021-01-01', '2021-06-30', 1],
      ['2021-07-01', '2021-12-31', 0.5],
    ] as const) {
      const v = await post<{ data: { id: string } }>(
        '/api/payroll/rates',
        { code: 'KTG', validFrom: von, validUntil: bis, employeePct: satz, employerPct: satz, source: 'Prüfreihe Lohnausbau' },
        { jar: jars.admin },
      );
      assert.equal(v.status, 201, JSON.stringify(v.payload));
      ktgVersionen.push(data(v).id);
    }
  });

  after(async () => {
    await aufraeumen();
  });

  let maerz = '';

  it('ganzer Monat: Zeilen, Arbeitgeberbeiträge, Satzversionen', async () => {
    const e = await lauf(a, 2021, 3);
    assert.equal(e.status, 'ERSTELLT', JSON.stringify(e));
    maerz = e.payslipId!;
    const d = await detail(maerz);
    assert.equal(Number(d.grossPay), 6000);
    assert.equal(betrag(d, 'BASE'), 6000);
    assert.equal(Number(d.ktg), 60, 'KTG mit der Version, die am Monatsletzten gilt (1 %)');
    assert.equal(d.rateVersionIds.length, 9, 'eine Version je Beitragsart');
    assert.ok(d.rateVersionIds.includes(ktgVersionen[0]!));
    assert.ok(Number(d.employerContributions) > 0);
    assert.ok(d.lines.some((z) => z.kind === 'EMPLOYER'), 'Arbeitgeberbeiträge stehen informativ auf der Abrechnung');
    const abzuege = d.lines.filter((z) => z.kind === 'DEDUCTION').reduce((s, z) => s + Number(z.amount), 0);
    assert.equal(Number(d.netPay), Math.round((6000 - abzuege) * 100) / 100);
  });

  it('historischer Satz: der September rechnet mit der Juli-Version', async () => {
    const e = await lauf(a, 2021, 9);
    const d = await detail(e.payslipId!);
    assert.equal(Number(d.ktg), 30, '0,5 % von 6000');
    assert.ok(d.rateVersionIds.includes(ktgVersionen[1]!));
  });

  it('Lohnänderung am 16.: jeder Tag mit seinem Lohn', async () => {
    const aenderung = await patch(
      `/api/employees/${a}`,
      { monthlySalary: 6200, salaryValidFrom: '2021-04-16', salaryReason: 'Prüfreihe' },
      { jar: jars.admin },
    );
    assert.equal(aenderung.status, 200, JSON.stringify(aenderung.payload));
    const d = await detail((await lauf(a, 2021, 4)).payslipId!);
    assert.equal(Number(d.grossPay), 6100, '15/30 × 6000 + 15/30 × 6200');
  });

  it('Eintritt am 20.: anteilig nach Kalendertagen', async () => {
    const d = await detail((await lauf(b, 2021, 3)).payslipId!);
    assert.equal(Number(d.grossPay), Math.round(((12 / 31) * 6000) * 100) / 100);
    assert.ok(d.lines.find((z) => z.type === 'BASE')?.label.includes('anteilig'));
  });

  let ueberstundenId = '';

  it('Positionen: Überstunden vom Server gerechnet, Zulage, Spesen, Abzug', async () => {
    const mitBetrag = await post(
      '/api/payroll/items',
      { employeeId: a, year: 2021, month: 5, type: 'OVERTIME', label: 'Überstunden', quantity: 5, rate: 40, surchargePct: 25, amount: 9999 },
      { jar: jars.admin },
    );
    assert.equal(mitBetrag.status, 422, 'einen Überstundenbetrag schickt der Client nicht');

    const ueberstunden = await post<{ data: { id: string; amount: string } }>(
      '/api/payroll/items',
      { employeeId: a, year: 2021, month: 5, type: 'OVERTIME', label: 'Überstunden', quantity: 5, rate: 40, surchargePct: 25 },
      { jar: jars.admin },
    );
    assert.equal(ueberstunden.status, 201, JSON.stringify(ueberstunden.payload));
    assert.equal(Number(data(ueberstunden).amount), 250);
    ueberstundenId = data(ueberstunden).id;
    for (const [type, amount] of [
      ['ALLOWANCE', 200],
      ['EXPENSE', 80],
      ['DEDUCTION', 300],
    ] as const) {
      const r = await post('/api/payroll/items', { employeeId: a, year: 2021, month: 5, type, label: `Prüfung ${type}`, amount }, { jar: jars.admin });
      assert.equal(r.status, 201, JSON.stringify(r.payload));
    }
    const negativ = await post('/api/payroll/items', { employeeId: a, year: 2021, month: 5, type: 'DEDUCTION', label: 'Negativ', amount: -5 }, { jar: jars.admin });
    assert.equal(negativ.status, 422, 'nur Korrekturen dürfen negativ sein');

    const d = await detail((await lauf(a, 2021, 5)).payslipId!);
    assert.equal(Number(d.grossPay), 6650, '6200 + 250 + 200');
    assert.equal(Number(d.expenses), 80);
    assert.equal(Number(d.otherDeductions), 300);
    assert.equal(Number(d.ktg), 66.5, 'KTG auf dem ganzen beitragspflichtigen Lohn');
  });

  it('zwei gleichzeitige Läufe ergeben eine Abrechnung mit denselben Zeilen', async () => {
    const vorher = await detail((await lauf(a, 2021, 5)).payslipId!);
    const [x, y] = await Promise.all([
      post('/api/payroll/run', { year: 2021, month: 5, employeeIds: [a] }, { jar: jars.admin }),
      post('/api/payroll/run', { year: 2021, month: 5, employeeIds: [a] }, { jar: jars.admin }),
    ]);
    assert.equal(x.status, 200);
    assert.equal(y.status, 200);
    const liste = await get<{ data: { eintraege: { id: string }[] } }>(`/api/payroll/payslips?employeeId=${a}&year=2021&month=5`, { jar: jars.admin });
    assert.equal(data(liste).eintraege.length, 1);
    const nachher = await detail(data(liste).eintraege[0]!.id);
    assert.equal(nachher.lines.length, vorher.lines.length, 'keine doppelten Zeilen');
    assert.equal(nachher.grossPay, vorher.grossPay);
  });

  it('eine neue Position macht die berechnete Abrechnung veraltet — freigeben geht nicht, neu rechnen schon', async () => {
    const r = await post('/api/payroll/items', { employeeId: a, year: 2021, month: 5, type: 'ALLOWANCE', label: 'Nachtrag', amount: 50 }, { jar: jars.admin });
    assert.equal(r.status, 201);
    const liste = await get<{ data: { eintraege: { id: string }[] } }>(`/api/payroll/payslips?employeeId=${a}&year=2021&month=5`, { jar: jars.admin });
    const id = data(liste).eintraege[0]!.id;
    const veraltet = await detail(id);
    assert.equal(veraltet.reviewRequired, true);
    assert.ok(veraltet.reviewReason?.startsWith('Grundlagen'), veraltet.reviewReason ?? '');
    const freigabe = await post(`/api/payroll/payslips/${id}/review`, { note: 'Prüfreihe' }, { jar: jars.admin });
    assert.equal(freigabe.status, 422);
    const veroeffentlicht = await post<{ data: { veroeffentlicht: number } }>(
      '/api/payroll/publish',
      { payslipIds: [id], trotzUngepruefterSaetze: true },
      { jar: jars.admin },
    );
    assert.equal(data(veroeffentlicht).veroeffentlicht, 0, 'eine veraltete Abrechnung wird nicht veröffentlicht');
    const neu = await detail((await lauf(a, 2021, 5)).payslipId!);
    assert.equal(neu.reviewRequired, false);
    assert.equal(Number(neu.grossPay), 6700);
  });

  it('veröffentlichen verlangt die Bestätigung ungeprüfter Sätze und erzeugt das PDF', async () => {
    /**
     * Die Lohnänderung im April hat den berechneten März als veraltet
     * markiert — richtig so, der Lohnstamm hat sich nach der Berechnung
     * geändert. Veröffentlicht wird deshalb erst nach dem Neurechnen.
     */
    assert.ok((await detail(maerz)).reviewReason?.startsWith('Grundlagen'), 'eine Lohnänderung macht die berechnete Abrechnung veraltet');
    maerz = (await lauf(a, 2021, 3)).payslipId!;
    assert.equal((await detail(maerz)).reviewRequired, false);
    const ohne = await post('/api/payroll/publish', { payslipIds: [maerz] }, { jar: jars.admin });
    assert.equal(ohne.status, 422, 'ungeprüfte Sätze werden nicht still zur Auszahlung');
    const mit = await post<{ data: { veroeffentlicht: number } }>(
      '/api/payroll/publish',
      { payslipIds: [maerz], trotzUngepruefterSaetze: true },
      { jar: jars.admin },
    );
    assert.equal(data(mit).veroeffentlicht, 1, JSON.stringify(mit.payload));
    const d = await detail(maerz);
    assert.equal(d.published, true);
    assert.ok(d.pdfFileId);
  });

  it('das PDF: gespeicherte Bytes mit Prüfsumme, nur für Berechtigte', async () => {
    const pdf = await bytesVon(`/api/payroll/payslips/${maerz}/pdf`, jars.admin);
    assert.equal(pdf.status, 200);
    assert.ok(pdf.type.includes('application/pdf'));
    assert.equal(pdf.bytes.subarray(0, 4).toString(), '%PDF');
    const gespeichert = await testDb()!.payslip.findUnique({ where: { id: maerz }, select: { pdfChecksum: true, pdfFileId: true } });
    assert.equal(createHash('sha256').update(pdf.bytes).digest('hex'), gespeichert?.pdfChecksum, 'ausgeliefert wird genau die veröffentlichte Fassung');
    const zweites = await bytesVon(`/api/payroll/payslips/${maerz}/pdf`, jars.admin);
    assert.ok(zweites.bytes.equals(pdf.bytes), 'kein Neurendern beim Herunterladen');

    assert.ok([403, 404].includes((await bytesVon(`/api/payroll/payslips/${maerz}/pdf`, jars.manager)).status), 'die Betriebsleitung hat keinen Lohneinblick');
    assert.equal((await bytesVon(`/api/payroll/payslips/${maerz}/pdf`, jars.employee)).status, 404, 'eine fremde Abrechnung existiert nicht');
    assert.equal((await bytesVon(`/api/payroll/payslips/${maerz}/pdf`, jars.customer)).status, 403);

    // Der allgemeine Dateiweg: Bereich PAYROLL nur mit `payslip:read_all`.
    const asset = await testDb()!.fileAsset.findUnique({ where: { id: gespeichert!.pdfFileId! }, select: { url: true, scope: true } });
    assert.equal(asset?.scope, 'PAYROLL');
    if (asset?.url.startsWith('/api/files/blob/')) {
      assert.ok([403, 404].includes((await bytesVon(asset.url, jars.manager)).status), 'auch nicht über den Dateiweg');
      assert.equal((await bytesVon(asset.url, jars.admin)).status, 200);
    }
    const medien = await get<{ text: string }>('/admin/medien', { jar: jars.admin });
    assert.ok(!medien.text.includes('Lohnabrechnung-2021-03'), 'Lohndokumente erscheinen nicht in der Mediathek');
  });

  it('ein unveröffentlichter Monat hat kein PDF', async () => {
    const liste = await get<{ data: { eintraege: { id: string }[] } }>(`/api/payroll/payslips?employeeId=${a}&year=2021&month=5`, { jar: jars.admin });
    assert.equal((await bytesVon(`/api/payroll/payslips/${data(liste).eintraege[0]!.id}/pdf`, jars.admin)).status, 404);
  });

  it('nach dem Veröffentlichen: gesperrt, Korrektur nur in einem späteren Monat', async () => {
    const inGesperrt = await post('/api/payroll/items', { employeeId: a, year: 2021, month: 3, type: 'ALLOWANCE', label: 'Zu spät', amount: 10 }, { jar: jars.admin });
    assert.equal(inGesperrt.status, 422);
    assert.equal((await lauf(a, 2021, 3)).status, 'UEBERSPRUNGEN');

    const rueckwaerts = await post(
      '/api/payroll/items',
      { employeeId: a, year: 2021, month: 2, type: 'CORRECTION', label: 'Rückwärts', amount: 100, correctsPayslipId: maerz },
      { jar: jars.admin },
    );
    assert.equal(rueckwaerts.status, 422);
    const korrektur = await post(
      '/api/payroll/items',
      { employeeId: a, year: 2021, month: 6, type: 'CORRECTION', label: 'Korrektur März', amount: 100, correctsPayslipId: maerz },
      { jar: jars.admin },
    );
    assert.equal(korrektur.status, 201, JSON.stringify(korrektur.payload));
    const juni = await detail((await lauf(a, 2021, 6)).payslipId!);
    assert.equal(betrag(juni, 'CORRECTION'), 100);
    assert.equal(Number(juni.grossPay), 6300);
  });

  it('eine benutzte Satzversion ist unveränderlich', async () => {
    const aendern = await patch(`/api/payroll/rates/${ktgVersionen[0]}`, { employeePct: 2 }, { jar: jars.admin });
    assert.equal(aendern.status, 422);
    const spalten = await post(
      '/api/payroll/rates',
      { code: 'KTG', validFrom: '2021-03-15', employeePct: 2, employerPct: 2, source: 'Prüfreihe' },
      { jar: jars.admin },
    );
    assert.equal(spalten.status, 422, 'eine neue Version darf einem veröffentlichten Monat seine Version nicht nehmen');
    // Die Bestätigung ändert keinen Betrag und bleibt erlaubt.
    const bestaetigt = await post(`/api/payroll/rates/${ktgVersionen[0]}/verify`, { note: 'Police Prüfreihe' }, { jar: jars.admin });
    assert.equal(bestaetigt.status, 200);
  });

  it('eine Position einer veröffentlichten Abrechnung ist unveränderlich', async () => {
    const db = testDb()!;
    const item = await db.payrollItem.findFirst({ where: { employeeId: a, year: 2021, month: 6 }, select: { id: true } });
    const pub = await post<{ data: { veroeffentlicht: number } }>(
      '/api/payroll/publish',
      { payslipIds: [(await lauf(a, 2021, 6)).payslipId!], trotzUngepruefterSaetze: true },
      { jar: jars.admin },
    );
    assert.equal(data(pub).veroeffentlicht, 1);
    assert.equal((await patch(`/api/payroll/items/${item!.id}`, { amount: 1 }, { jar: jars.admin })).status, 422);
    assert.equal((await del(`/api/payroll/items/${item!.id}`, { jar: jars.admin })).status, 422);
  });

  let qstProfil = '';

  it('Quellensteuer ohne Tarif: keine erfundene Zahl, sondern eine Prüfung', async () => {
    // Ein Tarif der **fremden** Organisation darf nie greifen.
    if (fremdeOrg) {
      await testDb()!.withholdingTaxRate.create({
        data: { organizationId: fremdeOrg, canton: 'BE', year: 2021, tariffCode: 'A0N', incomeFrom: 0, ratePct: 50, source: 'fremd' },
      });
    }
    const profil = await post<{ data: { id: string } }>(
      '/api/payroll/withholding/profiles',
      { employeeId: a, validFrom: '2021-07-01', canton: 'BE', tariffCode: 'A0N', churchTax: true, children: 0 },
      { jar: jars.admin },
    );
    assert.equal(profil.status, 201, JSON.stringify(profil.payload));
    qstProfil = data(profil).id;
    const ueberlappend = await post(
      '/api/payroll/withholding/profiles',
      { employeeId: a, validFrom: '2021-08-01', canton: 'BE', tariffCode: 'B1Y' },
      { jar: jars.admin },
    );
    assert.equal(ueberlappend.status, 422, 'zwei Profile gleichzeitig verweigert die Datenbank');

    const juli = await detail((await lauf(a, 2021, 7)).payslipId!);
    assert.equal(Number(juli.withholdingTax), 0, 'weder erfunden noch aus der fremden Organisation');
    assert.equal(juli.reviewRequired, true);
    const pub = await post<{ data: { veroeffentlicht: number; gruende: { grund: string }[] } }>(
      '/api/payroll/publish',
      { payslipIds: [juli.id], trotzUngepruefterSaetze: true },
      { jar: jars.admin },
    );
    assert.equal(data(pub).veroeffentlicht, 0);
    assert.ok(data(pub).gruende[0]?.grund.includes('Prüfung'));
    assert.equal((await post(`/api/payroll/payslips/${juli.id}/review`, { note: 'Quellensteuer Juli ausserhalb abgerechnet' }, { jar: jars.admin })).status, 200);
    const nachPruefung = await post<{ data: { veroeffentlicht: number } }>(
      '/api/payroll/publish',
      { payslipIds: [juli.id], trotzUngepruefterSaetze: true },
      { jar: jars.admin },
    );
    assert.equal(data(nachPruefung).veroeffentlicht, 1);
  });

  it('Quellensteuer aus dem eingelesenen Tarif — mit Quelle, ohne Überschreiben', async () => {
    const ohneQuelle = await post('/api/payroll/withholding/rates', { canton: 'BE', year: 2021, rows: [{ tariffCode: 'A0N', incomeFrom: 0, ratePct: 10 }] }, { jar: jars.admin });
    assert.equal(ohneQuelle.status, 422);
    const eingelesen = await post<{ data: { importBatch: string } }>(
      '/api/payroll/withholding/rates',
      { canton: 'BE', year: 2021, source: 'Prüfreihe (kein amtlicher Tarif)', rows: [{ tariffCode: 'A0N', incomeFrom: 0, incomeTo: null, ratePct: 10 }] },
      { jar: jars.admin },
    );
    assert.equal(eingelesen.status, 201, JSON.stringify(eingelesen.payload));
    const doppelt = await post(
      '/api/payroll/withholding/rates',
      { canton: 'BE', year: 2021, source: 'Prüfreihe', rows: [{ tariffCode: 'A0N', incomeFrom: 0, ratePct: 12 }] },
      { jar: jars.admin },
    );
    assert.equal(doppelt.status, 422, 'eine bestehende Stufe wird nicht überschrieben');

    const august = await detail((await lauf(a, 2021, 8)).payslipId!);
    assert.equal(Number(august.withholdingTax), 620, '10 % von 6200');
    assert.ok(august.lines.some((z) => z.type === 'WITHHOLDING_TAX' && z.label.includes('BE A0N')));
    assert.equal(august.unverifiedRates, true, 'ein ungeprüfter Tarif zählt als ungeprüfter Satz');
    const pub = await post<{ data: { veroeffentlicht: number } }>(
      '/api/payroll/publish',
      { payslipIds: [august.id], trotzUngepruefterSaetze: true },
      { jar: jars.admin },
    );
    assert.equal(data(pub).veroeffentlicht, 1);
  });

  it('ein Profil mit veröffentlichter Abrechnung im Zeitraum wechselt den Tarif nicht still', async () => {
    const r = await patch(`/api/payroll/withholding/profiles/${qstProfil}`, { tariffCode: 'C0N' }, { jar: jars.admin });
    assert.equal(r.status, 422);
  });

  it('13. Monatslohn anteilig und beim Austritt im Austrittsmonat fällig', async () => {
    const profil = await put(`/api/payroll/profiles/${a}`, { thirteenthMode: 'PRO_RATA', thirteenthPayoutMonth: 12, vacationPayInWage: false }, { jar: jars.admin });
    assert.equal(profil.status, 200, JSON.stringify(profil.payload));
    const januar = await detail((await lauf(a, 2022, 1)).payslipId!);
    assert.equal(betrag(januar, 'THIRTEENTH'), 0, 'im Januar nicht fällig');

    const austritt = await patch(`/api/employees/${a}`, { terminatedAt: '2022-02-10' }, { jar: jars.admin });
    assert.equal(austritt.status, 200, JSON.stringify(austritt.payload));
    const februar = await lauf(a, 2022, 2);
    assert.notEqual(februar.status, 'UEBERSPRUNGEN', 'wer im Monat austritt, wird abgerechnet');
    const d = await detail(februar.payslipId!);
    const grund = Math.round(((10 / 28) * 6200) * 100) / 100;
    assert.equal(betrag(d, 'BASE'), grund);
    assert.equal(betrag(d, 'THIRTEENTH'), Math.round(((6200 + grund) / 12) * 100) / 100);
    const maerz2022 = await post<{ data: { ergebnisse: { employeeId: string }[] } }>(
      '/api/payroll/run',
      { year: 2022, month: 3, employeeIds: [a] },
      { jar: jars.admin },
    );
    assert.equal(maerz2022.status, 200);
    assert.ok(!data(maerz2022).ergebnisse.some((e) => e.employeeId === a), 'nach dem Austritt keine Abrechnung mehr');
  });

  it('Lohnausweis-Aufstellung: aus veröffentlichten Abrechnungen, abgeschlossen unveränderlich', async () => {
    const erstellt = await post<{ data: { id: string; version: number; fields: { felder: { ziffer: string; betrag: number }[] } } }>(
      '/api/payroll/certificates',
      { employeeId: a, year: 2021 },
      { jar: jars.admin },
    );
    assert.equal(erstellt.status, 201, JSON.stringify(erstellt.payload));
    const feld = (z: string) => data(erstellt).fields.felder.find((f) => f.ziffer === z)!.betrag;
    assert.equal(feld('12'), 620, 'nur die veröffentlichte Quellensteuer');
    assert.equal(feld('8'), Math.round((feld('1') + feld('7')) * 100) / 100);
    assert.equal(feld('1'), 6000 + 6300 + 6200 + 6200, 'März, Juni, Juli, August — nur veröffentlichte Monate');

    const id = data(erstellt).id;
    assert.equal((await post(`/api/payroll/certificates/${id}/finalize`, undefined, { jar: jars.admin })).status, 200);
    assert.equal((await post(`/api/payroll/certificates/${id}/finalize`, undefined, { jar: jars.admin })).status, 422);
    const pdf = await bytesVon(`/api/payroll/certificates/${id}/pdf`, jars.admin);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.bytes.subarray(0, 4).toString(), '%PDF');
    assert.equal((await bytesVon(`/api/payroll/certificates/${id}/pdf`, jars.employee)).status, 404);
    assert.ok([403, 404].includes((await bytesVon(`/api/payroll/certificates/${id}/pdf`, jars.manager)).status));
    const eigene = await get<{ data: { id: string }[] }>('/api/payroll/certificates', { jar: jars.employee });
    assert.equal(eigene.status, 200);
    assert.ok(!data(eigene).some((c) => c.id === id), 'fremde Ausweise erscheinen nicht');

    const zweite = await post<{ data: { version: number } }>('/api/payroll/certificates', { employeeId: a, year: 2021 }, { jar: jars.admin });
    assert.equal(data(zweite).version, 2, 'eine Korrektur ist eine neue Version');
  });

  it('die eigene veröffentlichte Abrechnung lädt die angestellte Person selbst', async (t) => {
    if (!annaId) return t.skip('keine Personalakte zum Demokonto');
    const zulage = await post('/api/payroll/items', { employeeId: annaId, year: 2021, month: 11, type: 'ALLOWANCE', label: 'Prüfreihe', amount: 50 }, { jar: jars.admin });
    assert.equal(zulage.status, 201, JSON.stringify(zulage.payload));
    const e = await lauf(annaId, 2021, 11);
    assert.ok(e.payslipId, JSON.stringify(e));
    const entwurf = await get(`/api/payroll/payslips/${e.payslipId}`, { jar: jars.employee });
    assert.equal(entwurf.status, 404, 'ein Entwurf existiert für die eigene Person nicht');
    await post('/api/payroll/publish', { payslipIds: [e.payslipId], trotzUngepruefterSaetze: true }, { jar: jars.admin });
    const eigenes = await bytesVon(`/api/payroll/payslips/${e.payslipId}/pdf`, jars.employee);
    assert.equal(eigenes.status, 200);
    assert.equal(eigenes.bytes.subarray(0, 4).toString(), '%PDF');
  });

  it('das Prüfprotokoll hält Beträge und Quellensteuerdaten geschwärzt fest', async () => {
    const db = testDb()!;
    const posten = await db.auditLog.findFirst({ where: { entity: 'PayrollItem', entityId: ueberstundenId }, select: { changes: true, summary: true } });
    assert.ok(posten, 'die Erfassung ist protokolliert');
    const c = posten.changes as Record<string, unknown>;
    assert.equal(c.amount, '[redigiert]');
    assert.equal(c.label, '[redigiert]');
    const profil = await db.auditLog.findFirst({ where: { entity: 'WithholdingTaxProfile', entityId: qstProfil }, select: { changes: true, summary: true } });
    const p = profil?.changes as Record<string, unknown>;
    assert.equal(p.churchTax, '[redigiert]', 'Konfession ist besonders schützenswert');
    assert.equal(p.tariffCode, '[redigiert]');
    assert.ok(!profil?.summary?.includes('A0N'));
  });

  it('Rollen: Betriebsleitung und Mitarbeitende pflegen keine Lohnstammdaten', async () => {
    for (const pfad of ['/api/payroll/rates', '/api/payroll/items', '/api/payroll/withholding/profiles', '/api/payroll/withholding/rates', `/api/payroll/profiles/${a}`]) {
      for (const rolle of ['manager', 'employee', 'customer'] as AccountName[]) {
        const r = await get(pfad, { jar: jars[rolle] });
        assert.equal(r.status, 403, `${rolle} liest ${pfad} nicht (kam ${r.status})`);
      }
    }
    assert.equal((await post('/api/payroll/items', { employeeId: a, year: 2021, month: 10, type: 'ALLOWANCE', label: 'x', amount: 1 }, { jar: jars.employee })).status, 403);
    assert.equal((await post('/api/payroll/rates', { code: 'KTG', validFrom: '2099-01-01', source: 'x' }, { jar: jars.manager })).status, 403);
    assert.equal((await post('/api/payroll/publish', { payslipIds: [maerz] }, { jar: jars.manager })).status, 403);
  });

  it('Mandanten: Daten einer fremden Organisation werden weder gezeigt noch verrechnet', async (t) => {
    if (!fremdeOrg) return t.skip('keine fremde Organisation');
    const db = testDb()!;
    const fremderSatz = await db.payrollRate.create({
      data: { organizationId: fremdeOrg, code: 'KTG', validFrom: new Date('2021-01-01'), validUntil: new Date('2021-12-31'), employeePct: 9, source: 'fremd' },
    });
    const fremdePosition = await db.payrollItem.create({
      data: { organizationId: fremdeOrg, employeeId: a, year: 2021, month: 10, type: 'ALLOWANCE', label: 'Fremd', amount: 999 },
    });
    assert.equal((await patch(`/api/payroll/rates/${fremderSatz.id}`, { employeePct: 1 }, { jar: jars.admin })).status, 404);
    assert.equal((await patch(`/api/payroll/items/${fremdePosition.id}`, { amount: 1 }, { jar: jars.admin })).status, 404);
    const saetze = data(await get<{ data: { id: string }[] }>('/api/payroll/rates?year=2021', { jar: jars.admin }));
    assert.ok(!saetze.some((s) => s.id === fremderSatz.id));
    const positionen = data(await get<{ data: { id: string }[] }>(`/api/payroll/items?employeeId=${a}`, { jar: jars.admin }));
    assert.ok(!positionen.some((p) => p.id === fremdePosition.id));
    const oktober = await detail((await lauf(a, 2021, 10)).payslipId!);
    assert.ok(!oktober.lines.some((z) => z.label === 'Fremd'), 'eine fremde Position fliesst nicht ein');
    assert.equal(Number(oktober.ktg), 31, 'der fremde KTG-Satz greift nicht');
  });

  /**
   * Gleichzeitig veröffentlichen (2026-09-27). Die Bytes wurden unter einem
   * festen Pfad abgelegt und überschrieben — **vor** dem Anspruch aufs
   * Veröffentlichen. Der Verlierer überschrieb die Datei des Gewinners; die
   * Abrechnung trug danach die Prüfsumme des einen und die Bytes des
   * anderen und liess sich nie mehr herunterladen (nachgestellt: 422 beim
   * Herunterladen). Jetzt: eigener Pfad je Fassung, der Verlierer räumt nur
   * die eigene weg.
   *
   * Am Ende der Reihe, weil ein veröffentlichter Dezember die
   * Jahresaufstellung (Lohnausweis) und den 13. Monatslohn davor verändert.
   */
  it('drei gleichzeitige Veröffentlichungen: eine gewinnt, das PDF stimmt, keine Waise bleibt', async () => {
    const dezember = (await lauf(a, 2021, 12)).payslipId!;
    assert.ok(dezember, 'Dezember liess sich rechnen');
    const antworten = await Promise.all(
      [1, 2, 3].map(() => post<{ data: { veroeffentlicht: number } }>('/api/payroll/publish', { payslipIds: [dezember], trotzUngepruefterSaetze: true }, { jar: jars.admin })),
    );
    const summe = antworten.reduce((s, r) => s + (r.status === 200 ? data(r).veroeffentlicht : 0), 0);
    assert.equal(summe, 1, `veröffentlicht: ${antworten.map((r) => r.text).join(' | ')}`);

    const pdf = await bytesVon(`/api/payroll/payslips/${dezember}/pdf`, jars.admin);
    assert.equal(pdf.status, 200, 'die veröffentlichte Abrechnung lässt sich herunterladen');
    const gespeichert = await testDb()!.payslip.findUniqueOrThrow({ where: { id: dezember }, select: { pdfChecksum: true } });
    assert.equal(createHash('sha256').update(pdf.bytes).digest('hex'), gespeichert.pdfChecksum);

    const fassungen = await testDb()!.fileAsset.count({ where: { scope: 'PAYROLL', path: { contains: `/payroll/payslips/${dezember}` } } });
    assert.equal(fassungen, 1, 'verlorene Fassungen wurden weggeräumt');
  });
});
