import type { Metadata } from 'next';

import { requireCustomerId } from '@/lib/auth/session';
import { PageHeader } from '@/components/app/page-parts';
import { AccountMessages } from '@/features/account/messages';

export const metadata: Metadata = {
  title: 'Nachrichten',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Nachrichten mit dem Büro.
 *
 * Der eigentliche Verlauf lädt clientseitig — er ändert sich während des
 * Lesens, und ein Server-Render, der beim Absenden neu angefordert werden
 * müsste, würde jede Antwort um eine volle Navigation verzögern.
 */
export default async function AccountMessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ verlauf?: string }>;
}) {
  await requireCustomerId();
  const params = await searchParams;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Nachrichten"
        description="Fragen zu Terminen, Schlüsseln oder Rechnungen. Wir antworten an Werktagen innerhalb von vier Stunden."
      />

      <AccountMessages initialThreadId={params.verlauf} />
    </div>
  );
}
