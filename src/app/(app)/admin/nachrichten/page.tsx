import type { Metadata } from 'next';
import { MessageSquare } from 'lucide-react';

import { requirePermission } from '@/lib/auth/session';
import { EmptyState, PageHeader } from '@/components/app/page-parts';
import { ThreadList } from '@/features/messaging/thread-list';

export const metadata: Metadata = {
  title: 'Nachrichten',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Posteingang des Büros.
 *
 * Zeigt alle Verläufe, offene wie abgeschlossene. Eine getrennte Ablage
 * würde nur dazu führen, dass man beim Suchen zweimal schaut; der Zustand
 * steht am Verlauf und die ungelesenen stehen ohnehin oben.
 */
export default async function AdminMessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ verlauf?: string }>;
}) {
  await requirePermission('message:read');
  const params = await searchParams;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Nachrichten"
        description="Anfragen der Kundschaft aus dem Kundenkonto. Antworten landen dort und zusätzlich per E-Mail."
      />

      <ThreadList
        perspective="STAFF"
        initialThreadId={params.verlauf}
        emptyState={
          <EmptyState
            icon={<MessageSquare aria-hidden />}
            title="Keine Nachrichten"
            description="Sobald jemand aus dem Kundenkonto schreibt, erscheint der Verlauf hier."
          />
        }
      />
    </div>
  );
}
