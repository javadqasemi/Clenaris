import { createHash } from 'node:crypto';

import type { BrowserContext, Page } from '@playwright/test';

import { ACCOUNTS } from '../helpers/accounts';
import { testDb } from '../helpers/testdb';

import { expect, test } from './helpers/basis';
import {
  imBrowserAnmelden,
  konsoleUeberwachen,
  ressourcenfehler,
  statusAusSeite,
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
 * Die Gerätesperre unter Browserbedingungen (§ 13–§ 21).
 *
 * **Was hier geprüft wird und was ausdrücklich nicht.** Dass `GET /api/jobs`
 * während einer Übergabe 423 antwortet, steht in
 * `tests/api/vor-ort-abnahme.test.ts` und wird nicht wiederholt. Diese Datei
 * fragt das, was ein Cookie-Kopf nicht kennt: Zweiter Tab. Zurück-Taste.
 * Vorwärts. Neuladen. Tab geschlossen. Direkt eingetippte Adresse. Gelöschte
 * Cookies. Zweites Gerät.
 *
 * Jeder dieser Wege ist eine Gelegenheit, an einer Sperre vorbeizukommen, die
 * nur im React-Zustand einer einzigen Seite läge. Deshalb endet jeder Fall mit
 * derselben Frage — und zwar an den Server gestellt, nicht an die Maske:
 * **Welchen Status bekommt ein angemeldeter Endpunkt?**
 */

const db = testDb();

let adminJar = '';
let mitarbeiterJar = '';
let stamm: Stammdaten;

const angelegt: string[] = [];

test.beforeAll(async () => {
  adminJar = await frischAnmelden('admin');
  mitarbeiterJar = await frischAnmelden('employee');
  stamm = await stammdatenLesen(adminJar);
});

test.afterEach(async () => {
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

/** Angemeldet, Gerät übergeben, auf dem Kundenbildschirm. */
async function uebergeben(page: Page, jobId: string): Promise<string> {
  await imBrowserAnmelden(page, 'employee', /\/portal/);
  await page.goto(`/portal/einsaetze/${jobId}`);
  await page.getByRole('button', { name: 'Kundenabnahme vorbereiten' }).click();
  await page.waitForURL(/\/abnahme\/[0-9a-f]{32}$/, { timeout: 30_000 });
  return /\/abnahme\/([0-9a-f]{32})$/.exec(page.url())![1]!;
}

/**
 * Die Rotationsfamilie des aktuellen Anmeldecookies — über die Datenbank, nie
 * über den Rohwert.
 */
async function familieVon(context: BrowserContext): Promise<string | null> {
  const keks = (await context.cookies()).find((k) => k.name === 'clenaris_rt');
  if (!keks) return null;
  const treffer = await db!.refreshToken.findUnique({
    where: { tokenHash: createHash('sha256').update(Buffer.from(keks.value)).digest('hex') },
    select: { family: true },
  });
  return treffer?.family ?? null;
}

/**
 * Zeigt diese Seite Mitarbeiterinhalt?
 *
 * Nicht über die Adresse geprüft, sondern über das, was auf dem Bildschirm
 * steht: Die Rückgabeseite **darf** die Einsatznummer nennen (sie erklärt ja,
 * wofür das Gerät übergeben war), aber niemals Rapport, Kundschaft oder
 * Anwendungsnavigation.
 */
async function keinMitarbeiterinhalt(page: Page): Promise<void> {
  await expect(page.getByRole('navigation')).toHaveCount(0);
  const text = await page.locator('body').innerText();
  expect(text, 'Kundendaten auf einer gesperrten Seite.').not.toMatch(/Wyss|Bahnhofstrasse/i);
  expect(text, 'Der Rapport ist auf einer gesperrten Seite sichtbar.').not.toMatch(/Checkliste|Materialverbrauch/i);
}

// ---------------------------------------------------------------------------
//  § 13, § 28 — zweiter Tab im selben Browser
// ---------------------------------------------------------------------------

test('sperrt den zweiten Tab desselben Browsers — serverseitig, nicht nur als Umleitung', async ({ context }) => {
  test.skip(!db, 'Keine Testdatenbank.');

  const job = await einsatz();

  const tabA = await context.newPage();
  const konsoleA = konsoleUeberwachen(tabA, [ressourcenfehler(423)]);

  // Tab B ist vor der Übergabe offen und zeigt den Mitarbeiterbereich — genau
  // die Lage, in der ein liegengelassener Tab gefährlich wäre.
  const tabB = await context.newPage();
  const konsoleB = konsoleUeberwachen(tabB, [ressourcenfehler(423)]);

  await imBrowserAnmelden(tabA, 'employee', /\/portal/);
  await tabB.goto('/portal/einsaetze');
  await expect(tabB.getByRole('navigation').first()).toBeVisible();
  expect(await statusAusSeite(tabB, '/api/jobs')).toBe(200);

  // Jetzt übergibt Tab A das Gerät.
  await tabA.goto(`/portal/einsaetze/${job.id}`);
  await tabA.getByRole('button', { name: 'Kundenabnahme vorbereiten' }).click();
  await tabA.waitForURL(/\/abnahme\/[0-9a-f]{32}$/, { timeout: 30_000 });

  // — Der bestehende Tab B: aktualisieren.
  await tabB.reload();
  await tabB.waitForURL(/\/geraet-uebernehmen$/, { timeout: 30_000 });
  await keinMitarbeiterinhalt(tabB);

  // — Eine andere Mitarbeiteradresse öffnen.
  await tabB.goto('/portal/kalender');
  await tabB.waitForURL(/\/geraet-uebernehmen$/, { timeout: 30_000 });
  await keinMitarbeiterinhalt(tabB);

  /**
   * — Und eine Handlung, die tatsächlich eine Schnittstelle anfasst. Das ist
   * der Punkt aus § 28: „Die Seite hat umgeleitet" wäre kein Beweis. Geprüft
   * wird der Statuscode, lesend wie schreibend.
   */
  expect(await statusAusSeite(tabB, '/api/jobs'), 'Lesender Zugriff aus Tab B').toBe(423);
  expect(await statusAusSeite(tabB, '/api/customers'), 'Kundenliste aus Tab B').toBe(423);
  expect(await statusAusSeite(tabB, `/api/jobs/${job.id}`, 'PATCH'), 'Schreibzugriff aus Tab B').toBe(423);

  konsoleA.keineFehler();
  konsoleB.keineFehler();
});

// ---------------------------------------------------------------------------
//  § 14, § 16 — Zurück, Vorwärts, Neuladen
// ---------------------------------------------------------------------------

test('lässt sich mit Zurück, Vorwärts und Neuladen nicht umgehen', async ({ page, context }) => {
  test.skip(!db, 'Keine Testdatenbank.');
  const konsole = konsoleUeberwachen(page, [ressourcenfehler(423)]);

  const job = await einsatz();
  const publicId = await uebergeben(page, job.id);

  // — Zurück: Der Verlauf führt auf die Einsatzseite, der Server nicht.
  await page.goBack();
  await page.waitForURL(/\/geraet-uebernehmen$/, { timeout: 30_000 });
  await keinMitarbeiterinhalt(page);
  expect(await statusAusSeite(page, '/api/jobs'), 'nach Zurück').toBe(423);

  // — Vorwärts: zurück auf den Kundenbildschirm, der weiterhin gültig ist.
  await page.goForward();
  await expect
    .poll(async () => page.url(), { timeout: 30_000 })
    .toMatch(new RegExp(`/(abnahme/${publicId}|geraet-uebernehmen)$`));

  // Der Kundenbildschirm wird ausdrücklich wieder geöffnet — der Verlauf kann
  // je nach Zwischenspeicher auf der Rückgabeseite stehen bleiben.
  await page.goto(`/abnahme/${publicId}`);
  await expect(page.getByRole('heading', { name: '1. Dokument lesen' })).toBeVisible({ timeout: 30_000 });

  // — Neuladen auf dem Kundenbildschirm: Die Übergabe bleibt dieselbe.
  await page.reload();
  await expect(page.getByRole('heading', { name: '1. Dokument lesen' })).toBeVisible({ timeout: 30_000 });
  expect(page.url()).toContain(`/abnahme/${publicId}`);

  /**
   * § 16: Kein zweiter Vorgang, keine zweite Sperre. Ein Neuladen, das eine
   * neue `DeviceHandoffSession` erzeugte, hinterliesse eine Sperre, die
   * niemand mehr löst.
   */
  expect(await db!.deviceHandoffSession.count({ where: { jobId: job.id } })).toBe(1);
  expect(await db!.signatureRequest.count({ where: { jobId: job.id } })).toBe(1);
  expect(await statusAusSeite(page, '/api/jobs'), 'nach dem Neuladen').toBe(423);

  konsole.keineFehler();
  void context;
});

// ---------------------------------------------------------------------------
//  § 15 — direkt eingetippte Adressen
// ---------------------------------------------------------------------------

test('führt jede direkt eingetippte Mitarbeiteradresse auf die Rückgabeseite', async ({ page }) => {
  test.skip(!db, 'Keine Testdatenbank.');
  const konsole = konsoleUeberwachen(page, [ressourcenfehler(423)]);

  const job = await einsatz();
  await uebergeben(page, job.id);

  for (const adresse of ['/portal', `/portal/einsaetze/${job.id}`, '/portal/profil', '/portal/zeiterfassung']) {
    await page.goto(adresse);
    await page.waitForURL(/\/geraet-uebernehmen$/, { timeout: 30_000 });
    await keinMitarbeiterinhalt(page);
  }

  // Auch der Verwaltungsbereich gibt nichts her — dort fehlt zusätzlich die Rolle.
  await page.goto('/admin');
  expect(page.url(), 'Die Verwaltung wurde gerendert.').not.toMatch(/\/admin$/);

  konsole.keineFehler();
});

// ---------------------------------------------------------------------------
//  § 17 — Tab geschlossen, neuer Tab
// ---------------------------------------------------------------------------

test('bleibt gesperrt, wenn der Übergabe-Tab geschlossen und ein neuer geöffnet wird', async ({ context }) => {
  test.skip(!db, 'Keine Testdatenbank.');

  const job = await einsatz();
  const kundenTab = await context.newPage();
  await uebergeben(kundenTab, job.id);

  // Der Tab mit dem React-Zustand verschwindet vollständig.
  await kundenTab.close();

  const neuerTab = await context.newPage();
  const konsole = konsoleUeberwachen(neuerTab, [ressourcenfehler(423)]);
  await neuerTab.goto('/portal');
  await neuerTab.waitForURL(/\/geraet-uebernehmen$/, { timeout: 30_000 });
  await keinMitarbeiterinhalt(neuerTab);

  /**
   * Damit ist gezeigt, wo die Sicherheit liegt: nicht im Zustand der
   * geschlossenen Seite, sondern in der Datenbank und der Sitzungsfamilie.
   */
  expect(await statusAusSeite(neuerTab, '/api/jobs')).toBe(423);
  expect(await db!.deviceHandoffSession.count({ where: { jobId: job.id, status: 'ACTIVE' } })).toBe(1);

  konsole.keineFehler();
});

// ---------------------------------------------------------------------------
//  § 18 — Clientzustand entfernen
// ---------------------------------------------------------------------------

test('bleibt gesperrt, wenn übergabebezogene Cookies entfernt werden', async ({ page, context }) => {
  test.skip(!db, 'Keine Testdatenbank.');
  const konsole = konsoleUeberwachen(page, [ressourcenfehler(423)]);

  const job = await einsatz();
  await uebergeben(page, job.id);

  const familieVorher = await familieVon(context);
  expect(familieVorher, 'Die Anmeldung hat eine Rotationsfamilie.').not.toBeNull();

  /**
   * Nicht über Seiten-JavaScript: Die Anmeldecookies sind `HttpOnly` und dort
   * grundsätzlich unsichtbar — das ist die Zusicherung, nicht der Prüfgegenstand.
   * Entfernt wird stattdessen über den Cookie-Speicher des Browserkontexts,
   * also so, wie es eine Person über die Entwicklerwerkzeuge könnte:
   *
   *  • `clenaris_sig` — die Signatursitzung des Kundenmodus,
   *  • `clenaris_at` — der Träger des Sperr-Anspruchs im Zugangstoken.
   *
   * Übrig bleibt allein der Refresh-Token. Läge die Sperre nur im Anspruch,
   * käme aus der Erneuerung jetzt ein unbelastetes Zugangstoken zurück.
   */
  const behalten = (await context.cookies()).filter((keks) => keks.name === 'clenaris_rt');
  expect(behalten.length, 'Kein Refresh-Cookie vorhanden.').toBe(1);
  await context.clearCookies();
  await context.addCookies(behalten);

  await page.goto('/portal');
  await page.waitForURL(/\/geraet-uebernehmen$/, { timeout: 30_000 });
  await keinMitarbeiterinhalt(page);

  // Der Server kennt die Übergabe weiterhin — unabhängig vom Clientzustand.
  expect(await statusAusSeite(page, '/api/jobs')).toBe(423);
  expect(await db!.deviceHandoffSession.count({ where: { jobId: job.id, status: 'ACTIVE' } })).toBe(1);

  // Und es ist dieselbe Sitzung geblieben, keine neue Anmeldung.
  expect(await familieVon(context), 'Die Rotationsfamilie hat gewechselt.').toBe(familieVorher);

  konsole.keineFehler();
});

// ---------------------------------------------------------------------------
//  § 19 — zweites Gerät
// ---------------------------------------------------------------------------

test('lässt ein zweites Gerät derselben Person unberührt', async ({ page, browser }) => {
  test.skip(!db, 'Keine Testdatenbank.');
  const konsole = konsoleUeberwachen(page, [ressourcenfehler(423)]);

  const job = await einsatz();

  /**
   * Ein zweiter `BrowserContext` ist ein anderes Gerät: eigener
   * Cookie-Speicher, eigene Anmeldung, eigene Rotationsfamilie. Ein zweiter
   * Tab wäre es ausdrücklich nicht — der Unterschied ist genau die Aussage
   * aus § 32.
   */
  const geraetB = await browser.newContext();
  const seiteB = await geraetB.newPage();
  const konsoleB = konsoleUeberwachen(seiteB);

  try {
    await imBrowserAnmelden(seiteB, 'employee', /\/portal/);
    expect(await statusAusSeite(seiteB, '/api/jobs'), 'Gerät B vor der Übergabe').toBe(200);

    await uebergeben(page, job.id);

    expect(await statusAusSeite(page, '/api/jobs'), 'Gerät A ist gesperrt').toBe(423);

    await seiteB.goto('/portal/einsaetze');
    await expect(seiteB.getByRole('navigation').first()).toBeVisible();
    expect(await statusAusSeite(seiteB, '/api/jobs'), 'Gerät B arbeitet weiter').toBe(200);

    konsoleB.keineFehler();
  } finally {
    await geraetB.close();
  }

  konsole.keineFehler();
});

// ---------------------------------------------------------------------------
//  § 20 — abgelaufene Signatursitzung
// ---------------------------------------------------------------------------

test('gibt das Gerät nicht frei, wenn der Vorgang abläuft', async ({ page }) => {
  test.skip(!db, 'Keine Testdatenbank.');
  const konsole = konsoleUeberwachen(page, [ressourcenfehler(423), ressourcenfehler(404), ressourcenfehler(422)]);

  const job = await einsatz();
  const publicId = await uebergeben(page, job.id);

  /**
   * Ablaufen lassen, ohne zu warten: Die Frist steht als Zeitstempel in der
   * Datenbank, und ein Test, der sie real abwartet, prüft eine Uhr. Gesetzt
   * wird ausschliesslich `expiresAt` — der Zustand bleibt `PENDING`, damit
   * tatsächlich die Frist greift und nicht ein Endzustand.
   */
  await db!.signatureRequest.updateMany({
    where: { jobId: job.id, status: 'PENDING' },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });

  await page.goto(`/abnahme/${publicId}`);

  /**
   * Die Kundschaft versucht abzuschliessen — und zwar über die Maske, nicht
   * über die Schnittstelle.
   *
   * Geprüft wird das **Ergebnis**, nicht die Darstellung: Die Maske zeigt die
   * Schaltfläche weiterhin an, solange der Vorgang `PENDING` ist; sie liest den
   * Ablauf nicht selbst. Das ist keine Sicherheitsaussage, und deshalb steht
   * hier auch keine — entschieden wird auf dem Server, und genau das muss der
   * Fall zeigen.
   */
  const knopf = page.getByRole('button', { name: 'Verbindlich elektronisch unterzeichnen' });
  if (await knopf.isVisible()) {
    await page.getByRole('checkbox').click();
    await page.locator('#sig-name').fill('Nicole Wyss');
    await page.getByRole('radio', { name: 'Tippen' }).click();
    await knopf.click();
    // Der Versuch scheitert sichtbar; ein Erfolgshinweis darf nicht erscheinen.
    await expect(page.getByText('Vielen Dank — die Abnahme ist gespeichert')).toHaveCount(0);
  }

  // Und der Einsatz ist nicht abgenommen.
  await expect
    .poll(
      async () =>
        (await db!.job.findUniqueOrThrow({ where: { id: job.id }, select: { customerAcceptedAt: true } }))
          .customerAcceptedAt,
      { timeout: 10_000 },
    )
    .toBeNull();
  const vorgang = await db!.signatureRequest.findFirstOrThrow({ where: { jobId: job.id } });
  expect(vorgang.status, 'Ein abgelaufener Vorgang wurde abgeschlossen.').not.toBe('COMPLETED');

  /**
   * Der Punkt aus § 20: Ein abgelaufener Vorgang gibt das Gerät **nicht**
   * frei. Sonst zeigte ein liegengelassenes Telefon nach Fristablauf wieder
   * den Mitarbeiterbereich.
   */
  expect(await statusAusSeite(page, '/api/jobs')).toBe(423);

  await page.goto('/portal');
  await page.waitForURL(/\/geraet-uebernehmen$/, { timeout: 30_000 });

  // Freigegeben wird nur mit dem Passwort.
  await page.locator('#handoff-password').fill(ACCOUNTS.employee.password);
  await page.getByRole('button', { name: 'Gerät übernehmen' }).click();
  await page.waitForURL(/\/portal/, { timeout: 30_000 });
  expect(await statusAusSeite(page, '/api/jobs')).toBe(200);

  konsole.keineFehler();
});

// ---------------------------------------------------------------------------
//  § 21 — Entsperren ohne Neuanmeldung
// ---------------------------------------------------------------------------

test('entsperrt mit dem eigenen Passwort und behält dieselbe Sitzung', async ({ page, context }) => {
  test.skip(!db, 'Keine Testdatenbank.');
  const konsole = konsoleUeberwachen(page, [ressourcenfehler(423)]);

  const job = await einsatz();
  await uebergeben(page, job.id);

  const familieVorher = await familieVon(context);
  expect(familieVorher).not.toBeNull();

  await page.goto('/geraet-uebernehmen');
  await page.locator('#handoff-password').fill(ACCOUNTS.employee.password);
  await page.getByRole('button', { name: 'Gerät übernehmen' }).click();
  await page.waitForURL(/\/portal/, { timeout: 30_000 });

  /**
   * Dieselbe Rotationsfamilie: Es gab kein Abmelden und keine zweite
   * Anmeldung, nur eine Bestätigung. Genau das verspricht der Satz unter dem
   * Formular — „Sie bleiben angemeldet".
   */
  expect(await familieVon(context), 'Die Sitzung wurde ersetzt statt bestätigt.').toBe(familieVorher);

  expect(await statusAusSeite(page, '/api/jobs')).toBe(200);
  const sperre = await db!.deviceHandoffSession.findFirstOrThrow({ where: { jobId: job.id } });
  expect(sperre.status).toBe('RELEASED');
  expect(sperre.releasedAt).not.toBeNull();

  konsole.keineFehler();
});
