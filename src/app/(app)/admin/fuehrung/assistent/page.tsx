import type { Metadata } from 'next';

import { requirePermission } from '@/lib/auth/session';
import { hasIntegration } from '@/lib/env';
import { getOrganizationId } from '@/server/services/organization.service';
import { listBudgetOptions } from '@/server/services/fuehrung-options.service';
import { Alert } from '@/components/ui/primitives';
import { PageHeader } from '@/components/app/page-parts';
import { AssistantPanel } from '@/features/fuehrung/assistant-panel';

export const metadata: Metadata = {
  title: 'Führungsassistent',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function AssistantPage({ searchParams }: { searchParams: Promise<{ art?: string }> }) {
  await requirePermission('cockpit:view', 'ai:use');
  const params = await searchParams;
  const organizationId = await getOrganizationId();
  const budgets = await listBudgetOptions(organizationId);

  return (
    <div className="space-y-6">
      <PageHeader title="Führungsassistent" description="Zusammenfassungen, Analysen, Risikovorschläge und Protokolle als Entwurf — jeder mit Begründung, Datenquelle und Vertrauensgrad." />
      <Alert variant="info">Übermittelt werden aggregierte Kennzahlen, Titel von Zielen und Risiken sowie anonymisierte Bewertungstexte. Kundennamen, Löhne und Adressen verlassen die Anwendung nicht.</Alert>
      <AssistantPanel configured={hasIntegration('ai')} budgets={budgets} defaultKind={(params.art as never) ?? 'summarizePeriod'} />
    </div>
  );
}
