'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Eye, EyeOff, Lock, Mail } from 'lucide-react';

import { api, ApiError } from '@/lib/api/client';
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
 * Der Parameter `ziel` steuert nur die Beschriftung („Kundenkonto",
 * „Mitarbeitendenportal") — die tatsächliche Weiterleitung entscheidet die
 * Rolle des Kontos, nicht die Wahl in der Oberfläche. So kann niemand durch
 * Manipulation der URL in einen fremden Bereich gelangen.
 */

const TARGET_LABELS: Record<string, { title: string; lead: string }> = {
  konto: {
    title: 'Willkommen zurück',
    lead: 'Melden Sie sich an, um Termine, Offerten und Rechnungen zu verwalten.',
  },
  portal: {
    title: 'Mitarbeitendenportal',
    lead: 'Einsatzplan, Zeiterfassung und Berichte.',
  },
  admin: {
    title: 'Administration',
    lead: 'Disposition, Finanzen und Auswertungen.',
  },
};

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [showPassword, setShowPassword] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const target = searchParams.get('ziel') ?? 'konto';
  const labels = TARGET_LABELS[target] ?? TARGET_LABELS.konto;
  const returnTo = searchParams.get('weiter');

  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '', rememberMe: true },
  });

  const onSubmit = async (values: LoginInput) => {
    setError(null);
    try {
      const result = await api.post<{ redirectTo: string }>('/api/auth/login', values);
      // `router.refresh()` lädt die Server Components mit der neuen Session neu.
      router.replace(returnTo ?? result.redirectTo);
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
        <h1 className="font-display text-3xl font-bold tracking-tight">{labels.title}</h1>
        <p className="text-body leading-relaxed text-muted-foreground">{labels.lead}</p>
      </header>

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
