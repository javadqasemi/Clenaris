import { devices, type Page } from '@playwright/test';

import { ACCOUNTS } from '../helpers/accounts';
import { testDb } from '../helpers/testdb';

import { expect, test } from './helpers/basis';
import {
  imBrowserAnmelden,
  konsoleUeberwachen,
  netzUeberwachen,
  ressourcenfehler,
  statusAusSeite,
  unterschriftTippen,
  unterschriftZeichnen,
  type Konsolenwache,
} from './helpers/browser';
import {
  abgeschlossenenEinsatzAnlegen,
  einsatzEntfernen,
  frischAnmelden,
  sperrenLoesen,
  stammdatenLesen,
  type Stammdaten,
} from './helpers/bestand';

/**
 * Gate 4D im echten Browser — die Übergabe des Geräts, von Anfang bis Ende.
 *
 * Das ist der Fall, für den die Browserprüfung erfunden wurde: Zwei Personen
 * sitzen nacheinander an **derselben** Sitzung, und die Cookies der einen
 * liegen im Browser, den die andere in der Hand hält.
 * `tests/api/vor-ort-abnahme.test.ts` beweist, dass jeder angemeldete Endpunkt
 * dabei 423 antwortet. Was es nicht prüfen kann, ist der Weg dorthin: die
 * Schaltfläche, der volle Seitenwechsel, der Kundenbildschirm ohne Navigation,
 * der Rückgabebildschirm und das Entsperren mit dem eigenen Passwort.
 *
 * Diese Datei fährt genau diesen Weg — getippt, gezeichnet und auf einem
 * Telefonbildschirm.
 */

const db = testDb();

let adminJar = '';
let mitarbeiterJar = '';
let stamm: Stammdaten;

test.beforeAll(async () => {
  adminJar = await frischAnmelden('admin');
  mitarbeiterJar = await frischAnmelden('employee');
  stamm = await stammdatenLesen(adminJar);
});

const angelegt: string[] = [];

test.afterEach(async () => {
  /**
   * Offene Sperren lösen, bevor der nächste Fall beginnt. Ohne das bliebe nach
   * einem Fehlschlag eine aktive Übergabe stehen, und der folgende Fall
   * scheiterte an ihr statt an sich selbst — man suchte den Fehler dann in der
   * Sperre. Vorgänge und Ereignisse bleiben liegen; sie sind der Beweis.
   */
  if (stamm) await sperrenLoesen(stamm.employeeUserId);
});

test.afterAll(async () => {
  for (const id of angelegt) await einsatzEntfernen(id, adminJar);
});

// ---------------------------------------------------------------------------
//  Werkzeuge
// ---------------------------------------------------------------------------

async function einsatz(): Promise<{ id: string; number: string }> {
  const job = await abgeschlossenenEinsatzAnlegen(stamm, adminJar, mitarbeiterJar);
  angelegt.push(job.id);
  return job;
}

/**
 * Vom angemeldeten Mitarbeiterbereich bis auf den Kundenbildschirm — über die
 * Maske, wie auf einer Baustelle.
 */
async function geraetUebergeben(page: Page, jobId: string): Promise<string> {
  await page.goto(`/portal/einsaetze/${jobId}`);

  const schaltflaeche = page.getByRole('button', { name: 'Kundenabnahme vorbereiten' });
  await expect(schaltflaeche).toBeVisible();
  await schaltflaeche.click();

  await page.waitForURL(/\/abnahme\/[0-9a-f]{32}$/, { timeout: 30_000 });
  return /\/abnahme\/([0-9a-f]{32})$/.exec(page.url())![1]!;
}

/** Zustimmung und Name auf dem Kundenbildschirm. */
async function kundeStimmtZu(page: Page, name: string): Promise<void> {
  await expect(page.getByText('Abnahme vor Ort').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: '1. Dokument lesen' })).toBeVisible();
  await expect(page.locator('[data-pdf-viewer] canvas').first()).toBeVisible({ timeout: 30_000 });

  await page.getByRole('checkbox').click();
  await page.locator('#sig-name').fill(name);
}

const unterzeichnen = (page: Page) =>
  page.getByRole('button', { name: 'Verbindlich elektronisch unterzeichnen' });

const jobLesen = (id: string) =>
  db!.job.findUniqueOrThrow({
    where: { id },
    select: { status: true, customerAcceptedAt: true, signatureDataUrl: true },
  });

/** Die Rückgabe: falsches Passwort, dann das richtige. */
async function geraetZurueckgeben(page: Page, konsole: Konsolenwache): Promise<void> {
  await page.goto('/geraet-uebernehmen');
  await expect(page.getByRole('heading', { name: 'Zurück zum Mitarbeiterbereich' })).toBeVisible();

  // Kein vollständiges Anmelden: Es gibt kein Feld für die E-Mail-Adresse.
  await expect(page.locator('input[type="email"]')).toHaveCount(0);

  /**
   * Das falsche Passwort zuerst. Die Meldung wird im Formular gesucht, nicht
   * über `getByRole('alert')` auf der ganzen Seite: Dort stehen ausserdem der
   * Erfolgshinweis „Abnahme abgeschlossen" und der Routenansager von Next,
   * und eine Prüfung, die irgendeine dieser drei Meldungen akzeptiert, sagt
   * nichts über die abgelehnte Eingabe.
   */
  await page.locator('#handoff-password').fill('Falsch#2026Clenaris');
  await page.getByRole('button', { name: 'Gerät übernehmen' }).click();
  await expect(page.locator('form [role="alert"]')).toBeVisible();
  await expect(page).toHaveURL(/\/geraet-uebernehmen$/);

  /**
   * Die Ablehnung kam vom Server, nicht aus der Maske: Der Entsperrversuch
   * antwortete mit 401. Chromium schreibt das in die Konsole; hier wird die
   * Meldung abgeholt und damit zur Zusicherung.
   */
  expect(konsole.erwartet(ressourcenfehler(401)), 'Kein abgelehnter Entsperrversuch beobachtet.').toBeGreaterThan(0);

  await page.locator('#handoff-password').fill(ACCOUNTS.employee.password);
  await page.getByRole('button', { name: 'Gerät übernehmen' }).click();
  await page.waitForURL(/\/portal/, { timeout: 30_000 });
}

// ---------------------------------------------------------------------------
//  § 12, § 21, § 23 — der vollständige Weg, getippt
// ---------------------------------------------------------------------------

test('führt die Abnahme getippt durch: Übergabe, Sperre, Unterschrift, Rückgabe, Entsperren', async ({
  page,
  context,
}) => {
  test.skip(!db, 'Keine Testdatenbank.');
  // Während der Sperre schreibt Chromium jede 423-Antwort in die Konsole. Der
  // Status wird unten ausdrücklich geprüft; die Konsolenzeile ist sein Echo.
  const konsole = konsoleUeberwachen(page, [ressourcenfehler(423)]);
  netzUeberwachen(context);

  const job = await einsatz();
  await imBrowserAnmelden(page, 'employee', /\/portal/);

  const publicId = await geraetUebergeben(page, job.id);
  expect(publicId).toMatch(/^[0-9a-f]{32}$/);

  // — Der Start entscheidet nichts: Der Einsatz ist noch nicht abgenommen.
  expect((await jobLesen(job.id)).customerAcceptedAt).toBeNull();

  // — Der Kundenbildschirm trägt keine Anwendungsnavigation.
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Mitarbeiterbereich|Einsätze|Kalender/ })).toHaveCount(0);

  // — Und der Mitarbeiterbereich ist serverseitig zu, aus derselben Seite heraus.
  expect(await statusAusSeite(page, '/api/jobs')).toBe(423);

  await kundeStimmtZu(page, 'Nicole Wyss');
  await page.getByRole('radio', { name: 'Tippen' }).click();
  await expect(unterzeichnen(page)).toBeEnabled();
  await unterzeichnen(page).click();

  // — Der Text am Ende bittet um das Gerät, verspricht keine E-Mail.
  await expect(page.getByText('Vielen Dank — die Abnahme ist gespeichert')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Bitte geben Sie das Gerät wieder/)).toBeVisible();

  // — Jetzt ist abgenommen; der Einsatz bleibt COMPLETED (kein VERIFIED).
  await expect.poll(async () => Boolean((await jobLesen(job.id)).customerAcceptedAt), { timeout: 20_000 }).toBe(true);
  const nachher = await jobLesen(job.id);
  expect(nachher.status).toBe('COMPLETED');
  expect(nachher.signatureDataUrl).toBeNull();

  // — § 37: Die Unterschrift gibt das Gerät nicht frei.
  expect(await statusAusSeite(page, '/api/jobs')).toBe(423);

  await geraetZurueckgeben(page, konsole);

  // — Der Mitarbeiterbereich ist wieder da, und zwar mit Inhalt.
  await expect(page.getByRole('navigation').first()).toBeVisible();
  expect(await statusAusSeite(page, '/api/jobs')).toBe(200);

  konsole.keineFehler();
});

// ---------------------------------------------------------------------------
//  § 22 — dieselbe Abnahme, gezeichnet
// ---------------------------------------------------------------------------

test('führt die Abnahme gezeichnet durch — echte Mausbewegung auf dem übergebenen Gerät', async ({ page, context }) => {
  test.skip(!db, 'Keine Testdatenbank.');
  const konsole = konsoleUeberwachen(page, [ressourcenfehler(423)]);
  netzUeberwachen(context);

  const job = await einsatz();
  await imBrowserAnmelden(page, 'employee', /\/portal/);
  await geraetUebergeben(page, job.id);

  await kundeStimmtZu(page, 'Nicole Wyss');
  await page.getByRole('radio', { name: 'Zeichnen' }).click();
  await expect(unterzeichnen(page)).toBeDisabled();

  await unterschriftZeichnen(page);
  await expect(unterzeichnen(page)).toBeEnabled();
  await unterzeichnen(page).click();

  await expect(page.getByText('Vielen Dank — die Abnahme ist gespeichert')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => Boolean((await jobLesen(job.id)).customerAcceptedAt), { timeout: 20_000 }).toBe(true);

  const teilnehmer = await db!.signatureParticipant.findFirstOrThrow({
    where: { request: { jobId: job.id }, status: 'SIGNED' },
    select: { signatureMethod: true, signatureArtifactId: true },
  });
  expect(teilnehmer.signatureMethod).toBe('DRAWN');
  expect(teilnehmer.signatureArtifactId).not.toBeNull();

  await geraetZurueckgeben(page, konsole);
  konsole.keineFehler();
});

// ---------------------------------------------------------------------------
//  § 24, § 25 — auf einem Telefonbildschirm, mit dem Finger
// ---------------------------------------------------------------------------

/**
 * `defaultBrowserType` wird ausgelassen: Playwright verlangt für einen
 * Browserwechsel einen eigenen Worker und lehnt ihn innerhalb einer Gruppe ab.
 * Gefahren wird ohnehin Chromium — übernommen werden Bildschirmgrösse,
 * Pixeldichte, Kennung und, worauf es hier ankommt, `hasTouch`.
 */
const { defaultBrowserType: _browsertyp, ...telefon } = devices['Pixel 7'];

test.describe('Auf dem Telefon', () => {
  test.use(telefon);

  test('bleibt die Abnahme auf einem Smartphone-Bildschirm vollständig bedienbar', async ({ page, context }) => {
    test.skip(!db, 'Keine Testdatenbank.');
    const konsole = konsoleUeberwachen(page, [ressourcenfehler(423)]);
    netzUeberwachen(context);

    const job = await einsatz();
    await imBrowserAnmelden(page, 'employee', /\/portal/);
    await geraetUebergeben(page, job.id);

    /**
     * Kein waagrechtes Durcheinander: Der Inhalt passt in die Breite des
     * Geräts. Gemessen wird der Rollbereich des Dokuments, nicht einzelne
     * Kästen — ein Viewer mit eigener Rollfläche darf innen breiter sein.
     */
    const breiten = await page.evaluate(() => ({
      dokument: document.documentElement.scrollWidth,
      sichtfenster: window.innerWidth,
    }));
    expect(
      breiten.dokument,
      `Die Seite ist ${breiten.dokument}px breit bei ${breiten.sichtfenster}px Sichtfenster.`,
    ).toBeLessThanOrEqual(breiten.sichtfenster + 2);

    // — Der Rapport ist lesbar: Das PDF rendert auch hier.
    await expect(page.locator('[data-pdf-viewer] canvas').first()).toBeVisible({ timeout: 30_000 });

    // — Zustimmung, Name und Unterschriftenfeld sind erreichbar, ohne dass
    //   etwas ausserhalb des Bildschirms liegt.
    const zustimmung = page.getByRole('checkbox');
    await zustimmung.scrollIntoViewIfNeeded();
    await expect(zustimmung).toBeInViewport();
    await zustimmung.click();

    await page.locator('#sig-name').fill('Nicole Wyss');

    await page.getByRole('radio', { name: 'Zeichnen' }).click();
    const feld = page.getByRole('img', { name: /Unterschriftenfeld/ });
    await feld.scrollIntoViewIfNeeded();
    await expect(feld).toBeInViewport();

    /**
     * Mit dem Finger, nicht mit der Maus. Was das beweist, steht bei
     * `unterschriftTippen`: echte Touch-Ereignisse aus der Browser-Engine,
     * kein physischer Digitizer.
     */
    await unterschriftTippen(page);
    await expect(unterzeichnen(page)).toBeEnabled();

    const knopf = unterzeichnen(page);
    await knopf.scrollIntoViewIfNeeded();
    await expect(knopf).toBeInViewport();
    await knopf.click();

    await expect(page.getByText('Vielen Dank — die Abnahme ist gespeichert')).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => Boolean((await jobLesen(job.id)).customerAcceptedAt), { timeout: 20_000 }).toBe(true);

    // — Der Rückgabebildschirm ist auf dem Telefon lesbar und bedienbar.
    await page.goto('/geraet-uebernehmen');
    await expect(page.getByRole('heading', { name: 'Zurück zum Mitarbeiterbereich' })).toBeVisible();
    await expect(page.getByText('Abnahme abgeschlossen')).toBeVisible();

    const mobilBreiten = await page.evaluate(() => ({
      dokument: document.documentElement.scrollWidth,
      sichtfenster: window.innerWidth,
    }));
    expect(mobilBreiten.dokument).toBeLessThanOrEqual(mobilBreiten.sichtfenster + 2);

    const feldPasswort = page.locator('#handoff-password');
    await expect(feldPasswort).toBeInViewport();
    await feldPasswort.fill(ACCOUNTS.employee.password);
    await page.getByRole('button', { name: 'Gerät übernehmen' }).click();
    await page.waitForURL(/\/portal/, { timeout: 30_000 });

    expect(await statusAusSeite(page, '/api/jobs')).toBe(200);
    konsole.keineFehler();
  });
});
