import type { Metadata } from 'next';
import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';

import type { UserRole } from '@prisma/client';

import { prisma } from '@/lib/db';
import { getSession, requirePagePermission } from '@/lib/auth/session';
import { ROLE_LABELS, assignableRoles, can } from '@/lib/auth/rbac';
import { toQueryString } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import { FilterBar } from '@/components/app/filter-bar';
import { PageHeader, Pagination } from '@/components/app/page-parts';
import { UserWorkspace, type UserRow } from '@/features/admin/users/user-workspace';
import { listUsers } from '@/server/services/user.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const metadata: Metadata = {
  title: 'Benutzerkonten',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Benutzerkonten.
 *
 * Konten entstehen auf zwei Wegen: durch eine Einladung (Personal,
 * Verwaltung) oder durch die Registrierung einer Kundschaft auf der Website.
 * Beide landen hier.
 */
const JE_SEITE = 50;

export default async function UsersPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requirePagePermission('user:read');
  const session = await getSession();
  const role = session!.role;
  const organizationId = await getOrganizationId();
  const params = await searchParams;
  const page = Math.max(1, Number(params.seite) || 1);
  const rolle = params.rolle && params.rolle in ROLE_LABELS && params.rolle !== 'GUEST' ? (params.rolle as UserRole) : undefined;

  /*
    Seitenweise (Phase 23, 2026-09-27) — vorher alle Konten samt gelöschten,
    getrennt erst im Speicher. Der Papierkorb zeigt die jüngsten 50; alle
    gelöschten Datensätze stehen ohnehin unter /admin/papierkorb.
  */
  const [lebend, geloescht, aktiv] = await Promise.all([
    listUsers({ organizationId, q: params.q, role: rolle, page, pageSize: JE_SEITE }),
    listUsers({ organizationId, nurGeloescht: true, pageSize: JE_SEITE }),
    prisma.user.count({ where: { organizationId, deletedAt: null, status: 'ACTIVE', ...(rolle ? { role: rolle } : {}) } }),
  ]);
  const totalPages = Math.max(1, Math.ceil(lebend.total / JE_SEITE));
  const baseHref = `/admin/benutzer${toQueryString({ q: params.q, rolle: params.rolle })}`;

  const toRow = (user: (typeof lebend.items)[number]): UserRow => ({
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone,
    role: user.role,
    status: user.status,
    locale: user.locale,
    twoFactorEnabled: user.twoFactorEnabled,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    deletedAt: user.deletedAt?.toISOString() ?? null,
    linkedTo: user.customer
      ? `Kundschaft ${user.customer.number}`
      : user.employee
        ? `Personal ${user.employee.employeeNumber}`
        : null,
  });

  const live = lebend.items.map(toRow);
  const trashed = geloescht.items.map(toRow);

  const canAssignRole = can(role, 'role:assign');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Benutzerkonten"
        description="Wer sich anmelden darf und mit welchen Rechten. Konten entstehen durch eine Einladung oder durch die Registrierung einer Kundschaft."
        actions={
          <Button asChild variant="outline">
            <Link href="/admin/rollen">
              <ShieldCheck aria-hidden />
              Rollen und Rechte
            </Link>
          </Button>
        }
      >
        <FilterBar
          searchPlaceholder="Name oder E-Mail …"
          filters={[
            {
              param: 'rolle',
              label: 'Rolle',
              options: (['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'CUSTOMER'] as const).map((r) => ({ value: r, label: ROLE_LABELS[r] })),
            },
          ]}
        />
      </PageHeader>

      {canAssignRole ? null : (
        <Alert variant="info">
          Rollen vergibt ausschliesslich die Systemverantwortung — so kann sich niemand selbst
          höherstufen. Stammdaten und Sperrungen können Sie pflegen.
        </Alert>
      )}

      <UserWorkspace
        users={live}
        gesamt={lebend.total}
        aktiv={aktiv}
        trashed={trashed}
        trashedTotal={geloescht.total}
        currentUserId={session!.id}
        assignableRoles={assignableRoles(role)}
        canCreate={can(role, 'user:create')}
        canUpdate={can(role, 'user:update')}
        canDelete={can(role, 'user:delete')}
        canAssignRole={canAssignRole}
      />
      {totalPages > 1 ? <Pagination page={page} totalPages={totalPages} total={lebend.total} baseHref={baseHref} /> : null}
    </div>
  );
}
