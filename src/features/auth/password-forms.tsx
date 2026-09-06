'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2, Mail } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import {
  forgotPasswordSchema,
  resetPasswordSchema,
  type ForgotPasswordInput,
  type ResetPasswordInput,
} from '@/lib/validation/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/primitives';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';

/**
 * Passwort vergessen.
 *
 * Die Bestätigungsansicht erscheint unabhängig davon, ob die Adresse
 * existiert. Andernfalls liesse sich über das Formular herausfinden, wer bei
 * uns Kunde ist.
 */
export function ForgotPasswordForm() {
  const [sent, setSent] = React.useState(false);

  const form = useForm<ForgotPasswordInput>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '', website: '' },
  });

  const onSubmit = async (values: ForgotPasswordInput) => {
    try {
      await api.post('/api/auth/password', { action: 'forgot', ...values });
    } catch (error) {
      // Auch bei einem Rate-Limit dieselbe Ansicht zeigen: die Antwort darf
      // nicht verraten, ob die Adresse registriert ist. Der Fehler wird
      // bewusst verschluckt — der Server hat ihn bereits protokolliert, und in
      // der Browserkonsole nützt er niemandem etwas.
      void error;
    } finally {
      setSent(true);
    }
  };

  if (sent) {
    return (
      <div className="space-y-6">
        <div className="flex size-12 items-center justify-center rounded-xl bg-success/12 text-success">
          <Mail className="size-6" aria-hidden />
        </div>
        <div className="space-y-2">
          <h1 className="font-display text-2xl font-bold tracking-tight">E-Mail unterwegs</h1>
          <p className="text-body leading-relaxed text-muted-foreground">
            Falls ein Konto mit dieser Adresse besteht, haben wir Ihnen einen Link zum Zurücksetzen
            geschickt. Der Link ist 60 Minuten gültig.
          </p>
          <p className="text-body leading-relaxed text-muted-foreground">
            Nichts angekommen? Prüfen Sie den Spam-Ordner oder{' '}
            <button
              type="button"
              onClick={() => setSent(false)}
              className="font-medium text-primary underline underline-offset-4"
            >
              versuchen Sie es erneut
            </button>
            .
          </p>
        </div>
        <Button asChild variant="outline" width="full">
          <Link href="/auth/anmelden">Zurück zur Anmeldung</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="font-display text-3xl font-bold tracking-tight">Passwort zurücksetzen</h1>
        <p className="text-body leading-relaxed text-muted-foreground">
          Geben Sie Ihre E-Mail-Adresse ein. Wir schicken Ihnen einen Link, mit dem Sie ein neues
          Passwort setzen können.
        </p>
      </header>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" noValidate>
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>E-Mail-Adresse</FormLabel>
                <FormControl>
                  <Input
                    type="email"
                    autoComplete="email"
                    autoFocus
                    startIcon={<Mail />}
                    placeholder="ihre@e-mail.ch"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <div aria-hidden className="absolute h-0 w-0 overflow-hidden">
            <input tabIndex={-1} autoComplete="off" {...form.register('website')} />
          </div>

          <Button type="submit" width="full" size="lg" loading={form.formState.isSubmitting}>
            Link anfordern
          </Button>
        </form>
      </Form>

      <p className="text-center text-sm text-muted-foreground">
        <Link href="/auth/anmelden" className="font-medium text-primary underline-offset-4 hover:underline">
          Zurück zur Anmeldung
        </Link>
      </p>
    </div>
  );
}

/**
 * Neues Passwort setzen — für Reset-Links und Einladungen.
 * Beide Vorgänge unterscheiden sich nur im Text und im `action`-Feld.
 */
export function SetPasswordForm({
  token,
  mode,
}: {
  token: string;
  mode: 'reset' | 'invite';
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);

  const form = useForm<ResetPasswordInput>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { token, password: '', confirmPassword: '' },
  });

  const onSubmit = async (values: ResetPasswordInput) => {
    setError(null);
    try {
      const result = await api.post<{ redirectTo: string; message: string }>(
        '/api/auth/password',
        { action: mode, ...values },
      );
      toast.success(result.message);
      router.replace(result.redirectTo);
      router.refresh();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Das Passwort konnte nicht gesetzt werden. Bitte fordern Sie einen neuen Link an.',
      );
    }
  };

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="font-display text-3xl font-bold tracking-tight">
          {mode === 'invite' ? 'Zugang aktivieren' : 'Neues Passwort'}
        </h1>
        <p className="text-body leading-relaxed text-muted-foreground">
          {mode === 'invite'
            ? 'Legen Sie Ihr Passwort fest, damit Sie sich künftig anmelden können.'
            : 'Wählen Sie ein neues Passwort. Alle bestehenden Sitzungen werden dabei beendet.'}
        </p>
      </header>

      {error ? (
        <Alert variant="destructive">
          {error}{' '}
          <Link href="/auth/passwort-vergessen" className="font-medium underline underline-offset-2">
            Neuen Link anfordern
          </Link>
        </Alert>
      ) : null}

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" noValidate>
          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>Neues Passwort</FormLabel>
                <FormControl>
                  <Input type="password" autoComplete="new-password" autoFocus {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="confirmPassword"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>Passwort wiederholen</FormLabel>
                <FormControl>
                  <Input type="password" autoComplete="new-password" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <ul className="space-y-1.5 rounded-xl bg-muted/60 p-4 text-meta text-muted-foreground">
            {[
              'Mindestens 10 Zeichen',
              'Mindestens ein Grossbuchstabe',
              'Mindestens eine Ziffer',
            ].map((rule) => (
              <li key={rule} className="flex items-center gap-2">
                <CheckCircle2 className="size-3.5 text-primary" aria-hidden />
                {rule}
              </li>
            ))}
          </ul>

          <Button type="submit" width="full" size="lg" loading={form.formState.isSubmitting}>
            {mode === 'invite' ? 'Zugang aktivieren' : 'Passwort speichern'}
          </Button>
        </form>
      </Form>
    </div>
  );
}
