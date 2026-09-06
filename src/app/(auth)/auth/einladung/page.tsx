import type { Metadata } from 'next';
import Link from 'next/link';
import { AlertCircle } from 'lucide-react';

import { SetPasswordForm } from '@/features/auth/password-forms';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = {
  title: 'Zugang aktivieren',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function InvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (!token || token.length < 10) {
    return (
      <div className="space-y-6">
        <div className="flex size-12 items-center justify-center rounded-xl bg-destructive/12 text-destructive">
          <AlertCircle className="size-6" aria-hidden />
        </div>
        <div className="space-y-2">
          <h1 className="font-display text-2xl font-bold tracking-tight">Einladung nicht gültig</h1>
          <p className="text-body leading-relaxed text-muted-foreground">
            Diese Einladung ist abgelaufen oder wurde bereits verwendet. Bitte wenden Sie sich an
            die Person, die Ihnen den Zugang eingerichtet hat.
          </p>
        </div>
        <Button asChild variant="outline" width="full">
          <Link href="/auth/anmelden">Zur Anmeldung</Link>
        </Button>
      </div>
    );
  }

  return <SetPasswordForm token={token} mode="invite" />;
}
