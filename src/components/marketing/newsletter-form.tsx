'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormMessage } from '@/components/ui/form';
import { api, ApiError } from '@/lib/api/client';
import { newsletterSchema, type NewsletterInput } from '@/lib/validation/crm';

/**
 * Newsletter-Anmeldung mit Double-Opt-in.
 *
 * Das versteckte Feld „website" ist eine Honigfalle: Menschen füllen es nie
 * aus, einfache Bots schon. Zusammen mit dem serverseitigen Rate-Limit ersetzt
 * das ein CAPTCHA — ohne die Nutzung zu erschweren oder Daten an Dritte zu
 * senden.
 */
export function NewsletterForm() {
  const [subscribed, setSubscribed] = React.useState(false);

  const form = useForm<NewsletterInput>({
    resolver: zodResolver(newsletterSchema),
    defaultValues: { email: '', locale: 'DE', source: 'footer', website: '' },
  });

  const onSubmit = async (values: NewsletterInput) => {
    try {
      await api.post('/api/public/newsletter', values);
      setSubscribed(true);
      form.reset();
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : 'Die Anmeldung hat nicht geklappt. Bitte versuchen Sie es später erneut.',
      );
    }
  };

  if (subscribed) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-success/25 bg-success/8 p-4 text-sm text-success">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>
          Fast geschafft. Wir haben Ihnen eine E-Mail geschickt — bestätigen Sie darin Ihre Adresse,
          dann sind Sie dabei.
        </p>
      </div>
    );
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3" noValidate>
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormControl>
                <Input
                  type="email"
                  autoComplete="email"
                  placeholder="ihre@e-mail.ch"
                  aria-label="E-Mail-Adresse für den Newsletter"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Honigfalle — für Menschen unsichtbar, für Bots verlockend. */}
        <div aria-hidden className="absolute h-0 w-0 overflow-hidden">
          <label htmlFor="newsletter-website">Website (bitte leer lassen)</label>
          <input
            id="newsletter-website"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            {...form.register('website')}
          />
        </div>

        <Button type="submit" width="full" loading={form.formState.isSubmitting}>
          Anmelden
          <ArrowRight aria-hidden />
        </Button>

        <p className="text-xs leading-relaxed text-muted-foreground">
          Mit der Anmeldung stimmen Sie unserer{' '}
          <a href="/legal/datenschutz" className="underline underline-offset-2">
            Datenschutzerklärung
          </a>{' '}
          zu.
        </p>
      </form>
    </Form>
  );
}
