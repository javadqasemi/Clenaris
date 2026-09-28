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
      {/*
        Bis 2026-09-27 hiess es hier „anonymisierte Bewertungstexte" und
        „Kundennamen verlassen die Anwendung nicht" — beides stimmte nicht,
        die Texte gingen roh hinaus. Der Satz sagt jetzt, was geschieht.
      */}
      <Alert variant="info">
        Übermittelt werden aggregierte Kennzahlen, Titel von Zielen und Risiken sowie — je nach Auswertung — Bewertungstexte, Kommentare oder Ihre Sitzungsnotizen. Namen, die Clenaris kennt, sowie E-Mail-Adressen, Telefonnummern, IBAN und AHV-Nummern werden vorher ersetzt; Löhne und Adressen gehen nie hinaus. Namen, die nirgends erfasst sind, erkennt kein Filter sicher: Die Übermittlung ist sparsam, nicht anonym.
      </Alert>
      <AssistantPanel configured={hasIntegration('ai')} budgets={budgets} defaultKind={(params.art as never) ?? 'summarizePeriod'} />
    </div>
  );
}
