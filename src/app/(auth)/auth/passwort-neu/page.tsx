import type { Metadata } from 'next';
import Link from 'next/link';
import { AlertCircle } from 'lucide-react';

import { SetPasswordForm } from '@/features/auth/password-forms';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = {
  title: 'Neues Passwort festlegen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (!token || token.length < 10) return <InvalidLink />;

  return <SetPasswordForm token={token} mode="reset" />;
}

function InvalidLink() {
  return (
    <div className="space-y-6">
      <div className="flex size-12 items-center justify-center rounded-xl bg-destructive/12 text-destructive">
        <AlertCircle className="size-6" aria-hidden />
      </div>
      <div className="space-y-2">
        <h1 className="font-display text-2xl font-bold tracking-tight">Link nicht gültig</h1>
        <p className="text-body leading-relaxed text-muted-foreground">
          Dieser Link ist unvollständig oder abgelaufen. Links zum Zurücksetzen sind 60 Minuten
          gültig und können nur einmal verwendet werden.
        </p>
      </div>
      <Button asChild width="full">
        <Link href="/auth/passwort-vergessen">Neuen Link anfordern</Link>
      </Button>
    </div>
  );
}
