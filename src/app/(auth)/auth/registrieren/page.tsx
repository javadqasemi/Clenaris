import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { getSession } from '@/lib/auth/session';
import { homeRouteFor } from '@/lib/auth/rbac';
import { RegisterForm } from '@/features/auth/register-form';

export const metadata: Metadata = {
  title: 'Konto erstellen',
  description: 'Kundenkonto bei Clenaris erstellen: Termine verwalten, Rechnungen einsehen, mit einem Klick nachbuchen.',
};

export const dynamic = 'force-dynamic';

export default async function RegisterPage() {
  const session = await getSession();
  if (session) redirect(homeRouteFor(session.role));

  return <RegisterForm />;
}
