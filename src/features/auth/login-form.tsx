'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Eye, EyeOff, Lock, Mail } from 'lucide-react';

import { api, ApiError } from '@/lib/api/client';
import { resolveRedirect, safeReturnPath } from '@/lib/auth/safe-redirect';
import { loginSchema, type LoginInput } from '@/lib/validation/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/controls';
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
 * Anmeldeformular.
 *
 * **Eine Anmeldung für alle Rollen.** Vorher gab es drei Einstiege
 * (`?ziel=konto|portal|admin`), die sich allein in der Überschrift
 * unterschieden — die Weiterleitung entschied ohnehin die Rolle des Kontos.
 * Die Wahl war also folgenlos und trotzdem eine Hürde: Wer in der Verwaltung
 * *und* im Personalbereich zu tun hat, musste raten, und wer den falschen
 * Einstieg erwischte, zweifelte an seinem Passwort statt an der Oberfläche.
 *
 * Wohin es nach der Anmeldung geht, sagt der Server (`redirectTo`, abgeleitet
 * aus der Rolle). Ein Rücksprungziel aus der URL (`weiter`) hat Vorrang, aber
 * nur wenn es `safeReturnPath` passiert — sonst wäre die Anmeldeseite eine
 * offene Weiterleitung.
 */
export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [showPassword, setShowPassword] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const returnTo = safeReturnPath(searchParams.get('weiter'));

  /**
   * Warum die Person hier steht, obwohl sie angemeldet war. Der Grund kommt
   * aus der URL — von der Middleware, dem API-Klienten oder dem
   * Aktivitätswächter. Ohne diese Zeile sähe eine Abmeldung nach Leerlauf
   * aus wie ein Fehler der Anwendung.
   */
  const reason = searchParams.get('grund');
  const notice =
    reason === 'inaktiv'
      ? 'Sie wurden nach 15 Minuten ohne Aktivität abgemeldet. Nach der Anmeldung geht es dort weiter, wo Sie waren.'
      : reason === 'abgelaufen'
        ? 'Ihre Sitzung ist abgelaufen. Bitte melden Sie sich erneut an.'
        : null;

  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '', rememberMe: true },
  });

  const onSubmit = async (values: LoginInput) => {
    setError(null);
    try {
      const result = await api.post<{ redirectTo: string; twoFactorRequired?: boolean }>(
        '/api/auth/login',
        values,
      );

      /**
       * Zweiter Faktor ausstehend: es besteht noch keine Sitzung.
       *
       * Das Rücksprungziel wird mitgegeben, damit die Person nach dem Code
       * dort landet, wo sie hinwollte — `router.refresh()` bleibt aus, weil
       * es nichts zu erneuern gibt.
       */
      if (result.twoFactorRequired) {
        const next = returnTo ? `?weiter=${encodeURIComponent(returnTo)}` : '';
        router.replace(`/auth/bestaetigen${next}`);
        return;
      }

      // `router.refresh()` lädt die Server Components mit der neuen Session neu.
      router.replace(resolveRedirect(returnTo, result.redirectTo));
      router.refresh();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Die Anmeldung ist fehlgeschlagen. Bitte versuchen Sie es erneut.',
      );
    }
  };

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="font-display text-3xl font-bold tracking-tight">Willkommen zurück</h1>
        <p className="text-body leading-relaxed text-muted-foreground">
          Ein Zugang für Kundschaft, Mitarbeitende und Verwaltung. Nach der Anmeldung öffnet sich
          automatisch der Bereich, der zu Ihrem Konto gehört.
        </p>
      </header>

      {notice && !error ? <Alert variant="info">{notice}</Alert> : null}
      {error ? <Alert variant="destructive">{error}</Alert> : null}

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

          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <div className="flex items-baseline justify-between gap-4">
                  <FormLabel required>Passwort</FormLabel>
                  <Link
                    href="/auth/passwort-vergessen"
                    className="text-meta font-medium text-primary underline-offset-4 hover:underline"
                  >
                    Vergessen?
                  </Link>
                </div>
                <FormControl>
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    startIcon={<Lock />}
                    endIcon={
                      <button
                        type="button"
                        onClick={() => setShowPassword((value) => !value)}
                        className="pointer-events-auto text-muted-foreground transition-colors hover:text-foreground"
                        aria-label={showPassword ? 'Passwort verbergen' : 'Passwort anzeigen'}
                      >
                        {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                      </button>
                    }
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="rememberMe"
            render={({ field }) => (
              <FormItem>
                <label className="flex cursor-pointer items-center gap-2.5 text-sm">
                  <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                  Angemeldet bleiben
                </label>
              </FormItem>
            )}
          />

          <Button type="submit" width="full" size="lg" loading={form.formState.isSubmitting}>
            Anmelden
          </Button>
        </form>
      </Form>

      <p className="text-center text-sm text-muted-foreground">
        Noch kein Konto?{' '}
        <Link
          href="/auth/registrieren"
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          Jetzt registrieren
        </Link>
      </p>
    </div>
  );
}
