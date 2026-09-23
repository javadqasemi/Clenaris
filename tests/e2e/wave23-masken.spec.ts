import type { Page } from '@playwright/test';

import { eigeneOrganisationId, schutzfreiAufraeumen, testDb } from '../helpers/testdb';

import { expect, test } from './helpers/basis';
import { imBrowserAnmelden } from './helpers/browser';

/**
 * Wave 23 — zwei Masken, die die Merkmalsprüfung als fehlend gemeldet hat.
 *
 * Beide hatten Endpunkt, Dienst, Berechtigung und HTTP-Tests, aber keine
 * Schaltfläche: die Lohnvereinbarungen einer Person (13. Monatslohn,
 * Entschädigungen) und die Lagerentnahme für einen Einsatz. Die Fachregeln
 * sind in `lohnabrechnung.test.ts` und `betrieb.test.ts` geprüft; hier geht es
 * nur um die Frage, die HTTP nicht beantwortet: **Gibt es die Maske, und
 * schreibt sie?** Geprüft wird gegen die Datenbank, nicht gegen eine Meldung.
 */

const db = testDb();
const SKU = 'PRUEF-E2E-W23';

const genau = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const feld = (scope: Page | ReturnType<Page['getByRole']>, beschriftung: string) =>
  scope.getByLabel(new RegExp(`^${genau(beschriftung)}\\s*\\*?$`));

async function auswaehlen(page: Page, beschriftung: string, option: RegExp): Promise<void> {
  await feld(page.getByRole('dialog'), beschriftung).click();
  await page.getByRole('option', { name: option }).click();
}

/** Prüfmaterial samt Bewegungen, Verbrauchszeilen und Materialaufwand entfernen — wie in `betrieb.test.ts`. */
async function materialAufraeumen(): Promise<void> {
  if (!db) return;
  const materialien = await db.material.findMany({ where: { sku: SKU }, select: { id: true } });
  if (materialien.length === 0) return;
  await schutzfreiAufraeumen(async (tx) => {
    const bewegungen = await tx.stockMovement.findMany({
      where: { materialId: { in: materialien.map((m) => m.id) } },
      select: { id: true, materialUsageId: true, jobId: true },
    });
    for (const b of bewegungen) {
      if (b.materialUsageId && b.jobId) {
        const zeile = await tx.materialUsage.findUnique({ where: { id: b.materialUsageId }, select: { total: true } });
        if (zeile) await tx.job.update({ where: { id: b.jobId }, data: { materialCost: { decrement: zeile.total } } });
      }
    }
    await tx.stockMovement.deleteMany({ where: { id: { in: bewegungen.map((b) => b.id) } } });
    await tx.materialUsage.deleteMany({
      where: { id: { in: bewegungen.map((b) => b.materialUsageId).filter((x): x is string => Boolean(x)) } },
    });
    await tx.material.deleteMany({ where: { id: { in: materialien.map((m) => m.id) } } });
  });
}

test.describe('Masken aus der Merkmalsprüfung (Wave 23)', () => {
  test('Lohnvereinbarungen in der Personalakte setzen', async ({ page }) => {
    test.skip(!db, 'Keine Testdatenbank.');
    /*
      Eine Person ohne unveröffentlichte Abrechnung: Das Speichern markiert
      solche als veraltet, und das Zurücksetzen des Profils am Ende hebt diese
      Markierung nicht auf — sie wäre ein Rest in fremden Reihen.
    */
    const anna = await db!.employee.findFirstOrThrow({
      where: { organizationId: (await eigeneOrganisationId())!, active: true, payslips: { none: { published: false } } },
      orderBy: { employeeNumber: 'asc' },
      select: { id: true },
    });
    const vorher = await db!.employeePayrollProfile.findUnique({ where: { employeeId: anna.id } });

    try {
      await imBrowserAnmelden(page, 'admin', /\/admin/);
      await page.goto(`/admin/personal/${anna.id}`);
      const abschnitt = page.locator('section', { has: page.getByRole('heading', { name: 'Lohnvereinbarungen' }) });
      await abschnitt.getByRole('button', { name: 'Bearbeiten' }).click();

      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await auswaehlen(page, '13. Monatslohn', /^Monatlich 1\/12$/);
      await feld(dialog, 'Feiertagsentschädigung').fill('3.59');
      await dialog.getByRole('button', { name: 'Änderungen speichern' }).click();
      await expect(dialog).toBeHidden({ timeout: 25_000 });

      const nachher = await db!.employeePayrollProfile.findUniqueOrThrow({ where: { employeeId: anna.id } });
      expect(nachher.thirteenthMode).toBe('MONTHLY');
      expect(Number(nachher.holidayPayPct)).toBeCloseTo(3.59, 2);
      await expect(page.getByText('Monatlich 1/12').first()).toBeVisible();
    } finally {
      // Ausgangslage wiederherstellen — andere Reihen rechnen mit Annas Profil.
      if (vorher) {
        await db!.employeePayrollProfile.update({
          where: { employeeId: anna.id },
          data: {
            thirteenthMode: vorher.thirteenthMode,
            thirteenthPayoutMonth: vorher.thirteenthPayoutMonth,
            vacationPayInWage: vorher.vacationPayInWage,
            holidayPayPct: vorher.holidayPayPct,
            note: vorher.note,
          },
        });
      } else {
        await db!.employeePayrollProfile.deleteMany({ where: { employeeId: anna.id } });
      }
    }
  });

  test('Offene Zeiten auf der Lohnseite freigeben', async ({ page }) => {
    test.skip(!db, 'Keine Testdatenbank.');
    const organizationId = (await eigeneOrganisationId())!;
    const person = await db!.employee.findFirstOrThrow({
      where: { organizationId, active: true },
      orderBy: { employeeNumber: 'asc' },
      select: { id: true },
    });
    // Februar 2020: ein Monat, den keine andere Reihe benutzt — die Seite
    // zeigt dann genau diese zwei Zeilen.
    const NOTIZ = 'Prüfreihe W23 Freigabe';
    await db!.timeEntry.deleteMany({ where: { note: NOTIZ } });
    const zeiten = await Promise.all(
      [3, 4].map((tag) =>
        db!.timeEntry.create({
          data: {
            employeeId: person.id,
            startedAt: new Date(Date.UTC(2020, 1, tag, 7)),
            endedAt: new Date(Date.UTC(2020, 1, tag, 11)),
            minutes: 240,
            manual: true,
            note: NOTIZ,
          },
        }),
      ),
    );

    try {
      await imBrowserAnmelden(page, 'admin', /\/admin/);
      await page.goto('/admin/lohn?jahr=2020&monat=2');
      await page.getByRole('button', { name: '2 freigeben', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: '2 freigeben', exact: true }).click();
      await expect(dialog).toBeHidden({ timeout: 25_000 });

      const stand = await db!.timeEntry.findMany({ where: { id: { in: zeiten.map((z) => z.id) } }, select: { approved: true } });
      expect(stand.every((z) => z.approved)).toBe(true);
      await expect(page.getByRole('heading', { name: 'Offene Zeiten' })).toHaveCount(0);
    } finally {
      await db!.timeEntry.deleteMany({ where: { note: NOTIZ } });
    }
  });

  test('Material aus dem Lager für einen Einsatz entnehmen', async ({ page }) => {
    test.skip(!db, 'Keine Testdatenbank.');
    await materialAufraeumen();
    const organizationId = (await eigeneOrganisationId())!;
    const einsatz = await db!.job.findFirstOrThrow({
      where: { organizationId, deletedAt: null, status: 'SCHEDULED', scheduledStart: { gt: new Date() } },
      orderBy: { scheduledStart: 'asc' },
      select: { id: true, materialCost: true },
    });
    const material = await db!.material.create({
      data: { organizationId, sku: SKU, name: 'Prüfreihe Glasreiniger W23', unit: 'l', unitCost: 6.4 },
    });
    await db!.stockMovement.create({
      data: { organizationId, materialId: material.id, kind: 'RECEIPT', quantity: 10, unitCost: 6.4, note: 'Prüfbestand' },
    });

    try {
      await imBrowserAnmelden(page, 'admin', /\/admin/);
      await page.goto(`/admin/einsaetze/${einsatz.id}`);
      await page.getByRole('button', { name: 'Aus dem Lager' }).click();

      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await auswaehlen(page, 'Material', /Prüfreihe Glasreiniger W23/);
      await feld(dialog, 'Menge').fill('2');
      await dialog.getByRole('button', { name: 'Speichern' }).click();
      await expect(dialog).toBeHidden({ timeout: 25_000 });

      const entnahme = await db!.stockMovement.findFirstOrThrow({
        where: { materialId: material.id, kind: 'ISSUE' },
        select: { quantity: true, jobId: true, materialUsageId: true },
      });
      expect(entnahme.jobId).toBe(einsatz.id);
      expect(Number(entnahme.quantity)).toBe(-2);
      expect(entnahme.materialUsageId).toBeTruthy();
      const nachher = await db!.job.findUniqueOrThrow({ where: { id: einsatz.id }, select: { materialCost: true } });
      expect(Number(nachher.materialCost) - Number(einsatz.materialCost)).toBeCloseTo(12.8, 2);
      // Die Zeile muss ohne hartes Neuladen erscheinen — der Editor hielt bis
      // Wave 23 seinen alten Zustand. Der Name steht in einem Eingabefeld,
      // deshalb die Tabellenzeile statt `getByText`.
      await expect(page.getByRole('row', { name: /Prüfreihe Glasreiniger W23/ })).toBeVisible();
    } finally {
      await materialAufraeumen();
    }
  });
});
