import type { Metadata } from 'next';
import Link from 'next/link';
import { ScrollText } from 'lucide-react';

import { requirePagePermission } from '@/lib/auth/session';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import { PageHeader } from '@/components/app/page-parts';
import { PurgeWorkspace } from '@/features/admin/system/purge-workspace';
import { previewPurge } from '@/server/services/purge.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const metadata: Metadata = {
  title: 'Datenbereinigung',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Datenbereinigung — ganze Datenbereiche endgültig löschen.
 *
 * Nur die Systemverantwortung sieht diese Seite (404 für alle anderen, nicht
 * 403: eine Seite, die nichts als eine Löschmaske ist, soll für die übrigen
 * Rollen nicht existieren). Die Vorschau kommt aus dem Dienst; das Löschen
 * geht wie jede Mutation über den Endpunkt, der den Bestätigungssatz prüft
 * und jeden Bereich im Prüfprotokoll festhält.
 */
export default async function PurgePage() {
  const session = await requirePagePermission('data:purge');
  const organizationId = await getOrganizationId();
  const areas = await previewPurge({ organizationId, actorId: session.id });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Datenbereinigung"
        description="Ganze Datenbereiche endgültig löschen — für den Abschluss einer Testphase oder das Entfernen von Demodaten vor dem Livegang. Nicht für einzelne Datensätze; dafür ist der Papierkorb da."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/protokoll?bereich=Datenbereinigung">
              <ScrollText aria-hidden />
              Bisherige Läufe im Protokoll
            </Link>
          </Button>
        }
      />

      <Alert variant="destructive" title="Unumkehrbar">
        Was hier gelöscht wird, lässt sich nicht wiederherstellen — auch nicht über den Papierkorb.
        Jeder Lauf wird mit Ihrem Namen, Zeitpunkt, IP-Adresse und den gelöschten Mengen im
        Prüfprotokoll festgehalten. Organisation, Einstellungen, Leistungskatalog, Preise,
        Website-Texte, das Protokoll selbst, die Systemverantwortung und Ihr eigenes Konto bleiben
        in jedem Fall bestehen.
      </Alert>

      <PurgeWorkspace initialAreas={areas} />
    </div>
  );
}
