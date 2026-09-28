import 'server-only';

import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';

/**
 * Eine berechnete, noch nicht veröffentlichte Abrechnung, deren Grundlagen
 * sich seither geändert haben.
 *
 * **Warum es das braucht.** Die Abrechnung ist eine Momentaufnahme: Zeilen,
 * Beträge und das PDF entstehen aus dem Stand beim Lauf. Wird danach eine
 * Lohnposition erfasst, eine Satzversion geändert oder die Vereinbarung zum
 * 13. Monatslohn angepasst, stimmt die gespeicherte Zahl nicht mehr mit den
 * Grundlagen überein. Ohne Markierung würde sie trotzdem veröffentlicht — mit
 * der alten Zahl, und die neue Position hinge an keiner Abrechnung.
 *
 * Markiert wird über die Prüfung (`reviewRequired`), mit einem festen
 * Anfang des Grundes. `resolvePayslipReview` lehnt genau diesen Grund ab:
 * Eine veraltete Zahl wird nicht „freigegeben", sondern neu gerechnet. Der
 * nächste Lauf setzt die Markierung zurück.
 *
 * Eigenes Modul, weil Satz-, Stamm- und Lohndienst es brauchen und der
 * Lohndienst die beiden anderen importiert.
 */
export const VERALTET_PRAEFIX = 'Grundlagen seit der Berechnung geändert';

/**
 * Für bestimmte Monate einer Person — Zeitfreigaben und Abwesenheiten
 * betreffen genau die Monate, in denen sie liegen.
 */
export async function markiereMonateVeraltet(
  eintraege: { employeeId: string; year: number; month: number }[],
  anlass: string,
): Promise<number> {
  const eindeutig = [...new Map(eintraege.map((e) => [`${e.employeeId}:${e.year}:${e.month}`, e])).values()];
  if (eindeutig.length === 0) return 0;
  return markiereVeraltet({ OR: eindeutig.map((e) => ({ employeeId: e.employeeId, year: e.year, month: e.month })) }, anlass);
}

/** Kalendermonate zwischen zwei Kalendertagen (`@db.Date`), einschliesslich. */
export function monateZwischen(von: Date, bis: Date): { year: number; month: number }[] {
  const monate: { year: number; month: number }[] = [];
  let jahr = von.getUTCFullYear();
  let monat = von.getUTCMonth() + 1;
  const ende = bis.getUTCFullYear() * 12 + bis.getUTCMonth() + 1;
  while (jahr * 12 + monat <= ende && monate.length < 36) {
    monate.push({ year: jahr, month: monat });
    monat += 1;
    if (monat > 12) {
      monat = 1;
      jahr += 1;
    }
  }
  return monate;
}

export async function markiereVeraltet(
  where: Prisma.PayslipWhereInput,
  anlass: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<number> {
  const treffer = await client.payslip.updateMany({
    where: { ...where, published: false },
    data: {
      reviewRequired: true,
      reviewReason: `${VERALTET_PRAEFIX} (${anlass}) — bitte den Monat neu rechnen.`,
      reviewResolvedAt: null,
      reviewResolvedById: null,
      reviewNote: null,
    },
  });
  return treffer.count;
}
