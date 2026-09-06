import type { Metadata } from 'next';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';

import { getSession, requirePagePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import { PageHeader } from '@/components/app/page-parts';
import { CtaWorkspace } from '@/features/admin/cta/cta-workspace';
import type { CtaRow } from '@/features/admin/cta/cta-form';
import { listCtas } from '@/server/services/cta.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const metadata: Metadata = {
  title: 'Handlungsaufrufe',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Handlungsaufrufe der öffentlichen Website.
 *
 * Jede Schaltfläche, die zu einer Handlung auffordert — buchen, offerieren,
 * anrufen, schreiben — kommt aus dieser Tabelle. Text, Farbe, Symbol, Ziel,
 * Platz und Laufzeit sind ohne Auslieferung änderbar; das ist der Zweck.
 */
export default async function CtaPage() {
  await requirePagePermission('cta:read');
  const session = await getSession();
  const role = session!.role;
  const organizationId = await getOrganizationId();

  const all = await listCtas(organizationId, true);

  const toRow = (cta: (typeof all)[number]): CtaRow => ({
    id: cta.id,
    key: cta.key,
    label: cta.label,
    note: cta.note,
    href: cta.href,
    newTab: cta.newTab,
    icon: cta.icon,
    slot: cta.slot,
    style: cta.style,
    bgColor: cta.bgColor,
    fgColor: cta.fgColor,
    pages: cta.pages,
    active: cta.active,
    position: cta.position,
    publishFrom: cta.publishFrom?.toISOString() ?? null,
    publishUntil: cta.publishUntil?.toISOString() ?? null,
    deletedAt: cta.deletedAt?.toISOString() ?? null,
  });

  const live = all.filter((cta) => !cta.deletedAt).map(toRow);
  const trashed = all.filter((cta) => cta.deletedAt).map(toRow);

  const canUpdate = can(role, 'cta:update');
  const canPublish = can(role, 'cta:publish');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Handlungsaufrufe"
        description="Jede Schaltfläche der Website, die zu einer Handlung auffordert. Änderungen erscheinen sofort — Text, Farbe, Symbol, Ziel und Laufzeit ohne Auslieferung."
        actions={
          <Button asChild variant="outline">
            <Link href="/" target="_blank" rel="noopener noreferrer">
              <ExternalLink aria-hidden />
              Website ansehen
            </Link>
          </Button>
        }
      />

      {canUpdate ? null : (
        <Alert variant="default">
          Sie sehen die Handlungsaufrufe, können sie aber nicht ändern.
        </Alert>
      )}

      <CtaWorkspace
        ctas={live}
        trashed={trashed}
        canCreate={can(role, 'cta:create')}
        canUpdate={canUpdate}
        canDelete={can(role, 'cta:delete')}
        canPublish={canPublish}
      />
    </div>
  );
}
