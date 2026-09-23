import type { Page } from '@playwright/test';

import { data, del, patch, post } from '../helpers/client';
import { letzteMail, linksIn } from '../helpers/mail';
import { testDb } from '../helpers/testdb';

import { expect, test } from './helpers/basis';
import { imBrowserAnmelden, unterschriftZeichnen } from './helpers/browser';
import {
  frischAnmelden,
  offerteAnlegen,
  pfadVon,
  stammdatenLesen,
  versendenUndLinkLesen,
  vertragAufraeumen,
  vertragsentwurfAnlegen,
  type Stammdaten,
} from './helpers/bestand';

/**
 * Verträge im echten Browser — sechs Wege von der Offerte bis zur Rechnung.
 *
 * ---------------------------------------------------------------------------
 *  Was hier geprüft wird und was ausdrücklich nicht
 * ---------------------------------------------------------------------------
 *
 * Die Fachregeln stehen in `tests/api/vertraege.test.ts`,
 * `tests/api/vertraege-integritaet.test.ts` und im reinen Rechenkern: welche
 * Kalendertage eine Regel trifft, dass zwei gleichzeitige Abrechnungen eine
 * Rechnung ergeben, dass die Datenbank eine angenommene Fassung verweigert.
 * Nichts davon wird hier in der Breite wiederholt — über HTTP ist es schneller
 * und schärfer zu prüfen.
 *
 * Was hier hinzukommt, ist die Frage, die eine HTTP-Reihe **nicht** beantwortet
 * und die in diesem Projekt schon mehrmals falsch beantwortet war:
 *
 *   **Gibt es die Maske wirklich, schreibt sie in dieselbe Datenbank, und
 *   erscheint das Ergebnis danach auf der Seite?**
 *
 * Deshalb läuft jede Handlung, über die eine Aussage getroffen wird, über die
 * Oberfläche. Nur die Vorbereitung — Vertragsentwurf, ein Einsatzplan für die
 * Fälle, in denen er nicht Gegenstand ist — kommt über die Schnittstelle.
 *
 * Geprüft wird jeweils gegen die **Datenbank**, nicht gegen eine Meldung im
 * Bild: Ein grüner Hinweis ist kein Beweis, dass etwas gespeichert wurde.
 *
 * ---------------------------------------------------------------------------
 *  Die sechs Wege (Stabilisierung vom 2026-09-23, Phase M)
 * ---------------------------------------------------------------------------
 *
 *  A  Offerte angenommen → Vertrag aus der Offerte → Plan → in Kraft → Einsätze
 *  B  Änderungsantrag → Freigabe → Fassung 2 → in Kraft zum Stichtag
 *  C  V1 → V2 → V3: keine doppelten Einsätze, jede Periode bei ihrer Fassung
 *  D  Abrechnung einer vergangenen Periode nach der **damals** geltenden Fassung
 *  E  Unterzeichnung: angenommen, eingefroren, nicht mehr stornierbar
 *  F  Pause und Wiederaufnahme: abgesagt in der Pause, nichts in der Vergangenheit
 */

const db = testDb();

let adminJar = '';
let managerJar = '';
let stamm: Stammdaten;

/** Was dieser Lauf angelegt hat. */
const angelegteVertraege: string[] = [];
const angelegteOfferten: string[] = [];

test.beforeAll(async () => {
  adminJar = await frischAnmelden('admin');
  managerJar = await frischAnmelden('manager');
  stamm = await stammdatenLesen(adminJar);
});

test.afterAll(async () => {
  for (const id of angelegteVertraege) await vertragAufraeumen(id, adminJar);
  for (const id of angelegteOfferten) await del(`/api/quotes/${id}`, { jar: adminJar }).catch(() => undefined);
});

// ---------------------------------------------------------------------------
//  Helfer
// ---------------------------------------------------------------------------

const TAG_MS = 86_400_000;

/**
 * Der Kalendertag in Zürich als `JJJJ-MM-TT`.
 *
 * Nicht `toISOString().slice(0, 10)`: Das ist der Tag in UTC, und zwischen
 * Mitternacht und zwei Uhr Schweizer Zeit ist das der Vortag. Ein Fall, der
 * „morgen" meint und kurz nach Mitternacht „heute" schickt, prüft eine
 * andere Regel — genau die Grenze, an der RB-007 und RB-009 hingen.
 */
function zuercherTag(versatzTage = 0): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Zurich' }).format(
    new Date(Date.now() + versatzTage * TAG_MS),
  );
}

/** Beginn eines Zürcher Kalendertags als Zeitpunkt. */
function zuercherMitternacht(tag: string): Date {
  // Mittag UTC liegt sicher im gleichen Zürcher Tag; von dort auf 00:00 zurück.
  const mittag = new Date(`${tag}T12:00:00Z`);
  const stunde = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', hour: '2-digit', hourCycle: 'h23' }).format(mittag),
  );
  return new Date(mittag.getTime() - stunde * 3_600_000);
}

async function neuerEntwurf(ueber: { startDate?: string; baseAmount?: number } = {}) {
  const vertrag = await vertragsentwurfAnlegen(stamm, adminJar, { startDate: zuercherTag(1), ...ueber });
  angelegteVertraege.push(vertrag.id);
  return vertrag;
}

/**
 * Ein täglicher Einsatzplan über die Schnittstelle — für die Fälle, in denen
 * nicht der Plan Gegenstand ist. Der Dialog selbst ist in Fall A geprüft.
 */
async function taeglicherPlan(serviceId: string, ab: string): Promise<void> {
  const antwort = await post(
    `/api/contract-services/${serviceId}/schedules`,
    {
      frequency: 'WEEKLY',
      interval: 1,
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      startMinute: 360,
      endMinute: 480,
      effectiveFrom: ab,
      holidayHandling: 'IGNORE',
      active: true,
    },
    { jar: adminJar },
  );
  expect(antwort.status, antwort.text).toBe(201);
}

/**
 * Anmelden über die Maske — die Browserreihe teilt keine Sitzung mit der
 * HTTP-Reihe. Über den gemeinsamen Helfer, nicht von Hand: Ein früherer
 * Entwurf tippte die Zugangsdaten aus und nahm für die Administration das
 * falsche Passwort; alle Fälle scheiterten mit einer Meldung, die nach einem
 * Fehler der Anwendung aussah.
 */
async function alsAdminAnmelden(page: Page): Promise<void> {
  await imBrowserAnmelden(page, 'admin', /\/admin/);
}

/**
 * Eine Handlung mit Rückfrage auslösen: Schaltfläche, dann dieselbe
 * Beschriftung im Dialog.
 *
 * `ActionButton` beschriftet die bestätigende Schaltfläche mit **derselben**
 * Beschriftung wie den Auslöser. Das ist gute Praxis (die Bestätigung nennt
 * die Handlung, nicht ein nichtssagendes „OK"), macht aber eine Auswahl über
 * den Namen allein mehrdeutig. Deshalb wird die zweite im Dialog gesucht.
 */
async function handlungBestaetigen(page: Page, beschriftung: string, notiz?: string): Promise<void> {
  await page.getByRole('button', { name: beschriftung, exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  if (notiz !== undefined) await dialog.getByRole('textbox').fill(notiz);
  await dialog.getByRole('button', { name: beschriftung, exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 25_000 });
}

const genau = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Ein Formularfeld über seine Beschriftung — genau, aber mit dem Sternchen
 * der Pflichtfelder. Das Sternchen ist `aria-hidden`, Playwrights
 * Beschriftungsvergleich liest den Text des `<label>` aber trotzdem mit;
 * `exact: true` fand „Grund" deshalb nie, weil dort „Grund*" steht.
 */
function feld(scope: Page | ReturnType<Page['getByRole']>, beschriftung: string) {
  return scope.getByLabel(new RegExp(`^${genau(beschriftung)}\\s*\\*?$`));
}

/**
 * Eine Radix-Auswahl über ihre Beschriftung bedienen. Ein Text wird **genau**
 * verglichen — ein Teilvergleich träfe bei „Büro" auch „Büro Nord".
 */
async function auswaehlen(page: Page, beschriftung: string, option: RegExp | string): Promise<void> {
  await feld(page, beschriftung).click();
  const name = typeof option === 'string' ? new RegExp(`^${genau(option)}$`) : option;
  await page.getByRole('option', { name }).click();
}

async function vertragsstatus(id: string) {
  return (await db!.contract.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
}

async function inKraftSetzen(page: Page, id: string): Promise<void> {
  await handlungBestaetigen(page, 'In Kraft setzen');
  await expect.poll(() => vertragsstatus(id), { timeout: 20_000 }).toBe('ACTIVE');
}

/**
 * Die Kernzusage gegen Doppelungen, an der Datenbank gezählt: Je Serie und
 * Kalendertag höchstens **ein** nicht abgesagter Einsatz — über alle
 * Fassungen hinweg.
 */
async function keineDoppeltenEinsaetze(contractId: string): Promise<void> {
  const zeilen = await db!.job.findMany({
    where: { contractId, status: { not: 'CANCELLED' }, deletedAt: null },
    select: { seriesKey: true, scheduleDate: true },
  });
  const schluessel = zeilen.map((z) => `${z.seriesKey}|${z.scheduleDate?.toISOString().slice(0, 10)}`);
  expect(new Set(schluessel).size, 'Ein Termin einer Serie existiert doppelt.').toBe(schluessel.length);
}

// ---------------------------------------------------------------------------
//  A — Offerte → Vertrag → Plan → in Kraft → Einsätze
// ---------------------------------------------------------------------------

test('A: aus der angenommenen Offerte — Vertrag in der Maske, Plan im Dialog, Einsätze mit ihrer Fassung', async ({
  page,
  context,
}) => {
  // --- Die Kundschaft nimmt die Offerte an, im Browser, ohne Anmeldung -----
  const offerte = await offerteAnlegen(adminJar, stamm.customerId);
  angelegteOfferten.push(offerte.id);
  const offertPfad = pfadVon(await versendenUndLinkLesen(offerte.id, adminJar));

  const kunde = await context.newPage();
  await kunde.goto(offertPfad);
  await kunde.getByRole('button', { name: 'Offerte annehmen' }).click();
  await expect(kunde.getByRole('dialog')).toBeVisible();
  await kunde.getByRole('button', { name: 'Weiter zur Unterzeichnung' }).click();
  await kunde.waitForURL(/\/signieren\/s\/[0-9a-f]{32}$/, { timeout: 30_000 });
  await expect(kunde.locator('[data-pdf-viewer] canvas').first()).toBeVisible({ timeout: 30_000 });
  await kunde.getByRole('checkbox').click();
  await kunde.locator('#sig-name').fill('Nicole Wyss');
  await kunde.getByRole('radio', { name: 'Tippen' }).click();
  await kunde.getByRole('button', { name: 'Verbindlich elektronisch unterzeichnen' }).click();
  await expect
    .poll(async () => (await db!.quote.findUniqueOrThrow({ where: { id: offerte.id } })).status, { timeout: 30_000 })
    .toBe('ACCEPTED');
  await kunde.close();

  // --- Der Vertrag entsteht in der Maske, mit der Offerte als Herkunft ----
  const kundschaft = await db!.customer.findUniqueOrThrow({
    where: { id: stamm.customerId },
    select: { number: true },
  });
  const objekt = await db!.property.findUniqueOrThrow({ where: { id: stamm.propertyId }, select: { label: true } });
  const titel = `Browserprüfung A ${Date.now()}`;

  await alsAdminAnmelden(page);
  await page.goto('/admin/vertraege/neu');
  await auswaehlen(page, 'Kundschaft', new RegExp(`\\(${kundschaft.number}\\)$`));
  await auswaehlen(page, 'Objekt', objekt.label);
  await auswaehlen(page, 'Aus Offerte', new RegExp(`^${offerte.number} — `));
  await feld(page, 'Bezeichnung').fill(titel);
  await feld(page, 'Beginn').fill(zuercherTag(1));
  await feld(page, 'Betrag').fill('1200');
  await feld(page, 'Begründung der Fassung').fill('Erstfassung nach angenommener Offerte');
  await feld(page, 'Bezeichnung auf dem Vertrag').fill('Unterhaltsreinigung Büro');
  await page.getByRole('button', { name: 'Vertrag anlegen' }).click();
  await page.waitForURL(/\/admin\/vertraege\/(?!neu)[a-z0-9]+$/, { timeout: 30_000 });

  const vertrag = await db!.contract.findFirstOrThrow({
    where: { title: titel },
    select: { id: true, quoteId: true, status: true, versions: { select: { id: true } } },
  });
  angelegteVertraege.push(vertrag.id);
  expect(vertrag.quoteId, 'Der Vertrag kennt seine Offerte.').toBe(offerte.id);
  expect(vertrag.status).toBe('DRAFT');
  const versionId = vertrag.versions[0]!.id;

  // --- Der Einsatzplan entsteht im Dialog ---------------------------------
  await page.getByRole('button', { name: 'Plan anlegen' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // Montag ist vorbelegt; angeklickt wird Mo (ab) und Mi (an).
  await dialog.getByText('Mo', { exact: true }).click();
  await dialog.getByText('Mi', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Plan anlegen' }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });

  const plaene = await db!.serviceSchedule.findMany({
    where: { contractService: { contractVersionId: versionId } },
    select: { frequency: true, weekdays: true, startMinute: true, active: true, seriesKey: true },
  });
  expect(plaene.length, 'Der Dialog hat keinen Einsatzplan angelegt.').toBe(1);
  expect(plaene[0]!.frequency).toBe('WEEKLY');
  expect(plaene[0]!.weekdays.sort()).toEqual([3]);
  expect(plaene[0]!.startMinute).toBe(360);
  expect(plaene[0]!.seriesKey, 'Jeder Plan trägt ab dem Anlegen eine Serienkennung.').toBeTruthy();

  // --- In Kraft setzen und planen -----------------------------------------
  await inKraftSetzen(page, vertrag.id);
  const inKraft = await db!.contract.findUniqueOrThrow({ where: { id: vertrag.id }, select: { number: true } });
  expect(inKraft.number, 'Die Vertragsnummer entsteht beim Aktivieren.').toMatch(/^VT-/);

  await page.reload();
  await handlungBestaetigen(page, 'Jetzt planen');
  await expect.poll(() => db!.job.count({ where: { contractId: vertrag.id } }), { timeout: 30_000 }).toBeGreaterThan(0);

  const einsaetze = await db!.job.findMany({
    where: { contractId: vertrag.id },
    select: { contractVersionId: true, scheduledStart: true, seriesKey: true },
  });
  expect(einsaetze.every((e) => e.contractVersionId === versionId)).toBe(true);
  expect(einsaetze.every((e) => e.seriesKey === plaene[0]!.seriesKey)).toBe(true);
  // Nur Mittwoche — in Zürich gezählt.
  const wochentage = new Set(
    einsaetze.map((e) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', weekday: 'short' }).format(e.scheduledStart)),
  );
  expect([...wochentage]).toEqual(['Wed']);
  await keineDoppeltenEinsaetze(vertrag.id);

  await page.reload();
  await expect(page.getByRole('cell', { name: 'Version 1' }).first()).toBeVisible();
});

// ---------------------------------------------------------------------------
//  B — Änderungsantrag → Fassung 2 → in Kraft zum Stichtag
// ---------------------------------------------------------------------------

test('B: Antrag, Freigabe, Übernahme, Fassung 2 in Kraft — Einsätze davor bleiben bei Fassung 1', async ({ page }) => {
  const vertrag = await neuerEntwurf();
  await taeglicherPlan(vertrag.serviceId, zuercherTag(1));

  await alsAdminAnmelden(page);
  await page.goto(`/admin/vertraege/${vertrag.id}`);
  await inKraftSetzen(page, vertrag.id);
  await page.reload();
  await handlungBestaetigen(page, 'Jetzt planen');
  await expect.poll(() => db!.job.count({ where: { contractId: vertrag.id } }), { timeout: 30_000 }).toBeGreaterThan(20);

  // --- Der Antrag: gestellt von der Betriebsleitung ------------------------
  const stichtag = zuercherTag(8);
  const antrag = await post(
    `/api/contracts/${vertrag.id}/amendments`,
    { type: 'PRICE', title: 'Preisanpassung zur Browserprüfung', reason: 'Gestiegene Materialkosten', effectiveFrom: stichtag },
    { jar: managerJar },
  );
  expect(antrag.status, antrag.text).toBe(201);

  // Wer beantragt hat (Betriebsleitung), gibt nicht frei; hier entscheidet
  // die Administration — über die Maske.
  await page.reload();
  await page.getByRole('button', { name: 'Freigeben' }).first().click();
  await expect
    .poll(() => db!.contractAmendment.count({ where: { contractId: vertrag.id, status: 'APPROVED' } }), { timeout: 20_000 })
    .toBe(1);

  await page.reload();
  await page.getByRole('button', { name: 'Übernehmen', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await feld(dialog, 'Gültig ab').fill(stichtag);
  await feld(dialog, 'Betrag').fill('1500');
  await dialog.getByRole('button', { name: 'Versionsentwurf erzeugen' }).click();
  await expect(dialog).toBeHidden({ timeout: 25_000 });
  await expect.poll(() => db!.contractVersion.count({ where: { contractId: vertrag.id } }), { timeout: 20_000 }).toBe(2);

  // Der Entwurf gilt noch nicht — verfassen und in Kraft setzen sind zwei Entscheidungen.
  const vorher = await db!.contractVersion.findMany({ where: { contractId: vertrag.id }, orderBy: { versionNumber: 'asc' } });
  expect(vorher.map((v) => v.status)).toEqual(['ACTIVE', 'DRAFT']);

  // --- Fassung 2 in Kraft setzen, an der Schaltfläche ----------------------
  await page.reload();
  await handlungBestaetigen(page, 'Fassung 2 in Kraft setzen');
  await expect
    .poll(async () => (await db!.contractVersion.findUniqueOrThrow({ where: { id: vorher[1]!.id } })).status, {
      timeout: 20_000,
    })
    .toBe('ACTIVE');

  const nachher = await db!.contractVersion.findMany({ where: { contractId: vertrag.id }, orderBy: { versionNumber: 'asc' } });
  expect(nachher[0]!.status).toBe('SUPERSEDED');
  expect(nachher[0]!.effectiveUntil?.toISOString().slice(0, 10), 'Fassung 1 endet am Stichtag.').toBe(stichtag);
  expect(Number(nachher[0]!.baseAmount), 'Die abgelöste Fassung bleibt, wie sie war.').toBe(1200);
  expect(Number(nachher[1]!.baseAmount)).toBe(1500);

  /*
    Der Kern: Offene Einsätze vor dem Stichtag bleiben bei Fassung 1, ab dem
    Stichtag gehören sie Fassung 2 — und es gibt keinen Termin doppelt.
  */
  const grenze = zuercherMitternacht(stichtag);
  const offene = await db!.job.findMany({
    where: { contractId: vertrag.id, status: { not: 'CANCELLED' } },
    select: { scheduledStart: true, contractVersionId: true },
  });
  const davor = offene.filter((j) => j.scheduledStart < grenze);
  const ab = offene.filter((j) => j.scheduledStart >= grenze);
  expect(davor.length).toBeGreaterThan(0);
  expect(ab.length).toBeGreaterThan(0);
  expect(davor.every((j) => j.contractVersionId === vertrag.versionId), 'Vor dem Stichtag: Fassung 1.').toBe(true);
  expect(ab.every((j) => j.contractVersionId === nachher[1]!.id), 'Ab dem Stichtag: Fassung 2.').toBe(true);
  await keineDoppeltenEinsaetze(vertrag.id);

  // Und die Seite zeigt beide.
  await page.reload();
  await expect(page.getByRole('cell', { name: 'Version 1' }).first()).toBeVisible();
});

// ---------------------------------------------------------------------------
//  C — V1 → V2 → V3
// ---------------------------------------------------------------------------

test('C: drei Fassungen nacheinander — jeder Termin genau einmal, jeder bei seiner Fassung', async ({ page }) => {
  const vertrag = await neuerEntwurf();
  await taeglicherPlan(vertrag.serviceId, zuercherTag(1));

  await alsAdminAnmelden(page);
  await page.goto(`/admin/vertraege/${vertrag.id}`);
  await inKraftSetzen(page, vertrag.id);
  await page.reload();
  await handlungBestaetigen(page, 'Jetzt planen');
  await expect.poll(() => db!.job.count({ where: { contractId: vertrag.id } }), { timeout: 30_000 }).toBeGreaterThan(20);

  const fassung = async (nummer: number, stichtag: string, betrag: number) => {
    // Der Entwurf über die Schnittstelle, die Inkraftsetzung an der Schaltfläche.
    const angelegt = await post<{ data: { id: string } }>(
      `/api/contracts/${vertrag.id}/versions`,
      {
        version: {
          effectiveFrom: stichtag,
          reason: `Fassung ${nummer} der Browserprüfung`,
          billingCycle: 'MONTHLY',
          paymentTermDays: 30,
          pricingModel: 'FIXED_PERIOD',
          baseAmount: betrag,
          vatRate: 8.1,
          noticePeriodDays: 90,
          renewalType: 'NONE',
        },
      },
      { jar: adminJar },
    );
    expect(angelegt.status, angelegt.text).toBe(201);
    await page.reload();
    await handlungBestaetigen(page, `Fassung ${nummer} in Kraft setzen`);
    await expect
      .poll(async () => (await db!.contractVersion.findUniqueOrThrow({ where: { id: data(angelegt).id } })).status, {
        timeout: 20_000,
      })
      .toBe('ACTIVE');
    return data(angelegt).id;
  };

  const v2Tag = zuercherTag(10);
  const v3Tag = zuercherTag(20);
  const v2 = await fassung(2, v2Tag, 1400);
  const v3 = await fassung(3, v3Tag, 1600);

  const fassungen = await db!.contractVersion.findMany({
    where: { contractId: vertrag.id },
    orderBy: { versionNumber: 'asc' },
    select: { status: true, effectiveFrom: true, effectiveUntil: true, baseAmount: true },
  });
  expect(fassungen.map((f) => f.status)).toEqual(['SUPERSEDED', 'SUPERSEDED', 'ACTIVE']);
  expect(fassungen.map((f) => Number(f.baseAmount))).toEqual([1200, 1400, 1600]);
  expect(fassungen[0]!.effectiveUntil?.toISOString().slice(0, 10)).toBe(v2Tag);
  expect(fassungen[1]!.effectiveUntil?.toISOString().slice(0, 10)).toBe(v3Tag);

  // Eine Serie über alle drei Fassungen — die stabile Identität (RB-003).
  const serien = await db!.serviceSchedule.findMany({
    where: { contractService: { version: { contractId: vertrag.id } } },
    select: { seriesKey: true },
  });
  expect(serien.length).toBe(3);
  expect(new Set(serien.map((s) => s.seriesKey)).size, 'Der Plan behält seine Serie über die Fassungen.').toBe(1);

  const g2 = zuercherMitternacht(v2Tag);
  const g3 = zuercherMitternacht(v3Tag);
  const offene = await db!.job.findMany({
    where: { contractId: vertrag.id, status: { not: 'CANCELLED' } },
    select: { scheduledStart: true, contractVersionId: true },
  });
  for (const j of offene) {
    const erwartet = j.scheduledStart < g2 ? vertrag.versionId : j.scheduledStart < g3 ? v2 : v3;
    expect(j.contractVersionId, `Einsatz am ${j.scheduledStart.toISOString()} bei der falschen Fassung`).toBe(erwartet);
  }
  await keineDoppeltenEinsaetze(vertrag.id);

  // Die abgelösten Fassungen weist schon die Datenbank ab, nicht erst der Dienst.
  await expect(
    db!.$executeRawUnsafe(`UPDATE contract_versions SET "baseAmount" = 1 WHERE id = $1`, vertrag.versionId),
  ).rejects.toThrow();
});

// ---------------------------------------------------------------------------
//  D — Abrechnung nach der damals geltenden Fassung
// ---------------------------------------------------------------------------

test('D: vergangene Periode abrechnen — nach Fassung 1, obwohl Fassung 2 inzwischen gilt; der zweite Klick erzeugt nichts', async ({
  page,
}) => {
  // Beginn weit zurück, sonst gibt es keine abgeschlossene Periode.
  const vertrag = await neuerEntwurf({ startDate: zuercherTag(-200) });

  await alsAdminAnmelden(page);
  await page.goto(`/admin/vertraege/${vertrag.id}`);
  await inKraftSetzen(page, vertrag.id);

  // Fassung 2 mit höherem Preis gilt ab morgen.
  const v2 = await post<{ data: { id: string } }>(
    `/api/contracts/${vertrag.id}/versions`,
    {
      version: {
        effectiveFrom: zuercherTag(1),
        reason: 'Neuer Preis ab morgen',
        billingCycle: 'MONTHLY',
        paymentTermDays: 30,
        pricingModel: 'FIXED_PERIOD',
        baseAmount: 1500,
        vatRate: 8.1,
        noticePeriodDays: 90,
        renewalType: 'NONE',
      },
    },
    { jar: adminJar },
  );
  expect(v2.status, v2.text).toBe(201);
  await page.reload();
  await handlungBestaetigen(page, 'Fassung 2 in Kraft setzen');
  await expect
    .poll(async () => (await db!.contractVersion.findUniqueOrThrow({ where: { id: data(v2).id } })).status, {
      timeout: 20_000,
    })
    .toBe('ACTIVE');

  const abrechnen = async () => {
    await page.getByRole('button', { name: 'Periode abrechnen' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Rechnung erzeugen' }).click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });
  };

  await page.reload();
  await abrechnen();
  await expect
    .poll(() => db!.invoice.count({ where: { contractId: vertrag.id, deletedAt: null } }), { timeout: 20_000 })
    .toBe(1);

  const rechnung = await db!.invoice.findFirstOrThrow({
    where: { contractId: vertrag.id },
    select: { contractVersionId: true, contractPeriodStart: true, contractPeriodEnd: true, grossTotal: true },
  });
  expect(rechnung.contractVersionId, 'Die vergangene Periode lief unter Fassung 1.').toBe(vertrag.versionId);
  expect(Number(rechnung.grossTotal), '1200 + 8.1 % — nicht der neue Preis.').toBeCloseTo(1297.2, 2);
  expect(rechnung.contractPeriodStart, 'Die Periode ist kanonisch, nicht frei gewählt.').toBeTruthy();
  expect(rechnung.contractPeriodEnd, 'Das Periodenende steht fest (RB-008).').toBeTruthy();

  // Derselbe Weg ein zweites Mal — und es bleibt bei einer Rechnung.
  await page.reload();
  await abrechnen();
  expect(await db!.invoice.count({ where: { contractId: vertrag.id, deletedAt: null } })).toBe(1);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Abrechnung' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Version 1' }).first()).toBeVisible();
});

// ---------------------------------------------------------------------------
//  E — Unterzeichnung: eine Fassung, danach eingefroren
// ---------------------------------------------------------------------------

test('E: Fassung zur Unterschrift, im Browser angenommen, danach unveränderlich und nicht stornierbar', async ({ page }) => {
  const vertrag = await neuerEntwurf();

  await alsAdminAnmelden(page);
  await page.goto(`/admin/vertraege/${vertrag.id}`);
  await handlungBestaetigen(page, 'Zur Unterschrift senden');

  await expect
    .poll(() => db!.signatureRequest.count({ where: { contractVersionId: vertrag.versionId, status: 'PENDING' } }), {
      timeout: 25_000,
    })
    .toBe(1);

  const vorgang = await db!.signatureRequest.findFirstOrThrow({
    where: { contractVersionId: vertrag.versionId },
    select: { id: true, originalDocumentHash: true, consentVersion: true, ceremonyMode: true },
  });
  expect(vorgang.consentVersion, 'Eigener Zustimmungstext je Quelle.').toBe('vertrag-v1');
  expect(vorgang.ceremonyMode).toBe('REMOTE_LINK');
  expect(vorgang.originalDocumentHash, 'Hash A steht ab dem Start fest.').toMatch(/^[0-9a-f]{64}$/);

  /*
    Der rohe Zugang existiert nur in der versendeten Nachricht — in der
    Datenbank liegt bloss sein Hash. Der Postausgang ist damit das einzige
    Prüfwerkzeug, und genau dafür gibt es ihn.
  */
  const mail = letzteMail({ entityId: vorgang.id });
  expect(mail, 'Keine Einladung im Postausgang — läuft der Server mit CLENARIS_TEST_CACHE_DIR?').toBeTruthy();
  const signLink = linksIn(mail!).find((l) => /\/signieren#t=[0-9a-f]{64}$/.test(l));
  expect(signLink, `Kein Unterzeichnungslink: ${linksIn(mail!).join(', ')}`).toBeTruthy();

  // --- Die Kundschaft unterschreibt, ohne Anmeldung ------------------------
  const kundenSeite = await page.context().newPage();
  await kundenSeite.goto(pfadVon(signLink!) + new URL(signLink!).hash);
  await kundenSeite.waitForURL(/\/signieren\/s\/[0-9a-f]{32}$/, { timeout: 30_000 });
  await expect(kundenSeite.locator('[data-pdf-viewer] canvas').first()).toBeVisible({ timeout: 30_000 });
  await kundenSeite.getByRole('checkbox').click();
  await kundenSeite.locator('#sig-name').fill('Maria Beispiel');
  await unterschriftZeichnen(kundenSeite);
  await kundenSeite.getByRole('button', { name: 'Verbindlich elektronisch unterzeichnen' }).click();

  await expect
    .poll(
      async () => (await db!.signatureRequest.findUniqueOrThrow({ where: { id: vorgang.id }, select: { status: true } })).status,
      { timeout: 60_000 },
    )
    .toBe('COMPLETED');
  await kundenSeite.close();

  // --- Die Kopplung: Vorgang abgeschlossen ⇔ Fassung angenommen -----------
  const fassung = await db!.contractVersion.findUniqueOrThrow({
    where: { id: vertrag.versionId },
    select: { acceptedAt: true, acceptedRequestId: true, status: true },
  });
  expect(fassung.acceptedAt, 'Abgeschlossen, aber nichts geschehen — genau das darf es nicht geben.').toBeTruthy();
  expect(fassung.acceptedRequestId, 'Der Beweis zeigt eindeutig auf diese Fassung.').toBe(vorgang.id);
  expect(fassung.status, 'Die Annahme setzt den Vertrag nicht selbst in Kraft.').toBe('DRAFT');
  expect(await vertragsstatus(vertrag.id)).toBe('OFFERED');

  // --- Eingefroren: keine Maske, und der Dienst weist ab -------------------
  await page.reload();
  await expect(page.getByText('Elektronisch angenommen am', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Entwurf bearbeiten' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Plan anlegen' }), 'Ein angenommener Plan ist kein freier Entwurf.').toHaveCount(0);

  /*
    Über den HTTP-Klienten mit dem Cookie-Glas, nicht über `page.request`:
    Playwrights APIRequestContext filtert `Secure`-Cookies nach Schema und
    käme unangemeldet an — 401 statt 422, und der Fall hätte eine Sperre
    „bewiesen", die gar nicht geprüft wurde.
  */
  const aenderung = await patch(
    `/api/contracts/${vertrag.id}/versions/${vertrag.versionId}`,
    {
      effectiveFrom: zuercherTag(1),
      reason: 'Heimliche Änderung nach der Unterschrift',
      billingCycle: 'MONTHLY',
      paymentTermDays: 30,
      pricingModel: 'FIXED_PERIOD',
      baseAmount: 9999,
      vatRate: 8.1,
      noticePeriodDays: 90,
      renewalType: 'NONE',
    },
    { jar: adminJar },
  );
  expect(aenderung.status, 'Eine angenommene Fassung lässt sich nicht mehr ändern.').toBe(422);

  // RB-005: Ein Vertrag mit angenommener Fassung wird nicht still storniert.
  const storno = await post(`/api/contracts/${vertrag.id}/cancel`, { reason: 'Versuch nach der Annahme' }, { jar: adminJar });
  expect(storno.status, 'Die Kundschaft hat zugestimmt — Stornieren ist kein Weg daran vorbei.').toBe(422);
  expect(await vertragsstatus(vertrag.id)).toBe('OFFERED');

  // Und die angenommene Fassung tritt an der Schaltfläche in Kraft.
  await inKraftSetzen(page, vertrag.id);
  const inKraft = await db!.contractVersion.findUniqueOrThrow({
    where: { id: vertrag.versionId },
    select: { status: true, baseAmount: true, acceptedRequestId: true },
  });
  expect(inKraft.status).toBe('ACTIVE');
  expect(Number(inKraft.baseAmount)).toBe(1200);
  expect(inKraft.acceptedRequestId).toBe(vorgang.id);
});

// ---------------------------------------------------------------------------
//  F — Pause und Wiederaufnahme
// ---------------------------------------------------------------------------

test('F: Pause sagt geplante Einsätze ab, Fortsetzen plant ab heute — nichts in der Vergangenheit, nichts doppelt', async ({
  page,
}) => {
  const vertrag = await neuerEntwurf();
  await taeglicherPlan(vertrag.serviceId, zuercherTag(1));

  await alsAdminAnmelden(page);
  await page.goto(`/admin/vertraege/${vertrag.id}`);
  await inKraftSetzen(page, vertrag.id);
  await page.reload();
  await handlungBestaetigen(page, 'Jetzt planen');
  await expect.poll(() => db!.job.count({ where: { contractId: vertrag.id } }), { timeout: 30_000 }).toBeGreaterThan(20);

  // --- Pausieren im Dialog: Beginn heute (vorbelegt), Ende in 14 Tagen -----
  const pauseEnde = zuercherTag(14);
  await page.reload();
  await page.getByRole('button', { name: 'Pausieren', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await feld(dialog, 'Bis und mit').fill(pauseEnde);
  await feld(dialog, 'Grund').fill('Bauarbeiten im Gebäude');
  await dialog.getByRole('button', { name: 'Pausieren', exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await expect.poll(() => vertragsstatus(vertrag.id), { timeout: 20_000 }).toBe('PAUSED');

  /*
    RB-007: Die Pause wirkt auf das, was schon geplant ist. Vorher hielt sie
    nur den Planer an, und das Team fuhr vor eine verschlossene Tür.
  */
  const nachPauseEnde = zuercherMitternacht(zuercherTag(15));
  const inDerPause = await db!.job.count({
    where: { contractId: vertrag.id, status: { not: 'CANCELLED' }, scheduledStart: { lt: nachPauseEnde } },
  });
  expect(inDerPause, 'In der Pause steht kein offener Einsatz mehr.').toBe(0);
  const danach = await db!.job.count({
    where: { contractId: vertrag.id, status: { not: 'CANCELLED' }, scheduledStart: { gte: nachPauseEnde } },
  });
  expect(danach, 'Nach dem Ende der Pause bleibt der Plan stehen.').toBeGreaterThan(0);

  await page.reload();
  await expect(page.getByRole('button', { name: 'Jetzt planen' }), 'In der Pause gibt es nichts zu planen.').toHaveCount(0);

  // --- Fortsetzen ----------------------------------------------------------
  const fortgesetztAb = new Date();
  await handlungBestaetigen(page, 'Fortsetzen');
  await expect.poll(() => vertragsstatus(vertrag.id), { timeout: 20_000 }).toBe('ACTIVE');

  /*
    RB-007: Ab heute in Zürich, nicht ab der Pause. Was nach dem Fortsetzen
    entstand, liegt nicht vor heute — und was in der Pause abgesagt wurde,
    kommt ab heute wieder, ohne Doppel.
  */
  const heute = zuercherMitternacht(zuercherTag(0));
  const neu = await db!.job.findMany({
    where: { contractId: vertrag.id, status: { not: 'CANCELLED' }, createdAt: { gte: fortgesetztAb } },
    select: { scheduledStart: true },
  });
  expect(neu.length, 'Das Fortsetzen hat die Tage der Pause ab heute wieder geplant.').toBeGreaterThan(0);
  expect(
    neu.filter((j) => j.scheduledStart < heute).length,
    'Kein Einsatz in der Vergangenheit.',
  ).toBe(0);
  await keineDoppeltenEinsaetze(vertrag.id);
});
