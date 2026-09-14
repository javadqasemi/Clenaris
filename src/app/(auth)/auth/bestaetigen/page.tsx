import type { Metadata } from 'next';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';

import { getSession } from '@/lib/auth/session';
import { homeRouteFor } from '@/lib/auth/rbac';
import { TwoFactorForm } from '@/features/auth/two-factor-form';
import { Skeleton } from '@/components/ui/primitives';

export const metadata: Metadata = {
  title: 'Bestätigung',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Zweiter Schritt der Anmeldung.
 *
 * Wer bereits eine Sitzung hat, ist hier falsch — das passiert etwa, wenn
 * jemand die Adresse aus dem Verlauf wieder aufruft. Umleiten statt eine
 * Codeabfrage zu zeigen, die nichts mehr bewirkt.
 *
 * Der ausstehende Zustand steckt in einem kurzlebigen Cookie und wird nicht
 * hier geprüft: der Endpunkt hinter dem Formular tut es, und eine zweite
 * Prüfung an dieser Stelle könnte nur auseinanderlaufen.
 */
export default async function TwoFactorPage() {
  const session = await getSession();
  if (session) redirect(homeRouteFor(session.role));

  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <TwoFactorForm />
    </Suspense>
  );
}
