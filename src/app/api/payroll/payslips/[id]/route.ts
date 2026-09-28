import { defineRoute, idParam } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { can } from '@/lib/auth/rbac';
import { ForbiddenError } from '@/lib/errors';
import { getOrganizationId } from '@/server/services/organization.service';
import { getPayslip } from '@/server/services/payroll.service';

export const runtime = 'nodejs';

/**
 * GET /api/payroll/payslips/:id — eine Abrechnung samt Herleitung.
 *
 * ---------------------------------------------------------------------------
 *  Zwei Wege hinein, und der Unterschied liegt in der Abfrage
 * ---------------------------------------------------------------------------
 *
 * Wer `payslip:read_all` hat, sieht jede Abrechnung. Wer nur
 * `payslip:read_own` hat, sieht die eigene — und zwar nur, wenn sie
 * **veröffentlicht** ist.
 *
 * Beides steht in der Prisma-`where`-Klausel und nicht in einer Prüfung
 * danach: Ausgeblendetes HTML ist im Netzwerkprotokoll trotzdem sichtbar, und
 * eine fremde Abrechnung, die erst geladen und dann verworfen wird, war
 * bereits im Speicher. Das ist die Regel aus `CLAUDE.md` — Eigentümerschaft
 * gehört in die Abfrage.
 *
 * ---------------------------------------------------------------------------
 *  Warum eine unveröffentlichte Abrechnung für die eigene Person nicht
 *  existiert
 * ---------------------------------------------------------------------------
 *
 * Sie ist ein Entwurf und kann sich noch ändern — ein Nachlauf nach einer
 * spät freigegebenen Zeit schreibt sie neu. Eine Zahl, die sich ändert,
 * nachdem jemand sie gesehen hat, ist schlimmer als keine Zahl.
 *
 * ---------------------------------------------------------------------------
 *  Die Herleitung
 * ---------------------------------------------------------------------------
 *
 * `breakdown` enthält die angewandten Sätze, den koordinierten Jahreslohn und
 * den BVG-Altersband-Satz — als Momentaufnahme. Das ist der eigentliche Zweck
 * dieses Endpunkts: Eine Lohnabrechnung, bei der sich der BVG-Abzug nicht
 * nachrechnen lässt, erzeugt genau eine Rückfrage je Monat und je Person.
 */
export const GET = defineRoute({
  permissions: ['payslip:read_own'],
  anyPermission: true,
  params: idParam,
  rateLimit: 'apiRead',
  handler: async ({ params, session }) => {
    const alle = can(session.role, 'payslip:read_all');

    if (!alle && !session.profileId) {
      throw new ForbiddenError('Für Ihr Konto ist kein Mitarbeitendenprofil hinterlegt.');
    }

    return ok(
      await getPayslip({
        organizationId: await getOrganizationId(),
        payslipId: params.id,
        ...(alle ? {} : { employeeId: session.profileId! }),
      }),
    );
  },
});
