'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Eye, EyeOff } from 'lucide-react';

import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import { assessPassword } from '@/lib/auth/password-strength';
import { registerSchema, type RegisterInput } from '@/lib/validation/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/controls';
import { Alert } from '@/components/ui/primitives';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';

/**
 * Registrierung.
 *
 * Die Passwortstärke wird live angezeigt — als Balken *und* als Text, damit
 * die Information nicht nur über Farbe transportiert wird. Die eigentliche
 * Prüfung passiert serverseitig; die Anzeige ist reine Hilfestellung.
 */
export function RegisterForm() {
  const router = useRouter();
  const [showPassword, setShowPassword] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const form = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      firstName: '',
      lastName: '',
      email: '',
      phone: '',
      password: '',
      confirmPassword: '',
      locale: 'DE',
      acceptTerms: false as unknown as true,
      marketingOptIn: false,
      website: '',
    },
  });

  const password = form.watch('password');
  const strength = React.useMemo(() => assessPassword(password ?? ''), [password]);

  const onSubmit = async (values: RegisterInput) => {
    setError(null);
    try {
      const result = await api.post<{ redirectTo: string }>('/api/auth/register', values);
      router.replace(result.redirectTo);
      router.refresh();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Die Registrierung ist fehlgeschlagen. Bitte versuchen Sie es erneut.',
      );
    }
  };

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="font-display text-3xl font-bold tracking-tight">Konto erstellen</h1>
        <p className="text-body leading-relaxed text-muted-foreground">
          Termine verwalten, Rechnungen einsehen und mit einem Klick nachbuchen.
        </p>
      </header>

      {error ? <Alert variant="destructive">{error}</Alert> : null}

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="firstName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Vorname</FormLabel>
                  <FormControl>
                    <Input autoComplete="given-name" autoFocus {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="lastName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Nachname</FormLabel>
                  <FormControl>
                    <Input autoComplete="family-name" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>E-Mail-Adresse</FormLabel>
                <FormControl>
                  <Input type="email" autoComplete="email" placeholder="ihre@e-mail.ch" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="phone"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Telefon</FormLabel>
                <FormControl>
                  <Input
                    type="tel"
                    autoComplete="tel"
                    placeholder="079 123 45 67"
                    {...field}
                    value={field.value ?? ''}
                  />
                </FormControl>
                <FormDescription>Nur für Rückfragen zu Ihren Terminen.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>Passwort</FormLabel>
                <FormControl>
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
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

                {password ? (
                  <div className="space-y-1.5 pt-1">
                    <div className="flex gap-1" aria-hidden>
                      {[0, 1, 2, 3].map((index) => (
                        <span
                          key={index}
                          className={cn(
                            'h-1 flex-1 rounded-full transition-colors duration-300',
                            index < strength.score
                              ? strength.score <= 1
                                ? 'bg-destructive'
                                : strength.score === 2
                                  ? 'bg-warning'
                                  : 'bg-success'
                              : 'bg-muted',
                          )}
                        />
                      ))}
                    </div>
                    <p className="text-meta text-muted-foreground" aria-live="polite">
                      Passwortstärke: {strength.label}
                      {strength.issues.length > 0 ? ` — ${strength.issues[0]}` : ''}
                    </p>
                  </div>
                ) : null}

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
                  <Input type={showPassword ? 'text' : 'password'} autoComplete="new-password" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Honigfalle */}
          <div aria-hidden className="absolute h-0 w-0 overflow-hidden">
            <label htmlFor="register-website">Website (bitte leer lassen)</label>
            <input id="register-website" tabIndex={-1} autoComplete="off" {...form.register('website')} />
          </div>

          <div className="space-y-3">
            <FormField
              control={form.control}
              name="acceptTerms"
              render={({ field }) => (
                <FormItem>
                  <label className="flex cursor-pointer items-start gap-2.5 text-sm leading-relaxed">
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={(checked) => field.onChange(checked === true)}
                      className="mt-0.5"
                    />
                    <span>
                      Ich akzeptiere die{' '}
                      <Link href="/legal/agb" target="_blank" className="underline underline-offset-2">
                        AGB
                      </Link>{' '}
                      und die{' '}
                      <Link
                        href="/legal/datenschutz"
                        target="_blank"
                        className="underline underline-offset-2"
                      >
                        Datenschutzerklärung
                      </Link>
                      .
                    </span>
                  </label>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="marketingOptIn"
              render={({ field }) => (
                <FormItem>
                  <label className="flex cursor-pointer items-start gap-2.5 text-sm leading-relaxed">
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={(checked) => field.onChange(checked === true)}
                      className="mt-0.5"
                    />
                    <span className="text-muted-foreground">
                      Ich möchte Reinigungstipps und Aktionen per E-Mail erhalten. Abmeldung
                      jederzeit möglich.
                    </span>
                  </label>
                </FormItem>
              )}
            />
          </div>

          <Button type="submit" width="full" size="lg" loading={form.formState.isSubmitting}>
            Konto erstellen
          </Button>
        </form>
      </Form>

      <p className="text-center text-sm text-muted-foreground">
        Sie haben bereits ein Konto?{' '}
        <Link
          href="/auth/anmelden"
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          Anmelden
        </Link>
      </p>
    </div>
  );
}
