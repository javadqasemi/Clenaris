'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2, Send } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { contactFormSchema, type ContactFormInput } from '@/lib/validation/crm';
import { trackEvent } from '@/components/marketing/analytics';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/primitives';
import { Checkbox } from '@/components/ui/controls';
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
 * Kontaktformular.
 *
 * Jede Absendung erzeugt einen Lead im CRM — nicht nur eine E-Mail. Anfragen,
 * die nur im Postfach landen, gehen im Tagesgeschäft verloren, und die
 * Conversion-Rate lässt sich dann nicht messen.
 *
 * UTM-Parameter und der Verweis werden mitgesendet, damit sichtbar wird, welche
 * Kampagne tatsächlich Aufträge bringt.
 */
const SERVICES = [
  { value: 'RESIDENTIAL_CLEANING', label: 'Unterhaltsreinigung' },
  { value: 'MOVE_OUT_CLEANING', label: 'Umzugsreinigung' },
  { value: 'OFFICE_CLEANING', label: 'Büroreinigung' },
  { value: 'WINDOW_CLEANING', label: 'Fensterreinigung' },
  { value: 'CONSTRUCTION_CLEANING', label: 'Baureinigung' },
  { value: 'BUILDING_MAINTENANCE', label: 'Hauswartung' },
  { value: 'SPECIAL', label: 'Etwas anderes' },
];

export function ContactForm() {
  const [sent, setSent] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const form = useForm<ContactFormInput>({
    resolver: zodResolver(contactFormSchema),
    defaultValues: {
      firstName: '',
      lastName: '',
      email: '',
      phone: '',
      company: '',
      postalCode: '',
      message: '',
      acceptPrivacy: false as unknown as true,
      website: '',
    },
  });

  // Kampagnenherkunft erst im Browser auslesen.
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    form.setValue('utmSource', params.get('utm_source') ?? undefined);
    form.setValue('utmMedium', params.get('utm_medium') ?? undefined);
    form.setValue('utmCampaign', params.get('utm_campaign') ?? undefined);
    form.setValue('referrerUrl', document.referrer?.slice(0, 500) || undefined);
    form.setValue('landingPath', window.location.pathname);
  }, [form]);

  const onSubmit = async (values: ContactFormInput) => {
    setError(null);
    try {
      await api.post('/api/public/contact', values);
      trackEvent('quote_requested', { service: values.serviceKind ?? 'unbekannt' });
      setSent(true);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : 'Die Nachricht konnte nicht gesendet werden. Bitte rufen Sie uns an.';
      setError(message);
      toast.error(message);
    }
  };

  if (sent) {
    return (
      <div className="space-y-5 rounded-2xl border border-success/25 bg-success/8 p-8 text-center">
        <CheckCircle2 className="mx-auto size-10 text-success" aria-hidden />
        <div className="space-y-2">
          <h2 className="font-display text-xl font-bold">Nachricht angekommen</h2>
          <p className="mx-auto max-w-md leading-relaxed text-success/90">
            Wir melden uns innerhalb eines Arbeitstages bei Ihnen. Eine Eingangsbestätigung liegt
            bereits in Ihrem Postfach.
          </p>
        </div>
        <Button variant="outline" onClick={() => setSent(false)}>
          Weitere Nachricht schreiben
        </Button>
      </div>
    );
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" noValidate>
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
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>E-Mail</FormLabel>
                <FormControl>
                  <Input type="email" autoComplete="email" {...field} />
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
                <FormDescription>Für Rückfragen — geht meist schneller.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="company"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Firma</FormLabel>
                <FormControl>
                  <Input autoComplete="organization" {...field} value={field.value ?? ''} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="postalCode"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Postleitzahl</FormLabel>
                <FormControl>
                  <Input
                    inputMode="numeric"
                    maxLength={4}
                    placeholder="3011"
                    {...field}
                    value={field.value ?? ''}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="serviceKind"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Worum geht es?</FormLabel>
              <Select value={field.value ?? ''} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Leistung wählen (optional)" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {SERVICES.map((service) => (
                    <SelectItem key={service.value} value={service.value}>
                      {service.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="message"
          render={({ field }) => (
            <FormItem>
              <FormLabel required>Ihre Nachricht</FormLabel>
              <FormControl>
                <Textarea
                  rows={5}
                  placeholder="Beschreiben Sie kurz Ihr Anliegen: Objekt, Fläche, Wunschtermin. Je konkreter, desto präziser unsere Antwort."
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Honigfalle gegen Formular-Bots */}
        <div aria-hidden className="absolute h-0 w-0 overflow-hidden">
          <label htmlFor="contact-website">Website (bitte leer lassen)</label>
          <input id="contact-website" tabIndex={-1} autoComplete="off" {...form.register('website')} />
        </div>

        <FormField
          control={form.control}
          name="acceptPrivacy"
          render={({ field }) => (
            <FormItem>
              <label className="flex cursor-pointer items-start gap-2.5 text-sm leading-relaxed">
                <Checkbox
                  checked={field.value}
                  onCheckedChange={(checked) => field.onChange(checked === true)}
                  className="mt-0.5"
                />
                <span>
                  Ich bin damit einverstanden, dass meine Angaben zur Bearbeitung der Anfrage
                  gespeichert werden.{' '}
                  <a
                    href="/legal/datenschutz"
                    target="_blank"
                    className="underline underline-offset-2"
                  >
                    Datenschutzerklärung
                  </a>
                </span>
              </label>
              <FormMessage />
            </FormItem>
          )}
        />

        <Button type="submit" size="lg" loading={form.formState.isSubmitting}>
          <Send aria-hidden />
          Nachricht senden
        </Button>
      </form>
    </Form>
  );
}
