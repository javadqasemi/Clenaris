'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { KeyRound } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { changePasswordSchema, type ChangePasswordInput } from '@/lib/validation/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
 * Passwortwechsel im angemeldeten Zustand.
 *
 * Das aktuelle Passwort ist Pflicht: sonst könnte jemand an einem unbeaufsichtigt
 * offenen Gerät das Konto übernehmen. Nach dem Wechsel widerruft der Server
 * alle anderen Sitzungen.
 */
export function PasswordChangeForm() {
  const [success, setSuccess] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const form = useForm<ChangePasswordInput>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: '', password: '', confirmPassword: '' },
  });

  const onSubmit = async (values: ChangePasswordInput) => {
    setError(null);
    setSuccess(false);
    try {
      await api.patch('/api/auth/password', values);
      form.reset();
      setSuccess(true);
      toast.success('Passwort geändert. Andere Sitzungen wurden beendet.');
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Das Passwort konnte nicht geändert werden.';
      setError(message);
      toast.error(message);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="max-w-md space-y-5" noValidate>
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        {success ? (
          <Alert variant="success">
            Ihr Passwort wurde geändert. Alle anderen angemeldeten Geräte wurden abgemeldet.
          </Alert>
        ) : null}

        <FormField
          control={form.control}
          name="currentPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel required>Aktuelles Passwort</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="current-password" {...field} />
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
              <FormLabel required>Neues Passwort</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="new-password" {...field} />
              </FormControl>
              <FormDescription>
                Mindestens 10 Zeichen, ein Grossbuchstabe und eine Ziffer.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="confirmPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel required>Neues Passwort wiederholen</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="new-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <Button type="submit" loading={form.formState.isSubmitting}>
          <KeyRound aria-hidden />
          Passwort ändern
        </Button>
      </form>
    </Form>
  );
}
