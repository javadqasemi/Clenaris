import 'server-only';

import type { Prisma } from '@prisma/client';

import { can } from '@/lib/auth/rbac';
import type { SessionUser } from '@/lib/auth/session';

/**
 * Sichtbarkeit von Objekten je nach Rolle.
 *
 * **Warum das eine eigene Funktion ist.** `property:read` besitzen drei sehr
 * verschiedene Gruppen: das Büro, die Mitarbeitenden und die Kundschaft. Die
 * Berechtigung sagt nur „darf diese Art von Daten sehen" — *welche* Objekte,
 * entscheidet die Beziehung zur Person. Genau diese Unterscheidung fehlte:
 * Die Endpunkte filterten allein nach Mandant, und eine angemeldete Kundin
 * bekam die Objekte aller anderen Kundinnen zurück, samt Schlüsseldepot und
 * Zugangshinweis. Das sind die zwei Angaben, mit denen man in eine fremde
 * Wohnung kommt.
 *
 * Die Einschränkung steht in der `where`-Bedingung und nicht in einer
 * nachgelagerten Prüfung: Ein fremdes Objekt wird gar nicht erst gelesen und
 * die Antwort ist ein 404, das über die Existenz nichts verrät.
 *
 *  • **Büro** (`customer:read`): alle Objekte des Mandanten.
 *  • **Kundschaft**: ausschliesslich die eigenen.
 *  • **Mitarbeitende**: nur Objekte, an denen ein ihnen zugeteilter Einsatz
 *    hängt. Wer den Schlüssel holen muss, sieht wo er liegt — aber nicht die
 *    Schlüsseldepots des ganzen Kundenstamms.
 *
 * Ein Konto ohne verknüpftes Profil bekommt eine Bedingung, die nichts trifft.
 * Das ist bewusst kein Fehler: Die Liste ist dann leer, so wie sie es für
 * dieses Konto auch sein soll.
 */
export function propertyVisibilityWhere(
  session: SessionUser,
  organizationId: string,
): Prisma.PropertyWhereInput {
  const base: Prisma.PropertyWhereInput = { deletedAt: null, customer: { organizationId } };

  if (can(session.role, 'customer:read') && session.role !== 'EMPLOYEE') {
    return base;
  }

  if (session.role === 'CUSTOMER') {
    return { ...base, customerId: session.profileId ?? '__keines__' };
  }

  return {
    ...base,
    jobs: {
      some: {
        deletedAt: null,
        assignments: { some: { employeeId: session.profileId ?? '__keines__' } },
      },
    },
  };
}

/**
 * Darf diese Sitzung Objekte *dieser* Kundschaft anlegen oder ändern?
 *
 * Dieselbe Trennlinie wie beim Lesen, nur enger: Mitarbeitende pflegen keine
 * Objekte, und die Kundschaft nur die eigenen. Die Kunden-ID kommt aus der
 * Anfrage und ist damit nicht vertrauenswürdig — ohne diese Prüfung liesse
 * sich ein Objekt an eine fremde Akte hängen.
 */
export function mayManagePropertyOf(session: SessionUser, customerId: string): boolean {
  if (can(session.role, 'customer:update')) return true;
  return session.role === 'CUSTOMER' && session.profileId === customerId;
}
