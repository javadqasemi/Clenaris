import 'server-only';

import { prisma } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';

/**
 * Verweise aus dem Anfragekörper gegen die eigene Organisation prüfen.
 *
 * **Warum es diese Datei gibt (Befund B-13, 2026-09-28).** Mehrere Dienste
 * der Unternehmensführung und der Finanzen schrieben Fremdschlüssel — Person,
 * Lieferant, Personalakte, übergeordnetes Ziel, Kennzahl — so in die
 * Datenbank, wie sie im Anfragekörper standen. Aufgehalten hat sie allein der
 * Fremdschlüssel, und der prüft nur, *dass* die Zeile existiert, nicht *wem*
 * sie gehört. Die Folgen waren je Stelle verschieden, aber immer dieselbe
 * Lücke: Eine Ausgabe mit fremdem Lieferanten zeigte in der Liste dessen
 * Namen; eine Massnahme mit fremder Zuständigkeit legte eine Aufgabe für eine
 * Person einer anderen Organisation an und benachrichtigte sie; ein
 * Schlüsselergebnis mit fremder Kennzahl übernahm im Nachtlauf deren
 * Snapshot-Werte — fremde Geschäftszahlen im eigenen Cockpit.
 *
 * **Warum ein gemeinsamer Baustein statt je Dienst eine eigene Abfrage.**
 * Einzelne Dienste prüften bereits (`createObjective` das übergeordnete Ziel,
 * `createKeyResult` die Kennzahl, `createMeeting` das Ziel) — aber jeweils nur
 * auf dem Anlegeweg. Die Änderung daneben war vergessen worden, weil die
 * Prüfung als Zeile im Anlegen stand und beim Ändern niemand nach ihr suchte.
 * Mit einem benannten Aufruf je Verweis fällt eine fehlende Prüfung beim
 * Lesen auf, und die Regel (Organisation, nicht gelöscht) steht einmal.
 *
 * **Warum eine enge Auswahl von Modellen statt eines generischen Delegaten.**
 * Ein `prisma[modell]` mit beliebigem Namen hätte `any` gebraucht und jede
 * Tabelle zugelassen — auch solche ohne `organizationId`, bei denen die
 * Abfrage still an der Spalte scheitert oder, schlimmer, zur Laufzeit etwas
 * anderes filtert. Die Weiche unten kennt je Modell die richtige Bedingung,
 * einschliesslich des Papierkorbs: ein gelöschtes Konto oder Ziel ist für
 * einen neuen Verweis ebenso „nicht vorhanden" wie ein fremdes.
 *
 * **Warum 404 und nicht 422.** „Fremd heisst nicht gefunden" (siehe
 * `tests/api/mandanten.test.ts`): Die Antwort soll nicht verraten, dass die
 * Kennung anderswo gültig wäre. Ein 422 „gehört einer anderen Organisation"
 * wäre genau diese Auskunft.
 *
 * `null` und `undefined` gehen ohne Abfrage durch — einen Verweis zu
 * entfernen oder ihn nicht zu ändern, braucht keine Prüfung.
 */

export type BezugsModell = 'user' | 'supplier' | 'employee' | 'objective' | 'kpiDefinition';

/** Bezeichnung in der Fehlermeldung, wenn der Aufruf keine eigene nennt. */
const STANDARD_BEZEICHNUNG: Record<BezugsModell, string> = {
  user: 'Person',
  supplier: 'Lieferant',
  employee: 'Mitarbeitende Person',
  objective: 'Ziel',
  kpiDefinition: 'Kennzahl',
};

async function vorhanden(modell: BezugsModell, id: string, organizationId: string): Promise<boolean> {
  const select = { id: true } as const;
  switch (modell) {
    case 'user':
      return Boolean(await prisma.user.findFirst({ where: { id, organizationId, deletedAt: null }, select }));
    case 'supplier':
      // Kein Filter auf `active`: Ein stillgelegter Lieferant bleibt ein
      // eigener, und ältere Belege verweisen zu Recht weiter auf ihn.
      return Boolean(await prisma.supplier.findFirst({ where: { id, organizationId }, select }));
    case 'employee':
      return Boolean(await prisma.employee.findFirst({ where: { id, organizationId }, select }));
    case 'objective':
      return Boolean(await prisma.objective.findFirst({ where: { id, organizationId, deletedAt: null }, select }));
    case 'kpiDefinition':
      return Boolean(await prisma.kpiDefinition.findFirst({ where: { id, organizationId }, select }));
  }
}

/**
 * Wirft `NotFoundError`, wenn `id` gesetzt ist und nicht zur Organisation
 * gehört (oder im Papierkorb liegt). Vor dem Schreiben aufrufen, ausserhalb
 * der Transaktion — die Prüfung liest nur und soll keine Sperre halten.
 */
export async function organisationsbezugPruefen(
  modell: BezugsModell,
  id: string | null | undefined,
  organizationId: string,
  bezeichnung: string = STANDARD_BEZEICHNUNG[modell],
): Promise<void> {
  if (!id) return;
  if (!(await vorhanden(modell, id, organizationId))) throw new NotFoundError(bezeichnung);
}
