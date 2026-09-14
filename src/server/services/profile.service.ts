import 'server-only';

import type { Prisma, UserRole } from '@prisma/client';

import type { Tx } from '@/lib/db';

import { nextNumber } from './numbering.service';

/**
 * Konto und Profil zusammenhalten.
 *
 * **Das Problem, das dieses Modul löst.** Ein Konto (`User`) trägt die Rolle;
 * die Personalakte (`Employee`) und der Kundendatensatz (`Customer`) hängen
 * daran. Bis zum 14. September 2026 bestimmte die Anwendung „wer ist
 * Personal" ausschliesslich über `Employee.active` — die Rolle spielte keine
 * Rolle. Wurde ein Konto auf Kundschaft umgestellt, blieb die Personalakte
 * aktiv, und die Person stand weiter in der Teamauswahl, im Kalender, in den
 * Kennzahlen zur Auslastung und auf der öffentlichen Team-Seite. Umgekehrt
 * wählte die Sitzung das Profil nach „Kundendatensatz, sonst Personalakte",
 * nicht nach Rolle: Wer beides hatte, war als Mitarbeitende mit einer
 * Kunden-ID unterwegs.
 *
 * Zwei Regeln, beide hier und nirgends sonst:
 *
 *  1. **Personal ist, wer eine aktive Personalakte *und* eine Personalrolle
 *     hat** (`activeStaffWhere`). Jede Abfrage, die Personal auflistet, zählt
 *     oder zuteilt, nimmt dieses Fragment — nicht `active: true` von Hand.
 *  2. **Ein Konto mit Rolle Kundschaft hat einen Kundendatensatz**
 *     (`ensureCustomerProfile`). Ohne ihn hätte die Person im Kundenbereich
 *     „kein Kundenprofil verknüpft" und könnte nichts tun.
 */

/** Kontorollen, die als Personal gelten — alles ausser Kundschaft. */
export const STAFF_ROLES: UserRole[] = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EMPLOYEE'];

/**
 * Where-Fragment „aktives Personal" für `Employee`-Abfragen.
 *
 * Ein gelöschtes Konto (`deletedAt`) zählt nicht mehr, ein gesperrtes schon:
 * Sperren ist ein vorübergehender Zugangsentzug, kein Austritt — die Person
 * bleibt im Plan, bis die Personalakte stillgelegt wird.
 */
export function activeStaffWhere(organizationId: string): Prisma.EmployeeWhereInput {
  return {
    organizationId,
    active: true,
    user: { role: { in: STAFF_ROLES }, deletedAt: null },
  };
}

/**
 * Kundendatensatz zu einem Konto sicherstellen; liefert dessen ID.
 *
 * Hängt bereits einer am Konto, ist nichts zu tun. Gibt es unter derselben
 * Adresse einen Kundendatensatz ohne Konto — etwa aus einer Buchung als
 * Gast, bevor die Person je ein Konto hatte —, wird der verknüpft statt ein
 * zweiter angelegt: Sonst hätte dieselbe Person zwei Kundennummern und die
 * Buchungshistorie wäre geteilt. Erst wenn beides fehlt, entsteht ein neuer
 * Datensatz mit der nächsten Nummer.
 */
export async function ensureCustomerProfile(
  tx: Tx,
  params: { organizationId: string; userId: string },
): Promise<string> {
  const user = await tx.user.findUniqueOrThrow({
    where: { id: params.userId },
    select: {
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      locale: true,
      customer: { select: { id: true } },
    },
  });
  if (user.customer) return user.customer.id;

  const orphan = await tx.customer.findFirst({
    where: {
      organizationId: params.organizationId,
      email: user.email,
      userId: null,
      deletedAt: null,
    },
    select: { id: true },
  });
  if (orphan) {
    await tx.customer.update({ where: { id: orphan.id }, data: { userId: params.userId } });
    return orphan.id;
  }

  const { number } = await nextNumber(tx, params.organizationId, 'customer');
  const created = await tx.customer.create({
    data: {
      organizationId: params.organizationId,
      number,
      userId: params.userId,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
      language: user.locale,
    },
    select: { id: true },
  });
  return created.id;
}
