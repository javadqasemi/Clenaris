import type { Page } from '@playwright/test';

import { patch, post } from '../helpers/client';
import { letzteMail, linksIn } from '../helpers/mail';
import { testDb } from '../helpers/testdb';

import { expect, test } from './helpers/basis';
import { imBrowserAnmelden, konsoleUeberwachen, unterschriftZeichnen } from './helpers/browser';
import {
  frischAnmelden,
  pfadVon,
  stammdatenLesen,
  vertragAufraeumen,
  vertragsentwurfAnlegen,
  type Stammdaten,
} from './helpers/bestand';

/**
 * Wave 10 im echten Browser — der Vertrag von der Fassung bis zur Rechnung.
 *
 * ---------------------------------------------------------------------------
 *  Was hier geprüft wird und was ausdrücklich nicht
 * ---------------------------------------------------------------------------
 *
 * Die Fachregeln stehen in `tests/api/vertraege.test.ts` und im reinen
 * Rechenkern: dass eine geltende Fassung unveränderlich ist, dass zwei
 * gleichzeitige Abrechnungen eine Rechnung ergeben, welche Kalendertage eine
 * Regel trifft. Nichts davon wird hier wiederholt — über HTTP ist es schneller
 * und schärfer zu prüfen.
 *
 * Was hier hinzukommt, ist die Frage, die eine HTTP-Reihe **nicht** beantwortet
 * und die in diesem Projekt schon dreimal falsch beantwortet war:
 *
 *   **Gibt es die Maske wirklich, schreibt sie in dieselbe Datenbank, und
 *   erscheint das Ergebnis danach auf der Seite?**
 *
 * Deshalb läuft alles, worüber hier eine Aussage getroffen wird, über die
 * Oberfläche: Der Einsatzplan entsteht im Dialog, die Inkraftsetzung an der
 * Schaltfläche, die Unterschrift auf dem Canvas, die Rechnung im Formular. Nur
 * die Vorbereitung — Vertragsentwurf mit erster Fassung — kommt über die
 * Schnittstelle.
 *
 * Geprüft wird jeweils gegen die **Datenbank**, nicht gegen eine Meldung im
 * Bild: Ein grüner Hinweis ist kein Beweis, dass etwas gespeichert wurde.
 */

const db = testDb();

let adminJar = '';
let managerJar = '';
let stamm: Stammdaten;

/** Was dieser Lauf angelegt hat. */
const angelegteVertraege: string[] = [];

test.beforeAll(async () => {
  adminJar = await frischAnmelden('admin');
  managerJar = await frischAnmelden('manager');
  stamm = await stammdatenLesen(adminJar);
});

test.afterAll(async () => {
  for (const id of angelegteVertraege) await vertragAufraeumen(id, adminJar);
});

async function neuerEntwurf(ueber: { startDate?: string; baseAmount?: number } = {}) {
  const vertrag = await vertragsentwurfAnlegen(stamm, adminJar, ueber);
  angelegteVertraege.push(vertrag.id);
  return vertrag;
}

/**
 * Anmelden über die Maske — die Browserreihe teilt keine Sitzung mit der
 * HTTP-Reihe.
 *
 * Über den gemeinsamen Helfer, nicht von Hand: Der erste Entwurf tippte die
 * Zugangsdaten aus und nahm für die Administration das Demopasswort der
 * übrigen Konten. Alle fünf Fälle scheiterten mit „Zeitüberschreitung beim
 * Warten auf /admin" — eine Meldung, die nach einem Fehler der Anwendung
 * aussieht und keiner war.
 */
async function alsAdminAnmelden(page: Page): Promise<void> {
  await imBrowserAnmelden(page, 'admin', /\/admin/);
}

/**
 * Eine Handlung mit Rückfrage auslösen: Schaltfläche, dann dieselbe
 * Beschriftung im Dialog.
 *
 * `ActionButton` beschriftet die bestätigende Schaltfläche mit **derselben**
 * Beschriftung wie den Auslöser — „In Kraft setzen" fragt mit „In Kraft
 * setzen". Das ist gute Praxis (die Bestätigung nennt die Handlung, nicht ein
 * nichtssagendes „OK"), macht aber eine Auswahl über den Namen allein
 * mehrdeutig. Deshalb wird die zweite ausdrücklich im Dialog gesucht.
 */
async function handlungBestaetigen(page: Page, beschriftung: string, notiz?: string): Promise<void> {
  await page.getByRole('button', { name: beschriftung, exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  if (notiz !== undefined) await dialog.getByRole('textbox').fill(notiz);
  await dialog.getByRole('button', { name: beschriftung, exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 25_000 });
}

// ---------------------------------------------------------------------------
//  A — Entwurf → Einsatzplan → in Kraft → Einsätze
// ---------------------------------------------------------------------------

test('A: Einsatzplan im Dialog, Inkraftsetzung, Einsätze mit ihrer Fassung', async ({ page }) => {
  const konsole = konsoleUeberwachen(page);
  const vertrag = await neuerEntwurf();

  await alsAdminAnmelden(page);
  await page.goto(`/admin/vertraege/${vertrag.id}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // --- Der Einsatzplan entsteht im Dialog, nicht über die Schnittstelle ----
  await page.getByRole('button', { name: 'Plan anlegen' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // Montag und Mittwoch — Wochentage sind Kästchen, keine Zahlenliste.
  await dialog.getByText('Mo', { exact: true }).click();
  await dialog.getByText('Mi', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Plan anlegen' }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });

  /*
    Gegen die Datenbank, nicht gegen den Hinweis im Bild: Ob der Dialog
    geschrieben hat, sagt allein die Zeile.
  */
  const plaene = await db!.serviceSchedule.findMany({
    where: { contractService: { contractVersionId: vertrag.versionId } },
    select: { frequency: true, weekdays: true, startMinute: true, endMinute: true, active: true },
  });
  expect(plaene.length, 'Der Dialog hat keinen Einsatzplan angelegt.').toBe(1);
  expect(plaene[0]!.frequency).toBe('WEEKLY');
  // Montag ist bereits vorbelegt; angeklickt wurde Mo (ab) und Mi (an).
  expect(plaene[0]!.weekdays.sort()).toEqual([3]);
  expect(plaene[0]!.startMinute).toBe(360);
  expect(plaene[0]!.active).toBe(true);

  // --- In Kraft setzen -----------------------------------------------------
  await handlungBestaetigen(page, 'In Kraft setzen');

  await expect
    .poll(async () => (await db!.contract.findUniqueOrThrow({ where: { id: vertrag.id } })).status, {
      timeout: 20_000,
    })
    .toBe('ACTIVE');

  const inKraft = await db!.contract.findUniqueOrThrow({ where: { id: vertrag.id } });
  expect(inKraft.number, 'Die Vertragsnummer entsteht beim Aktivieren.').toMatch(/^VT-/);

  // --- Einsätze erzeugen ---------------------------------------------------
  await page.reload();
  await handlungBestaetigen(page, 'Jetzt planen');

  await expect
    .poll(async () => db!.job.count({ where: { contractId: vertrag.id } }), { timeout: 30_000 })
    .toBeGreaterThan(0);

  /*
    Jeder Einsatz trägt die Fassung, unter der er entstand. Ohne diese
    Zuordnung wäre nach der ersten Preisanpassung nicht mehr beantwortbar,
    unter welchen Konditionen er erbracht wurde.
  */
  const einsaetze = await db!.job.findMany({
    where: { contractId: vertrag.id },
    select: { contractVersionId: true },
  });
  expect(einsaetze.every((e) => e.contractVersionId === vertrag.versionId)).toBe(true);

  // Und die Seite zeigt es auch.
  await page.reload();
  await expect(page.getByRole('cell', { name: 'Version 1' }).first()).toBeVisible();

  konsole.keineFehler();
});

// ---------------------------------------------------------------------------
//  D — Unterzeichnung: eine Fassung, danach eingefroren
// ---------------------------------------------------------------------------

test('D: Fassung zur Unterschrift, im Browser angenommen, danach unveränderlich', async ({ page }) => {
  const vertrag = await neuerEntwurf();

  await alsAdminAnmelden(page);
  await page.goto(`/admin/vertraege/${vertrag.id}`);

  await handlungBestaetigen(page, 'Zur Unterschrift senden');

  await expect
    .poll(
      async () =>
        db!.signatureRequest.count({
          where: { contractVersionId: vertrag.versionId, status: 'PENDING' },
        }),
      { timeout: 25_000 },
    )
    .toBe(1);

  const vorgang = await db!.signatureRequest.findFirstOrThrow({
    where: { contractVersionId: vertrag.versionId },
    select: { id: true, publicId: true, originalDocumentHash: true, consentVersion: true, ceremonyMode: true },
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
      async () =>
        (await db!.signatureRequest.findUniqueOrThrow({ where: { id: vorgang.id }, select: { status: true } }))
          .status,
      { timeout: 60_000 },
    )
    .toBe('COMPLETED');

  // --- Die Kopplung: Vorgang abgeschlossen ⇔ Fassung angenommen -----------
  const fassung = await db!.contractVersion.findUniqueOrThrow({
    where: { id: vertrag.versionId },
    select: { acceptedAt: true, acceptedRequestId: true, status: true },
  });
  expect(fassung.acceptedAt, 'Abgeschlossen, aber nichts geschehen — genau das darf es nicht geben.').toBeTruthy();
  expect(fassung.acceptedRequestId, 'Der Beweis zeigt eindeutig auf diese Fassung.').toBe(vorgang.id);
  expect(fassung.status, 'Die Annahme setzt den Vertrag nicht selbst in Kraft.').toBe('DRAFT');

  const vertragDanach = await db!.contract.findUniqueOrThrow({ where: { id: vertrag.id } });
  expect(vertragDanach.status).toBe('OFFERED');

  // --- Und die Fassung ist danach eingefroren ------------------------------
  await kundenSeite.close();
  await page.reload();
  await expect(
    page.getByText('Elektronisch angenommen am', { exact: false }).first(),
    'Die Annahme steht an der Fassung, nicht am Vertragskopf.',
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Entwurf bearbeiten' }),
    'Eine angenommene Fassung bietet keine Maske zum Ändern an.',
  ).toHaveCount(0);

  /*
    Nicht nur die Schaltfläche fehlt — der Dienst weist es ab. Eine
    Einschränkung, die nur die Anzeige betrifft, wäre auf der Leitung
    wirkungslos, und genau das ist hier die Aussage.

    Über den HTTP-Klienten mit dem Cookie-Glas, nicht über `page.request`:
    Playwrights APIRequestContext ist ein eigener HTTP-Stapel in Node und
    filtert `Secure`-Cookies nach Schema. Eine Anfrage von dort käme
    unangemeldet an und ergäbe 401 statt 422 — der Fall hätte dann bewiesen,
    dass eine Sperre greift, die gar nicht geprüft wurde.
  */
  const versuch = await patch(
    `/api/contracts/${vertrag.id}/versions/${vertrag.versionId}`,
    {
      effectiveFrom: new Date().toISOString().slice(0, 10),
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
  expect(versuch.status, 'Eine angenommene Fassung lässt sich nicht mehr ändern.').toBe(422);

  const unveraendert = await db!.contractVersion.findUniqueOrThrow({
    where: { id: vertrag.versionId },
    select: { baseAmount: true },
  });
  expect(Number(unveraendert.baseAmount)).toBe(1200);
});

// ---------------------------------------------------------------------------
//  C — Abrechnung: eine Periode, eine Rechnung
// ---------------------------------------------------------------------------

test('C: Periode im Formular abrechnen — der zweite Klick erzeugt keine zweite Rechnung', async ({ page }) => {
  // Beginn weit in der Vergangenheit, sonst gibt es keine abgeschlossene Periode.
  const vertrag = await neuerEntwurf({ startDate: new Date(Date.now() - 200 * 86_400_000).toISOString().slice(0, 10) });

  await alsAdminAnmelden(page);
  await page.goto(`/admin/vertraege/${vertrag.id}`);
  await handlungBestaetigen(page, 'In Kraft setzen');
  await expect
    .poll(async () => (await db!.contract.findUniqueOrThrow({ where: { id: vertrag.id } })).status, {
      timeout: 20_000,
    })
    .toBe('ACTIVE');

  await page.reload();

  const abrechnen = async () => {
    await page.getByRole('button', { name: 'Periode abrechnen' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Rechnung erzeugen' }).click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });
  };

  await abrechnen();
  await expect
    .poll(async () => db!.invoice.count({ where: { contractId: vertrag.id, deletedAt: null } }), { timeout: 20_000 })
    .toBe(1);

  const erste = await db!.invoice.findFirstOrThrow({
    where: { contractId: vertrag.id },
    select: { id: true, contractVersionId: true, contractPeriodStart: true, grossTotal: true },
  });
  expect(erste.contractVersionId, 'Die Rechnung trägt die Fassung, unter der sie entstand.').toBe(vertrag.versionId);
  expect(erste.contractPeriodStart, 'Die Periode ist kanonisch, nicht frei gewählt.').toBeTruthy();
  expect(Number(erste.grossTotal)).toBeCloseTo(1297.2, 2);

  // Derselbe Weg ein zweites Mal — und es bleibt bei einer Rechnung.
  await page.reload();
  await abrechnen();

  const anzahl = await db!.invoice.count({ where: { contractId: vertrag.id, deletedAt: null } });
  expect(anzahl, 'Eine Periode, eine Rechnung — auch bei zwei Durchgängen durch die Maske.').toBe(1);

  // Und die Seite führt sie auf, mit Zeitraum und Fassung.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Abrechnung' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Version 1' }).first()).toBeVisible();
});

// ---------------------------------------------------------------------------
//  B — Änderungsantrag: neue Fassung, alte Einsätze bleiben bei ihrer
// ---------------------------------------------------------------------------

test('B: Antrag, Freigabe, neue Fassung — bestehende Einsätze behalten Fassung 1', async ({ page }) => {
  const vertrag = await neuerEntwurf();

  // Vorbereitung bis zum laufenden Vertrag mit Einsätzen — über die Maske
  // wäre das eine Wiederholung von Fall A.
  await alsAdminAnmelden(page);
  await page.goto(`/admin/vertraege/${vertrag.id}`);
  await handlungBestaetigen(page, 'In Kraft setzen');
  await expect
    .poll(async () => (await db!.contract.findUniqueOrThrow({ where: { id: vertrag.id } })).status, {
      timeout: 20_000,
    })
    .toBe('ACTIVE');

  const alterEinsatz = await db!.job.create({
    data: {
      organizationId: (await db!.contract.findUniqueOrThrow({ where: { id: vertrag.id } })).organizationId,
      number: `BR-${Date.now()}`,
      customerId: stamm.customerId,
      addressId: stamm.addressId,
      propertyId: stamm.propertyId,
      serviceId: stamm.serviceId,
      contractId: vertrag.id,
      contractVersionId: vertrag.versionId,
      title: 'Einsatz unter Fassung 1',
      scheduledStart: new Date(Date.now() + 3 * 86_400_000),
      scheduledEnd: new Date(Date.now() + 3 * 86_400_000 + 7_200_000),
      estimatedMin: 120,
    },
    select: { id: true },
  });

  // --- Der Antrag: gestellt von der Betriebsleitung ------------------------
  const antrag = await post(
    `/api/contracts/${vertrag.id}/amendments`,
    {
      type: 'PRICE',
      title: 'Preisanpassung zur Browserprüfung',
      reason: 'Gestiegene Materialkosten',
      effectiveFrom: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
    },
    { jar: managerJar },
  );
  expect(antrag.status, antrag.text).toBe(201);

  /*
    Freigabe und Wirksamwerden laufen über die Maske — das ist die Aussage
    dieses Falls. Wer beantragt hat (Betriebsleitung), gibt nicht frei; hier
    entscheidet die Administration.
  */
  await page.reload();
  await page.getByRole('button', { name: 'Freigeben' }).first().click();
  await expect
    .poll(async () => db!.contractAmendment.count({ where: { contractId: vertrag.id, status: 'APPROVED' } }), {
      timeout: 20_000,
    })
    .toBe(1);

  await page.reload();
  await page.getByRole('button', { name: 'Wirksam machen' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Betrag').fill('1500');
  await dialog.getByRole('button', { name: 'Neue Fassung erzeugen' }).click();
  await expect(dialog).toBeHidden({ timeout: 25_000 });

  await expect
    .poll(async () => db!.contractVersion.count({ where: { contractId: vertrag.id } }), { timeout: 20_000 })
    .toBe(2);

  const fassungen = await db!.contractVersion.findMany({
    where: { contractId: vertrag.id },
    orderBy: { versionNumber: 'asc' },
    select: { id: true, versionNumber: true, status: true, baseAmount: true },
  });
  /*
    Die neue Fassung entsteht als **Entwurf**, nicht als sofortige Umstellung
    — dieselbe Trennung wie überall im Modul: verfassen und in Kraft setzen
    sind zwei Entscheidungen mit zwei Rechten. Wirksam wird sie über
    `/activate` mit dem Stichtag.
  */
  expect(fassungen[0]!.status, 'Die geltende Fassung bleibt geltend, bis jemand umstellt.').toBe('ACTIVE');
  expect(fassungen[1]!.status).toBe('DRAFT');
  expect(Number(fassungen[1]!.baseAmount)).toBe(1500);

  /*
    Der Kern der Aussage: Der bereits disponierte Einsatz zeigt weiter auf
    Fassung 1. Löste er dynamisch auf „die derzeit geltende" auf, wäre jede
    Nachkalkulation nach der ersten Preisanpassung falsch.
  */
  const unveraendert = await db!.job.findUniqueOrThrow({
    where: { id: alterEinsatz.id },
    select: { contractVersionId: true },
  });
  expect(unveraendert.contractVersionId).toBe(vertrag.versionId);
  expect(unveraendert.contractVersionId).not.toBe(fassungen[1]!.id);

  await db!.job.delete({ where: { id: alterEinsatz.id } }).catch(() => undefined);
});

// ---------------------------------------------------------------------------
//  E — Pause: keine Einsätze in der Ruhezeit, danach wieder
// ---------------------------------------------------------------------------

test('E: Pausieren hält den Planer an, Fortsetzen lässt ihn weiterplanen', async ({ page }) => {
  const vertrag = await neuerEntwurf();

  await alsAdminAnmelden(page);
  await page.goto(`/admin/vertraege/${vertrag.id}`);

  // Einsatzplan über die Maske, damit überhaupt etwas zu planen ist.
  await page.getByRole('button', { name: 'Plan anlegen' }).first().click();
  const planDialog = page.getByRole('dialog');
  await expect(planDialog).toBeVisible();
  await planDialog.getByRole('button', { name: 'Plan anlegen' }).click();
  await expect(planDialog).toBeHidden({ timeout: 15_000 });

  await handlungBestaetigen(page, 'In Kraft setzen');
  await expect
    .poll(async () => (await db!.contract.findUniqueOrThrow({ where: { id: vertrag.id } })).status, {
      timeout: 20_000,
    })
    .toBe('ACTIVE');

  // --- Pausieren -----------------------------------------------------------
  await page.reload();
  await handlungBestaetigen(page, 'Pausieren', 'Bauarbeiten im Gebäude');

  await expect
    .poll(async () => (await db!.contract.findUniqueOrThrow({ where: { id: vertrag.id } })).status, {
      timeout: 20_000,
    })
    .toBe('PAUSED');

  /*
    In der Pause gibt es nichts zu planen — und die Schaltfläche behauptet es
    auch nicht. Eine ausgegraute wäre ehrlicher als eine, die 422 antwortet;
    eine, die gar nicht da ist, ist die ehrlichste.
  */
  await page.reload();
  await expect(page.getByRole('button', { name: 'Jetzt planen' })).toHaveCount(0);

  const vorher = await db!.job.count({ where: { contractId: vertrag.id } });

  /*
    Und der Planer erzeugt auch dann nichts, wenn ihn jemand an der Oberfläche
    vorbei anstösst — über den HTTP-Klienten, nicht über `page.request`
    (dessen eigener Stapel schickt die `Secure`-Cookies nicht und ergäbe 401).
  */
  const waehrendPause = await post(
    `/api/contracts/${vertrag.id}/schedule`,
    { bis: new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10) },
    { jar: adminJar },
  );
  expect([200, 422]).toContain(waehrendPause.status);
  expect(
    await db!.job.count({ where: { contractId: vertrag.id } }),
    'Während der Pause entstehen keine Einsätze.',
  ).toBe(vorher);

  // --- Fortsetzen ----------------------------------------------------------
  await page.getByRole('button', { name: 'Fortsetzen' }).click();
  await expect
    .poll(async () => (await db!.contract.findUniqueOrThrow({ where: { id: vertrag.id } })).status, {
      timeout: 20_000,
    })
    .toBe('ACTIVE');

  await page.reload();
  await handlungBestaetigen(page, 'Jetzt planen');

  await expect
    .poll(async () => db!.job.count({ where: { contractId: vertrag.id } }), { timeout: 30_000 })
    .toBeGreaterThan(vorher);
});
