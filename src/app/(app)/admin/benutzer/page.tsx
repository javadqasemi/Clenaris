import type { Metadata } from 'next';
import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';

import { getSession, requirePagePermission } from '@/lib/auth/session';
import { assignableRoles, can } from '@/lib/auth/rbac';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import { PageHeader } from '@/components/app/page-parts';
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
export default async function UsersPage() {
  await requirePagePermission('user:read');
  const session = await getSession();
  const role = session!.role;
  const organizationId = await getOrganizationId();

  const all = await listUsers({ organizationId, includeDeleted: true });

  const toRow = (user: (typeof all)[number]): UserRow => ({
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

  const live = all.filter((user) => !user.deletedAt).map(toRow);
  const trashed = all.filter((user) => user.deletedAt).map(toRow);

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
      />

      {canAssignRole ? null : (
        <Alert variant="info">
          Rollen vergibt ausschliesslich die Systemverantwortung — so kann sich niemand selbst
          höherstufen. Stammdaten und Sperrungen können Sie pflegen.
        </Alert>
      )}

      <UserWorkspace
        users={live}
        trashed={trashed}
        currentUserId={session!.id}
        assignableRoles={assignableRoles(role)}
        canCreate={can(role, 'user:create')}
        canUpdate={can(role, 'user:update')}
        canDelete={can(role, 'user:delete')}
        canAssignRole={canAssignRole}
      />
    </div>
  );
}
