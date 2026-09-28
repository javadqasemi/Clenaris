import type { Page } from '@playwright/test';

import { eigeneOrganisationId, schutzfreiAufraeumen, testDb } from '../helpers/testdb';

import { expect, test } from './helpers/basis';
import { imBrowserAnmelden } from './helpers/browser';

/**
 * Produktsprint 2026-09-26 — die sechs Abläufe aus dem Auftrag im echten
 * Browser.
 *
 *   A  Kopfzeilensuche: live, ohne Enter, alte Anfrage abgebrochen, Treffer öffnet die Seite
 *   B  Profil → Einstellungen führt zu den *persönlichen* Einstellungen
 *   C  Update Center: freigeben, terminieren, stornieren — nichts wird ausgeführt
 *   D  Buchung mit Büro- und Fensterreinigung, Admin sieht beide
 *   E  Gewählte Uhrzeit wird ungültig, wenn eine Leistung dazukommt
 *   F  Einsatzzeit 18:00–22:00: nur Anfangszeiten, zu denen alles hineinpasst
 *
 * Die Fachregeln prüfen `mehrere-leistungen.test.ts`,
 * `verfuegbarkeit-rechenkern.test.ts`, `release-center.test.ts`,
 * `suche.test.ts` und `settings.test.ts` über HTTP. Hier geht es um die
 * Frage, die HTTP nicht beantwortet: Kommt es im Browser so an?
 */

const db = testDb();
const RUN = Date.now();

// ---------------------------------------------------------------------------
//  A — Kopfzeilensuche
// ---------------------------------------------------------------------------

test.describe('A — Suche in der Kopfzeile', () => {
  test('Live-Treffer ohne Enter, veraltete Anfrage abgebrochen, Treffer öffnet die Akte', async ({ page }) => {
    test.skip(!db, 'Keine Testdatenbank.');
    const kunde = await db!.customer.findFirstOrThrow({
      where: { organizationId: (await eigeneOrganisationId())!, deletedAt: null, companyName: null, lastName: { not: '' } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, lastName: true },
    });
    const begriff = kunde.lastName;
    const praefix = begriff.slice(0, 2);

    // Die Anfrage für das Präfix wird künstlich verzögert: Käme ihre Antwort
    // nach der für den vollen Begriff an und würde übernommen, stünde am Ende
    // die falsche Liste da.
    const abgebrochen: string[] = [];
    page.on('requestfailed', (r) => {
      if (r.url().includes('/api/search')) abgebrochen.push(new URL(r.url()).searchParams.get('q') ?? '');
    });
    await page.route('**/api/search?**', async (route) => {
      const q = new URL(route.request().url()).searchParams.get('q');
      if (q === praefix) await new Promise((r) => setTimeout(r, 1_500));
      await route.continue().catch(() => undefined);
    });

    await imBrowserAnmelden(page, 'admin', /\/admin/);

    // Die Suche steht in der Kopfzeile, nicht mehr in der Seitenleiste.
    const navigation = page.getByRole('navigation', { name: 'Bereichsnavigation' }).first();
    await expect(navigation.getByRole('link', { name: 'Suche', exact: true })).toHaveCount(0);
    const feld = page.getByRole('banner').getByRole('combobox');
    await expect(feld).toBeVisible();

    // Strg+K führt ins Feld.
    await page.keyboard.press('Control+k');
    await expect(feld).toBeFocused();

    await feld.pressSequentially(praefix, { delay: 30 });
    await page.waitForTimeout(400); // Entprellung abwarten — die Präfix-Anfrage läuft jetzt.
    await feld.pressSequentially(begriff.slice(2), { delay: 30 });

    const liste = page.getByRole('listbox', { name: 'Suchergebnisse' });
    const option = liste.getByRole('option', { name: new RegExp(begriff) }).first();
    await expect(option).toBeVisible({ timeout: 10_000 });
    await expect(feld).toHaveAttribute('aria-expanded', 'true');

    // Die verzögerte Antwort ist inzwischen fällig — sie darf nichts ändern.
    await page.waitForTimeout(1_800);
    await expect(option).toBeVisible();
    expect(abgebrochen, 'die Präfix-Anfrage wurde nicht abgebrochen').toContain(praefix);

    // Hervorhebung und Tastatur: Pfeil runter markiert eine Option.
    await expect(liste.locator('mark').first()).toBeVisible();
    await feld.press('ArrowDown');
    await expect(feld).toHaveAttribute('aria-activedescendant', /option-0$/);

    // Escape schliesst die Liste.
    await feld.press('Escape');
    await expect(liste).toBeHidden();

    // Pfeil runter öffnet die Liste wieder (Combobox-Muster), ein Klick ins
    // Feld ebenso — das Feld hat nach Escape noch den Fokus.
    await feld.press('ArrowDown');
    await expect(option).toBeVisible();
    await feld.press('Escape');
    await expect(liste).toBeHidden();
    await feld.click();
    await expect(option).toBeVisible();
    await option.click();
    await page.waitForURL(new RegExp(`/admin/kunden/${kunde.id}$`));
  });
});

// ---------------------------------------------------------------------------
//  B — Persönliche Einstellungen
// ---------------------------------------------------------------------------

test.describe('B — Profil → Einstellungen', () => {
  test('Mitarbeitende: der Reiter führt zu den persönlichen Einstellungen', async ({ page }) => {
    await imBrowserAnmelden(page, 'employee', /\/portal/);
    await page.goto('/portal/profil');
    await page.getByRole('navigation', { name: 'Kontobereich' }).getByRole('link', { name: 'Einstellungen' }).click();
    await page.waitForURL(/\/portal\/profil\/einstellungen$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Persönliche Einstellungen' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Passwort ändern' })).toBeVisible();
  });

  test('Administration: „Einstellungen" im Kontomenü ist nicht mehr die Firmenkonfiguration', async ({ page }) => {
    await imBrowserAnmelden(page, 'admin', /\/admin/);
    await page.getByRole('button', { name: 'Konto-Menü öffnen' }).click();
    // Seit 2026-09-28 heisst der Eintrag „Persönliche Einstellungen" (L-19).
    await page.getByRole('menuitem', { name: 'Persönliche Einstellungen', exact: true }).click();
    await page.waitForURL(/\/admin\/profil\/einstellungen$/);
    expect(new URL(page.url()).pathname).not.toBe('/admin/einstellungen');
    await expect(page.getByRole('heading', { level: 1, name: 'Persönliche Einstellungen' })).toBeVisible();
    // Keine Register der Betriebseinstellungen auf dieser Seite (die
    // Seitenleiste nennt „Einstellungen" unter „Betrieb" weiterhin — sie ist
    // der richtige Weg dorthin).
    await expect(page.getByRole('main').locator('a[href*="/admin/einstellungen"]')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
//  C — Update Center
// ---------------------------------------------------------------------------

test.describe('C — Update Center', () => {
  const VERSION = `9.${RUN % 1_000_000}.1`;

  async function aufraeumen() {
    const r = await db?.release.findUnique({ where: { version: VERSION }, select: { id: true } });
    if (!r) return;
    await db!.releaseDeferral.deleteMany({ where: { releaseId: r.id } });
    await db!.releaseRequest.deleteMany({ where: { releaseId: r.id } });
    await db!.release.delete({ where: { id: r.id } });
  }

  test('verfügbare Version → Details → freigeben → terminieren → stornieren', async ({ page }) => {
    test.skip(!db, 'Keine Testdatenbank.');
    await aufraeumen();
    await db!.release.create({
      data: {
        version: VERSION,
        releasedAt: new Date(),
        kind: 'MINOR',
        summary: 'Browserprüfung des Update Centers — Freigabe ohne Ausführung.',
        features: ['Neue Suche in der Kopfzeile'],
        fixes: ['Einsatzzeiten im Buchungskalender'],
        ciStatus: 'PASSED',
        expectedDowntimeMinutes: 0,
      },
    });

    try {
      await imBrowserAnmelden(page, 'super', /\/admin/);
      await expect(page.getByText('Eine neue Clenaris-Version ist verfügbar')).toBeVisible();
      await page.goto('/admin/updates');
      await page.getByRole('link', { name: new RegExp(`v${VERSION.replace(/\./g, '\\.')}`) }).click();
      await expect(page.getByRole('heading', { level: 1, name: `Clenaris v${VERSION}` })).toBeVisible();
      await expect(page.getByText('Neue Suche in der Kopfzeile')).toBeVisible();

      await page.getByRole('button', { name: 'Freigeben' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Freigeben' }).click();
      await expect(page.getByText('Freigegeben', { exact: true }).first()).toBeVisible();

      await page.getByRole('button', { name: 'Terminieren' }).click();
      const dialog = page.getByRole('dialog');
      const morgen = new Date(Date.now() + 2 * 86_400_000);
      const lokal = `${morgen.getFullYear()}-${String(morgen.getMonth() + 1).padStart(2, '0')}-${String(morgen.getDate()).padStart(2, '0')}T22:30`;
      await dialog.getByLabel(/Zeitpunkt/).fill(lokal);
      await dialog.getByRole('button', { name: 'Termin setzen' }).click();
      await expect(dialog).toBeHidden({ timeout: 15_000 });
      await expect(page.getByText('Terminiert', { exact: true }).first()).toBeVisible();

      await page.getByRole('button', { name: 'Termin stornieren' }).click();
      const storno = page.getByRole('dialog');
      await storno.getByLabel(/Grund/).fill('Browserprüfung');
      await storno.getByRole('button', { name: 'Termin stornieren' }).click();
      await expect(storno).toBeHidden({ timeout: 15_000 });
      await expect(page.getByText('Update verfügbar', { exact: true }).first()).toBeVisible();

      // Die Datenbank sagt dasselbe: ein stornierter Auftrag, keiner offen,
      // und kein Zustand, der eine Ausführung behauptet.
      const auftraege = await db!.releaseRequest.findMany({ where: { release: { version: VERSION } } });
      expect(auftraege.map((a) => a.status)).toEqual(['CANCELLED']);
    } finally {
      await aufraeumen();
    }
  });
});

// ---------------------------------------------------------------------------
//  D, E, F — Buchung mit mehreren Leistungen im Einsatzfenster 18:00–22:00
// ---------------------------------------------------------------------------

test.describe('D/E/F — mehrere Leistungen und Einsatzzeiten', () => {
  test.describe.configure({ mode: 'serial' });

  const S = { buero: '', fenster: '' };
  const namen = { buero: `E2E Büroreinigung ${RUN}`, fenster: `E2E Fensterreinigung ${RUN}` };
  let wochentag = 0;
  let tage: string[] = [];
  let zeilenVorher: { weekday: number; serviceOpensAt: string | null; serviceClosesAt: string | null; serviceClosed: boolean }[] = [];
  const verfuegbarkeitsIds: string[] = [];

  test.beforeAll(async () => {
    if (!db) return;
    const org = (await eigeneOrganisationId())!;
    const anlegen = async (name: string, slug: string, minuten: number) =>
      (
        await db.service.create({
          data: {
            organizationId: org,
            slug: `${slug}-${RUN}`,
            kind: 'SPECIAL',
            name,
            shortDesc: 'Browserprüfung',
            description: 'Nur für die Browserprüfung.',
            pricingModel: 'PER_HOUR',
            hourlyRate: 60,
            minHours: minuten / 60,
            defaultDurationMin: minuten,
            minutesPerSqm: 0,
            defaultCrewSize: 1,
            bufferMinutes: 0,
            position: -1,
          },
        })
      ).id;
    S.buero = await anlegen(namen.buero, 'e2e-buero', 120);
    S.fenster = await anlegen(namen.fenster, 'e2e-fenster', 60);

    // Ein Werktag, der in den nächsten drei Wochen mindestens zweimal vorkommt
    // und dessen nächste Vorkommen keine Feiertage sind.
    const feiertage = await db.holiday.findMany({ where: { organizationId: org } });
    const istFeiertag = (d: string) =>
      feiertage.some((f) => {
        const x = f.date.toISOString().slice(0, 10);
        return x === d || (f.recurring && x.slice(5) === d.slice(5));
      });
    for (const wt of [2, 3, 4, 1, 5]) {
      const kandidaten: string[] = [];
      for (let offset = 3; offset <= 21; offset += 1) {
        const d = new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
        if (new Date(`${d}T12:00:00Z`).getUTCDay() === wt && !istFeiertag(d)) kandidaten.push(d);
      }
      if (kandidaten.length >= 2) {
        wochentag = wt;
        tage = kandidaten;
        break;
      }
    }

    zeilenVorher = await db.openingHours.findMany({
      where: { organizationId: org },
      select: { weekday: true, serviceOpensAt: true, serviceClosesAt: true, serviceClosed: true },
    });
    await db.openingHours.updateMany({
      where: { organizationId: org, weekday: wochentag },
      data: { serviceOpensAt: '18:00', serviceClosesAt: '22:00', serviceClosed: false },
    });

    const personal = await db.employee.findMany({
      where: { organizationId: org, active: true, user: { role: 'EMPLOYEE', deletedAt: null } },
      orderBy: { employeeNumber: 'asc' },
      take: 2,
      select: { id: true },
    });
    for (const p of personal) {
      verfuegbarkeitsIds.push(
        (await db.availability.create({ data: { employeeId: p.id, weekday: wochentag, startTime: '18:00', endTime: '22:00' } })).id,
      );
    }
  });

  test.afterAll(async () => {
    if (!db) return;
    const org = (await eigeneOrganisationId())!;
    for (const z of zeilenVorher) {
      await db.openingHours.updateMany({
        where: { organizationId: org, weekday: z.weekday },
        data: { serviceOpensAt: z.serviceOpensAt, serviceClosesAt: z.serviceClosesAt, serviceClosed: z.serviceClosed },
      });
    }
    const ids = Object.values(S).filter(Boolean);
    await schutzfreiAufraeumen(async (tx) => {
      const buchungen = (await tx.booking.findMany({ where: { items: { some: { serviceId: { in: ids } } } }, select: { id: true } })).map((b) => b.id);
      const jobs = (await tx.job.findMany({ where: { bookingId: { in: buchungen } }, select: { id: true } })).map((j) => j.id);
      await tx.jobChecklistItem.deleteMany({ where: { jobId: { in: jobs } } });
      await tx.job.deleteMany({ where: { id: { in: jobs } } });
      await tx.bookingItem.deleteMany({ where: { bookingId: { in: buchungen } } });
      await tx.bookingExtra.deleteMany({ where: { bookingId: { in: buchungen } } });
      await tx.booking.deleteMany({ where: { id: { in: buchungen } } });
      await tx.availability.deleteMany({ where: { id: { in: verfuegbarkeitsIds } } });
      await tx.service.deleteMany({ where: { id: { in: ids } } });
    });
  });

  const karte = (page: Page, name: string) => page.getByRole('checkbox', { name: new RegExp(name) });

  async function bisZumTermin(page: Page, leistungen: string[]) {
    await page.goto('/buchen');
    for (const name of leistungen) await karte(page, name).click();
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.locator('#sqm').fill('120');
    await page.getByRole('button', { name: 'Weiter' }).click(); // Objekt → Zusätze
    await page.getByRole('button', { name: 'Weiter' }).click(); // Zusätze → Termin
  }

  const freieZeiten = (page: Page) =>
    page.getByRole('group', { name: 'Freie Startzeiten' }).getByRole('button').allInnerTexts();

  test('D + F — Büro und Fenster im Fenster 18:00–22:00 buchen; die Administration sieht beide', async ({ page, browser }) => {
    test.skip(!db || !tage.length, 'Keine Testdatenbank oder kein passender Werktag.');

    await page.goto('/buchen');
    await karte(page, namen.buero).click();
    await karte(page, namen.fenster).click();
    await expect(karte(page, namen.buero)).toHaveAttribute('aria-checked', 'true');
    await expect(karte(page, namen.fenster)).toHaveAttribute('aria-checked', 'true');
    const zusammenfassung = page.getByRole('region', { name: 'Ihre Leistungen' });
    await expect(zusammenfassung.getByText(namen.buero)).toBeVisible();
    await expect(zusammenfassung.getByText(namen.fenster)).toBeVisible();

    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.locator('#sqm').fill('120');
    // Preis und Dauer vom Server: 2 h + 1 h.
    await expect(page.getByText(/Gesamtdauer ca\. 3/)).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.getByRole('button', { name: 'Weiter' }).click();

    // F: Der Tag mit Abendeinsätzen bietet genau die Anfangszeiten, zu denen
    // drei Stunden bis 22:00 passen.
    await page.locator(`[data-datum="${tage[0]}"]`).click();
    await expect.poll(() => freieZeiten(page)).toEqual(['18:00', '18:30', '19:00']);

    await page.getByRole('group', { name: 'Freie Startzeiten' }).getByRole('button', { name: '19:00' }).click();
    await page.getByRole('button', { name: 'Weiter' }).click();

    const email = `e2e.mehrfach.${RUN}@example.ch`;
    await page.locator('#firstName').fill('Emma');
    await page.locator('#lastName').fill(`Prüfung${RUN}`);
    await page.locator('#email').fill(email);
    await page.locator('#phone').fill('079 123 45 67');
    await page.locator('#street').fill('Bundesgasse');
    await page.locator('#streetNo').fill('5');
    await page.locator('#postalCode').fill('3011');
    await page.locator('#city').fill('Bern');
    await page.getByRole('button', { name: 'Weiter' }).click();

    await expect(page.getByText(namen.buero).first()).toBeVisible();
    await expect(page.getByText(namen.fenster).first()).toBeVisible();
    await page.locator('#terms').click();
    await page.getByRole('button', { name: 'Kostenpflichtig buchen' }).click();
    await page.waitForURL(/\/buchen\/bestaetigt/, { timeout: 30_000 });

    const buchung = await db!.booking.findFirstOrThrow({
      where: { customer: { email } },
      include: { items: true },
    });
    expect(new Set(buchung.items.map((i) => i.serviceId))).toEqual(new Set([S.buero, S.fenster]));
    expect(buchung.durationMin).toBe(180);

    // Die Administration sieht beide Leistungen — in einem eigenen Browserkontext.
    const buero = await browser.newContext();
    const adminSeite = await buero.newPage();
    try {
      await imBrowserAnmelden(adminSeite, 'admin', /\/admin/);
      await adminSeite.goto(`/admin/buchungen/${buchung.id}`);
      await expect(adminSeite.getByText(namen.buero).first()).toBeVisible();
      await expect(adminSeite.getByText(namen.fenster).first()).toBeVisible();
      await expect(adminSeite.getByText('[object Object]')).toHaveCount(0);
    } finally {
      await buero.close();
    }
  });

  test('E — eine gewählte Uhrzeit wird verworfen, wenn eine Leistung dazukommt', async ({ page }) => {
    test.skip(!db || tage.length < 2, 'Keine Testdatenbank oder kein passender Werktag.');

    await bisZumTermin(page, [namen.buero]);
    await page.locator(`[data-datum="${tage[1]}"]`).click();
    await expect.poll(() => freieZeiten(page)).toEqual(['18:00', '18:30', '19:00', '19:30', '20:00']);
    await page.getByRole('group', { name: 'Freie Startzeiten' }).getByRole('button', { name: '20:00' }).click();

    // Zurück zur Leistung, Fensterreinigung dazu.
    for (let i = 0; i < 3; i += 1) await page.getByRole('button', { name: 'Zurück' }).click();
    await karte(page, namen.fenster).click();
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.getByRole('button', { name: 'Weiter' }).click();

    await expect(page.getByText(/Die Verfügbarkeit wurde aufgrund Ihrer geänderten Leistungen aktualisiert/)).toBeVisible({ timeout: 15_000 });
    await page.locator(`[data-datum="${tage[1]}"]`).click();
    await expect.poll(() => freieZeiten(page)).toEqual(['18:00', '18:30', '19:00']);
    // „Weiter" ist gesperrt, bis eine neue gültige Zeit gewählt ist.
    await expect(page.getByRole('button', { name: 'Weiter' })).toBeDisabled();
    await page.getByRole('group', { name: 'Freie Startzeiten' }).getByRole('button', { name: '19:00' }).click();
    await expect(page.getByRole('button', { name: 'Weiter' })).toBeEnabled();
  });
});
