'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Save } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { updateProfileSchema, type UpdateProfileInput } from '@/lib/validation/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/primitives';
import { Switch } from '@/components/ui/controls';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/controls';
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
 * Profildaten bearbeiten.
 *
 * Die Benachrichtigungsschalter stehen im selben Formular wie die
 * Kontaktdaten: wer die Telefonnummer ändert, entscheidet meist gleichzeitig,
 * ob er SMS erhalten möchte.
 */
const LOCALES = [
  { value: 'DE', label: 'Deutsch' },
  { value: 'FR', label: 'Französisch' },
  { value: 'IT', label: 'Italienisch' },
  { value: 'EN', label: 'Englisch' },
];

export function ProfileForm({
  defaults,
}: {
  defaults: {
    firstName: string;
    lastName: string;
    phone: string;
    locale: string;
    notifyByEmail: boolean;
    notifyBySms: boolean;
    marketingOptIn: boolean;
  };
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);

  const form = useForm<UpdateProfileInput>({
    resolver: zodResolver(updateProfileSchema),
    defaultValues: defaults as never,
  });

  const onSubmit = async (values: UpdateProfileInput) => {
    setError(null);
    try {
      await api.patch('/api/account/profile', values);
      toast.success('Profil gespeichert.');
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Das Profil konnte nicht gespeichert werden.';
      setError(message);
      toast.error(message);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6" noValidate>
        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <div className="grid gap-5 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="firstName"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>Vorname</FormLabel>
                <FormControl>
                  <Input autoComplete="given-name" {...field} />
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
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="locale"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Sprache</FormLabel>
                <Select value={field.value ?? 'DE'} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {LOCALES.map((locale) => (
                      <SelectItem key={locale.value} value={locale.value}>
                        {locale.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>Sprache für E-Mails und Dokumente.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <fieldset className="space-y-4 border-t border-border pt-6">
          <legend className="mb-2 font-display text-sm font-semibold">Benachrichtigungen</legend>

          {[
            {
              name: 'notifyByEmail' as const,
              label: 'E-Mail-Benachrichtigungen',
              description:
                'Terminbestätigungen, Erinnerungen und Rechnungen. Wir empfehlen, das eingeschaltet zu lassen.',
            },
            {
              name: 'notifyBySms' as const,
              label: 'SMS-Erinnerungen',
              description: 'Kurznachricht zwei Stunden vor dem Termin.',
            },
            {
              name: 'marketingOptIn' as const,
              label: 'Newsletter und Aktionen',
              description: 'Rund einmal im Monat, jederzeit abbestellbar.',
            },
          ].map((item) => (
            <FormField
              key={item.name}
              control={form.control}
              name={item.name}
              render={({ field }) => (
                <FormItem>
                  <label className="flex cursor-pointer items-start justify-between gap-4">
                    <span className="space-y-0.5">
                      <span className="block text-sm font-medium">{item.label}</span>
                      <span className="block text-sm leading-relaxed text-muted-foreground">
                        {item.description}
                      </span>
                    </span>
                    <Switch
                      checked={field.value ?? false}
                      onCheckedChange={field.onChange}
                      aria-label={item.label}
                    />
                  </label>
                </FormItem>
              )}
            />
          ))}
        </fieldset>

        <Button type="submit" loading={form.formState.isSubmitting}>
          <Save aria-hidden />
          Änderungen speichern
        </Button>
      </form>
    </Form>
  );
}
