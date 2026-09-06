import type { Metadata } from 'next';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';

import { getSession } from '@/lib/auth/session';
import { homeRouteFor } from '@/lib/auth/rbac';
import { LoginForm } from '@/features/auth/login-form';
import { Skeleton } from '@/components/ui/primitives';

export const metadata: Metadata = {
  title: 'Anmelden',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  // Bereits angemeldet? Dann direkt in den eigenen Bereich.
  const session = await getSession();
  if (session) redirect(homeRouteFor(session.role));

  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <LoginForm />
    </Suspense>
  );
}
