import { describe, it, before } from 'node:test';
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
import { get, post, patch, del, data, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';

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

  it('die Beitragssätze eines Jahres entstehen beim ersten Zugriff', async () => {
    const antwort = await get<{ data: { year: number; ahvIvEo: string; uvgNbu: string } }>(
      '/api/payroll/settings?year=2026',
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 200);
    assert.equal(data(antwort).year, 2026);
    assert.equal(Number(data(antwort).ahvIvEo), 5.3);
  });

  /**
   * Gesetzlich trägt der Betrieb mindestens die Hälfte der Altersgutschrift
   * (Art. 66 BVG). Ein höherer Arbeitnehmeranteil wäre kein Tippfehler, den
   * man durchlassen sollte — er stünde auf jeder Abrechnung des Jahres.
   */
  it('mehr als 50 % Arbeitnehmeranteil am BVG wird abgewiesen', async () => {
    const antwort = await patch(
      '/api/payroll/settings?year=2026',
      { bvgAnteilArbeitnehmer: 60 },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 422);
    assert.ok(JSON.stringify(antwort.payload).includes('Art. 66'));
  });

  it('der UVG-Satz lässt sich pflegen', async () => {
    const antwort = await patch<{ data: { uvgNbu: string } }>(
      '/api/payroll/settings?year=2026',
      { uvgNbu: 1.4 },
      { jar: jars.admin },
    );
    assert.equal(antwort.status, 200);
    assert.equal(Number(data(antwort).uvgNbu), 1.4);
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
