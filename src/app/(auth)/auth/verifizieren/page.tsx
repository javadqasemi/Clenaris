import type { Metadata } from 'next';
import Link from 'next/link';
import { AlertCircle, CheckCircle2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { verifyEmail } from '@/server/services/auth.service';

export const metadata: Metadata = {
  title: 'E-Mail bestätigen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * E-Mail-Bestätigung.
 *
 * Die Bestätigung passiert direkt beim Aufruf der Seite — ohne zusätzlichen
 * Klick. Der Token stammt aus einer E-Mail an genau diese Adresse; ein
 * weiterer Bestätigungsschritt würde nur Abbrüche erzeugen.
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  let success = false;
  let message = 'Dieser Bestätigungslink ist ungültig oder abgelaufen.';

  if (token) {
    try {
      await verifyEmail(token);
      success = true;
    } catch (error) {
      message = error instanceof Error ? error.message : message;
    }
  }

  return (
    <div className="space-y-6">
      <div
        className={`flex size-12 items-center justify-center rounded-xl ${
          success ? 'bg-success/12 text-success' : 'bg-destructive/12 text-destructive'
        }`}
      >
        {success ? (
          <CheckCircle2 className="size-6" aria-hidden />
        ) : (
          <AlertCircle className="size-6" aria-hidden />
        )}
      </div>

      <div className="space-y-2">
        <h1 className="font-display text-2xl font-bold tracking-tight">
          {success ? 'E-Mail bestätigt' : 'Bestätigung fehlgeschlagen'}
        </h1>
        <p className="text-body leading-relaxed text-muted-foreground">
          {success
            ? 'Ihre E-Mail-Adresse ist bestätigt. Sie erhalten ab jetzt Terminbestätigungen und Rechnungen zuverlässig.'
            : message}
        </p>
      </div>

      <Button asChild width="full">
        <Link href={success ? '/konto' : '/auth/anmelden'}>
          {success ? 'Zum Kundenbereich' : 'Zur Anmeldung'}
        </Link>
      </Button>
    </div>
  );
}
