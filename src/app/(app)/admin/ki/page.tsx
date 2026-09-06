import type { Metadata } from 'next';
import { Sparkles } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { hasIntegration } from '@/lib/env';
import { Alert } from '@/components/ui/primitives';
import { PageHeader } from '@/components/app/page-parts';
import { AiWorkspace } from '@/features/admin/ai-workspace';

export const metadata: Metadata = {
  title: 'KI-Werkzeuge',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function AiToolsPage({
  searchParams,
}: {
  searchParams: Promise<{ werkzeug?: string }>;
}) {
  await requirePermission('ai:use');

  const params = await searchParams;
  const configured = hasIntegration('ai');

  return (
    <div className="space-y-6">
      <PageHeader
        title="KI-Werkzeuge"
        description="Entwürfe für E-Mails, Zusammenfassungen, Übersetzungen und die Tagesplanung. Jeder Entwurf wird von Ihnen geprüft, bevor er verwendet wird."
      />

      {!configured ? (
        <Alert variant="warning" title="KI ist nicht konfiguriert">
          Hinterlegen Sie <code className="text-xs">ANTHROPIC_API_KEY</code> in den
          Umgebungsvariablen, damit die Werkzeuge arbeiten. Alle übrigen Funktionen der Applikation
          laufen unabhängig davon.
        </Alert>
      ) : (
        <Alert variant="info">
          <span className="flex items-start gap-2">
            <Sparkles className="mt-0.5 size-4 shrink-0" aria-hidden />
            Wir übermitteln nur den Text, den Sie eingeben, plus den öffentlichen Leistungskatalog.
            Kundenstammdaten, Rechnungen und Personaldaten verlassen die Applikation nicht.
          </span>
        </Alert>
      )}

      <AiWorkspace defaultTool={params.werkzeug} />
    </div>
  );
}
