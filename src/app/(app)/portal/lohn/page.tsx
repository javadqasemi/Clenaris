import type { Metadata } from 'next';
import { Download, Wallet } from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { requireEmployeeId } from '@/lib/auth/session';
import { formatCurrency, formatNumber } from '@/lib/utils';
import { zuercherJahr } from '@/lib/zuerich';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import { EmptyState, ListCard, PageHeader, TableScroll } from '@/components/app/page-parts';

export const metadata: Metadata = {
  title: 'Lohnabrechnungen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const MONTHS = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
];

/**
 * Lohnabrechnungen.
 *
 * Sichtbar sind nur veröffentlichte Abrechnungen — die Personalabteilung
 * gibt sie nach der Kontrolle frei. Eine Abrechnung, die sich nach dem
 * Ansehen noch ändert, erzeugt mehr Rückfragen als Nutzen.
 */
export default async function PayslipsPage() {
  const { employeeId } = await requireEmployeeId();

  const [payslips, ausweise] = await Promise.all([
    prisma.payslip.findMany({
      where: { employeeId, published: true },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      take: 36,
    }),
    // Nur abgeschlossene Aufstellungen — ein Entwurf kann sich noch ändern.
    prisma.salaryCertificate.findMany({
      where: { employeeId, status: 'FINAL' },
      orderBy: [{ year: 'desc' }, { version: 'desc' }],
      select: { id: true, year: true, version: true },
      take: 10,
    }),
  ]);

  const currentYear = zuercherJahr();
  const yearTotal = payslips
    .filter((slip) => slip.year === currentYear)
    .reduce((sum, slip) => sum + toNumber(slip.grossPay), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Lohnabrechnungen"
        description="Deine freigegebenen Abrechnungen der letzten drei Jahre."
      />

      {payslips.length === 0 ? (
        <EmptyState
          icon={<Wallet aria-hidden />}
          title="Noch keine Abrechnungen"
          description="Sobald die erste Lohnabrechnung freigegeben ist, findest du sie hier."
        />
      ) : (
        <>
          <Alert variant="info">
            Bruttolohn {currentYear}: <strong>{formatCurrency(yearTotal)}</strong>. Den amtlichen
            Lohnausweis für die Steuererklärung stellt der Betrieb aus; die Aufstellung unten ist
            seine Grundlage.
          </Alert>

          <ListCard>
            <TableScroll>
              <table className="data-table">
                <caption className="sr-only">Deine Lohnabrechnungen</caption>
                <thead>
                  <tr>
                    <th scope="col">Periode</th>
                    <th scope="col" className="text-right">
                      Stunden
                    </th>
                    <th scope="col" className="text-right">
                      Brutto
                    </th>
                    <th scope="col" className="text-right">
                      Abzüge
                    </th>
                    <th scope="col" className="text-right">
                      Netto
                    </th>
                    <th scope="col">PDF</th>
                  </tr>
                </thead>
                <tbody>
                  {payslips.map((slip) => {
                    // KTG und Quellensteuer gehören dazu, Spesen kommen
                    // dazu. Fehlte eines davon, ergäbe Brutto minus Abzüge
                    // nicht mehr die ausgewiesene Auszahlung.
                    const deductions =
                      toNumber(slip.ahvIv) +
                      toNumber(slip.alv) +
                      toNumber(slip.bvg) +
                      toNumber(slip.uvg) +
                      toNumber(slip.ktg) +
                      toNumber(slip.withholdingTax) +
                      toNumber(slip.otherDeductions) -
                      toNumber(slip.expenses);

                    return (
                      <tr key={slip.id}>
                        <td className="font-medium">
                          {MONTHS[slip.month - 1]} {slip.year}
                        </td>
                        <td className="num text-muted-foreground">
                          {formatNumber(toNumber(slip.hours), 'de', 1)}
                        </td>
                        <td className="num">{formatCurrency(toNumber(slip.grossPay))}</td>
                        <td className="num text-muted-foreground">
                          − {formatCurrency(deductions)}
                        </td>
                        <td className="num font-semibold">{formatCurrency(toNumber(slip.netPay))}</td>
                        <td>
                          {slip.pdfFileId ? (
                            <Button asChild variant="ghost" size="sm">
                              <a href={`/api/payroll/payslips/${slip.id}/pdf`} download>
                                <Download aria-hidden />
                                Laden
                              </a>
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
          </ListCard>

          <p className="text-sm leading-relaxed text-muted-foreground">
            Die Abzüge umfassen AHV/IV/EO, ALV, Nichtberufsunfall, die berufliche Vorsorge
            (BVG), falls versichert das Krankentaggeld (KTG), gegebenenfalls die Quellensteuer
            und andere Abzüge; Spesen sind verrechnet. Das PDF zeigt jede Zeile. Fragen zur
            Abrechnung beantwortet die Personalverwaltung.
          </p>

          {ausweise.length > 0 ? (
            <ListCard>
              <ul className="divide-y divide-border">
                {ausweise.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                    <span>
                      Lohnausweis-Aufstellung {a.year}
                      {a.version > 1 ? ` (Version ${a.version})` : ''}
                    </span>
                    <Button asChild variant="ghost" size="sm">
                      <a href={`/api/payroll/certificates/${a.id}/pdf`} download>
                        <Download aria-hidden />
                        Laden
                      </a>
                    </Button>
                  </li>
                ))}
              </ul>
            </ListCard>
          ) : null}
        </>
      )}
    </div>
  );
}
