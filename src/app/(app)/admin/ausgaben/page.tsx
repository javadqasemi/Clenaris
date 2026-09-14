import type { Metadata } from 'next';
import { Wallet } from 'lucide-react';

import { prisma, toNumber } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { formatCurrency, formatDate, toQueryString } from '@/lib/utils';
import { getOrganizationId } from '@/server/services/organization.service';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTriggerUnderline } from '@/components/ui/controls';
import { KpiTile } from '@/components/app/kpi-tile';
import { FilterBar } from '@/components/app/filter-bar';
import {
  DetailSection,
  EmptyState,
  ListCard,
  PageHeader,
  Pagination,
  TableScroll,
} from '@/components/app/page-parts';
import { ExpenseDialog } from '@/features/admin/expense-dialog';
import { ExpenseRowActions } from '@/features/admin/expense-row-actions';
import { SupplierCreateButton, SupplierList } from '@/features/admin/supplier-manager';

export const metadata: Metadata = {
  title: 'Ausgaben',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const CATEGORY_LABELS: Record<string, string> = {
  MATERIAL: 'Material',
  EQUIPMENT: 'Geräte',
  VEHICLE: 'Fahrzeuge',
  FUEL: 'Treibstoff',
  INSURANCE: 'Versicherungen',
  RENT: 'Miete',
  SALARY: 'Löhne',
  SOCIAL_SECURITY: 'Sozialversicherungen',
  MARKETING: 'Marketing',
  SOFTWARE: 'Software',
  TRAINING: 'Weiterbildung',
  TAXES: 'Steuern',
  OTHER: 'Übriges',
};

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requirePermission('expense:read');
  const canEditExpense = can(session.role, 'expense:update');
  const canDeleteExpense = can(session.role, 'expense:delete');
  const canCreateSupplier = can(session.role, 'supplier:create');
  const canEditSupplier = can(session.role, 'supplier:update');
  const canDeleteSupplier = can(session.role, 'supplier:delete');

  const params = await searchParams;
  const organizationId = await getOrganizationId();
  const activeTab = params.bereich === 'lieferanten' ? 'lieferanten' : 'belege';

  const page = Math.max(1, Number(params.seite) || 1);
  const pageSize = 25;
  const year = new Date().getFullYear();

  const where = {
    organizationId,
    ...(params.kategorie ? { category: params.kategorie as never } : {}),
    ...(params.q
      ? {
          OR: [
            { description: { contains: params.q, mode: 'insensitive' as const } },
            { reference: { contains: params.q, mode: 'insensitive' as const } },
            { supplier: { name: { contains: params.q, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };

  const [expenses, total, yearTotal, unpaid, suppliers] = await Promise.all([
    prisma.expense.findMany({
      where,
      orderBy: { expenseDate: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { supplier: { select: { name: true } } },
    }),
    prisma.expense.count({ where }),
    prisma.expense.aggregate({
      where: { organizationId, expenseDate: { gte: new Date(year, 0, 1) } },
      _sum: { netAmount: true, vatAmount: true },
    }),
    prisma.expense.aggregate({
      where: { organizationId, paid: false },
      _sum: { grossAmount: true },
      _count: true,
    }),
    // Alle Lieferanten, auch inaktive: die Liste zeigt sie mit Kennzeichen,
    // die Ausgabenmaske bekommt nur die aktiven.
    prisma.supplier.findMany({
      where: { organizationId },
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { expenses: true } } },
    }),
  ]);

  const activeSuppliers = suppliers
    .filter((supplier) => supplier.active)
    .map((supplier) => ({ id: supplier.id, name: supplier.name }));

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const baseHref = `/admin/ausgaben${toQueryString({ q: params.q, kategorie: params.kategorie })}`;
  const showActions = canEditExpense || canDeleteExpense;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ausgaben"
        description="Material, Fahrzeuge, Versicherungen und übrige Betriebskosten. Sie fliessen direkt in die Erfolgsrechnung und den Buchhaltungsexport."
        actions={
          can(session.role, 'expense:create') ? (
            <ExpenseDialog suppliers={activeSuppliers} />
          ) : undefined
        }
      >
        <FilterBar
          searchPlaceholder="Beschreibung, Beleg oder Lieferant …"
          filters={[
            {
              param: 'kategorie',
              label: 'Kategorie',
              options: Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label })),
            },
          ]}
        />
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiTile
          label={`Aufwand ${year} (netto)`}
          value={formatCurrency(toNumber(yearTotal._sum.netAmount))}
        />
        <KpiTile
          label={`Vorsteuer ${year}`}
          value={formatCurrency(toNumber(yearTotal._sum.vatAmount))}
          hint="abziehbar in der MWST-Abrechnung"
        />
        <KpiTile
          label="Unbezahlt"
          value={formatCurrency(toNumber(unpaid._sum.grossAmount))}
          hint={`${unpaid._count} Belege`}
          accent={toNumber(unpaid._sum.grossAmount) > 0 ? 'warning' : undefined}
          invertTrend
        />
      </div>

      <Tabs defaultValue={activeTab}>
        <TabsList variant="underline" className="w-full justify-start overflow-x-auto">
          <TabsTriggerUnderline value="belege">Belege ({total})</TabsTriggerUnderline>
          <TabsTriggerUnderline value="lieferanten">
            Lieferanten ({suppliers.length})
          </TabsTriggerUnderline>
        </TabsList>

        <TabsContent value="belege">
          {expenses.length === 0 ? (
            <EmptyState
              icon={<Wallet aria-hidden />}
              title="Keine Ausgaben erfasst"
              description="Erfassen Sie Material, Treibstoff und weitere Betriebskosten — damit stimmt die Erfolgsrechnung und der Export für die Treuhandstelle."
            />
          ) : (
            <ListCard
              footer={
                <Pagination page={page} totalPages={totalPages} total={total} baseHref={baseHref} />
              }
            >
              <TableScroll>
                <table className="data-table">
                  <caption className="sr-only">Ausgabenliste. {total} Einträge.</caption>
                  <thead>
                    <tr>
                      <th scope="col">Datum</th>
                      <th scope="col">Beschreibung</th>
                      <th scope="col">Kategorie</th>
                      <th scope="col">Lieferant</th>
                      <th scope="col" className="text-right">
                        Netto
                      </th>
                      <th scope="col" className="text-right">
                        MWST
                      </th>
                      <th scope="col" className="text-right">
                        Brutto
                      </th>
                      <th scope="col">Bezahlt</th>
                      {showActions ? (
                        <th scope="col" className="text-right">
                          <span className="sr-only">Aktionen</span>
                        </th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {expenses.map((expense) => (
                      <tr key={expense.id}>
                        <td className="tabular-nums text-muted-foreground">
                          {formatDate(expense.expenseDate)}
                        </td>
                        <td>
                          <span className="block font-medium">{expense.description}</span>
                          {expense.reference ? (
                            <span className="block text-xs text-muted-foreground">
                              {expense.reference}
                            </span>
                          ) : null}
                        </td>
                        <td>
                          <Badge variant="neutral" size="sm">
                            {CATEGORY_LABELS[expense.category] ?? expense.category}
                          </Badge>
                        </td>
                        <td className="text-muted-foreground">{expense.supplier?.name ?? '—'}</td>
                        <td className="num">{formatCurrency(toNumber(expense.netAmount))}</td>
                        <td className="num text-muted-foreground">
                          {formatCurrency(toNumber(expense.vatAmount))}
                        </td>
                        <td className="num font-medium">
                          {formatCurrency(toNumber(expense.grossAmount))}
                        </td>
                        <td>
                          <Badge variant={expense.paid ? 'success' : 'warning'} size="sm">
                            {expense.paid ? 'Bezahlt' : 'Offen'}
                          </Badge>
                        </td>
                        {showActions ? (
                          <td>
                            <ExpenseRowActions
                              canEdit={canEditExpense}
                              canDelete={canDeleteExpense}
                              suppliers={activeSuppliers}
                              expense={{
                                id: expense.id,
                                description: expense.description,
                                category: expense.category,
                                reference: expense.reference,
                                supplierId: expense.supplierId,
                                expenseDate: expense.expenseDate.toISOString().slice(0, 10),
                                netAmount: toNumber(expense.netAmount),
                                vatRate: toNumber(expense.vatRate),
                                paid: expense.paid,
                                vatDeductible: expense.vatDeductible,
                                notes: expense.notes,
                              }}
                            />
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            </ListCard>
          )}
        </TabsContent>

        <TabsContent value="lieferanten">
          <DetailSection
            title="Lieferanten"
            description="Ein Lieferant am Beleg macht die Ausgabe im Buchhaltungsexport zuordenbar. Inaktive bleiben in alten Belegen lesbar."
            action={canCreateSupplier ? <SupplierCreateButton /> : undefined}
          >
            <SupplierList
              canEdit={canEditSupplier}
              canDelete={canDeleteSupplier}
              suppliers={suppliers.map((supplier) => ({
                id: supplier.id,
                name: supplier.name,
                contactName: supplier.contactName,
                email: supplier.email,
                phone: supplier.phone,
                street: supplier.street,
                postalCode: supplier.postalCode,
                city: supplier.city,
                vatNumber: supplier.vatNumber,
                iban: supplier.iban,
                paymentTermDays: supplier.paymentTermDays,
                notes: supplier.notes,
                active: supplier.active,
                expenses: supplier._count.expenses,
              }))}
            />
          </DetailSection>
        </TabsContent>
      </Tabs>
    </div>
  );
}
