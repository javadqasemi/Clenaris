import type { Metadata } from 'next';
import { Download, Wallet } from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { requireEmployeeId } from '@/lib/auth/session';
import { formatCurrency, formatNumber } from '@/lib/utils';
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

  const payslips = await prisma.payslip.findMany({
    where: { employeeId, published: true },
    orderBy: [{ year: 'desc' }, { month: 'desc' }],
    take: 36,
  });

  const currentYear = new Date().getFullYear();
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
          description="Sobald die erste Lohnabrechnung freigegeben ist, findest du sie hier — inklusive PDF zum Herunterladen."
        />
      ) : (
        <>
          <Alert variant="info">
            Bruttolohn {currentYear}: <strong>{formatCurrency(yearTotal)}</strong>. Der
            Lohnausweis für die Steuererklärung kommt jeweils im Januar per Post.
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
                    const deductions =
                      toNumber(slip.ahvIv) +
                      toNumber(slip.alv) +
                      toNumber(slip.bvg) +
                      toNumber(slip.uvg) +
                      toNumber(slip.otherDeductions);

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
                          {slip.pdfUrl ? (
                            <Button asChild variant="ghost" size="sm">
                              <a href={slip.pdfUrl} download>
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
            Die Abzüge umfassen AHV/IV/EO, ALV, Nichtberufsunfall und die berufliche Vorsorge
            (BVG). Fragen zur Abrechnung beantwortet die Betriebsleitung.
          </p>
        </>
      )}
    </div>
  );
}
