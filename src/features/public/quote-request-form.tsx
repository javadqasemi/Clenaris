'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2, Send } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { quoteRequestSchema, type QuoteRequestInput } from '@/lib/validation/crm';
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
 * Offertanfrage.
 *
 * Ausführlicher als das Kontaktformular: wir fragen Objektart, Fläche und
 * Rhythmus ab, weil eine Offerte ohne diese Angaben nur eine Rückfrage
 * auslöst. Alles darüber hinaus bleibt Freitext — Sonderfälle lassen sich
 * nicht in Dropdowns pressen.
 */
const FREQUENCIES = [
  { value: 'ONCE', label: 'Einmalig' },
  { value: 'WEEKLY', label: 'Wöchentlich' },
  { value: 'BIWEEKLY', label: 'Alle zwei Wochen' },
  { value: 'MONTHLY', label: 'Monatlich' },
  { value: 'QUARTERLY', label: 'Vierteljährlich' },
  { value: 'CUSTOM', label: 'Nach Absprache' },
];

export function QuoteRequestForm({
  services,
}: {
  services: { value: string; label: string }[];
}) {
  const [sent, setSent] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const form = useForm<QuoteRequestInput>({
    resolver: zodResolver(quoteRequestSchema),
    defaultValues: {
      firstName: '',
      lastName: '',
      email: '',
      phone: '',
      company: '',
      street: '',
      postalCode: '',
      city: '',
      message: '',
      frequency: 'ONCE',
      fileIds: [],
      acceptPrivacy: false as unknown as true,
      website: '',
    },
  });

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    form.setValue('utmSource', params.get('utm_source') ?? undefined);
    form.setValue('utmMedium', params.get('utm_medium') ?? undefined);
    form.setValue('utmCampaign', params.get('utm_campaign') ?? undefined);
    form.setValue('landingPath', window.location.pathname);
  }, [form]);

  const onSubmit = async (values: QuoteRequestInput) => {
    setError(null);
    try {
      await api.post('/api/public/contact', values);
      trackEvent('quote_requested', { service: values.serviceKind });
      setSent(true);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : 'Die Anfrage konnte nicht gesendet werden. Bitte rufen Sie uns an.';
      setError(message);
      toast.error(message);
    }
  };

  if (sent) {
    return (
      <div className="space-y-5 rounded-2xl border border-success/25 bg-success/8 p-8 text-center">
        <CheckCircle2 className="mx-auto size-10 text-success" aria-hidden />
        <div className="space-y-2">
          <h2 className="font-display text-xl font-bold">Anfrage angekommen</h2>
          <p className="mx-auto max-w-md leading-relaxed text-success/90">
            Wir erstellen Ihre Offerte und senden sie innerhalb von 24 Stunden per E-Mail. Sie
            können sie dann online ansehen und mit einem Klick annehmen.
          </p>
        </div>
      </div>
    );
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6" noValidate>
        {error ? <Alert variant="destructive">{error}</Alert> : null}

        {/* Objekt */}
        <fieldset className="space-y-5">
          <legend className="mb-1 font-display text-lg font-semibold tracking-tight">
            Um welches Objekt geht es?
          </legend>

          <FormField
            control={form.control}
            name="serviceKind"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>Gewünschte Leistung</FormLabel>
                <Select value={field.value ?? ''} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Leistung wählen" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {services.map((service) => (
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

          <div className="grid gap-5 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="squareMeters"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Fläche</FormLabel>
                  <FormControl>
                    <Input
                      inputMode="numeric"
                      suffix="m²"
                      placeholder="120"
                      value={field.value ?? ''}
                      onChange={(event) =>
                        field.onChange(Number(event.target.value.replace(/\D/g, '')) || undefined)
                      }
                    />
                  </FormControl>
                  <FormDescription>Eine Schätzung genügt.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="frequency"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Rhythmus</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {FREQUENCIES.map((frequency) => (
                        <SelectItem key={frequency.value} value={frequency.value}>
                          {frequency.label}
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
              name="street"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>Strasse</FormLabel>
                  <FormControl>
                    <Input autoComplete="address-line1" {...field} value={field.value ?? ''} />
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

            <FormField
              control={form.control}
              name="city"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Ort</FormLabel>
                  <FormControl>
                    <Input autoComplete="address-level2" {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="message"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>Beschreiben Sie Ihre Situation</FormLabel>
                <FormControl>
                  <Textarea
                    rows={6}
                    placeholder="Zum Beispiel: Liegenschaft mit 12 Wohnungen, Treppenhaus über 4 Stockwerke, Waschküche im UG. Aktuell einmal wöchentlich, Winterdienst wäre erwünscht. Übernahme ab 1. März."
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  Je konkreter, desto präziser unsere Offerte — und desto weniger Rückfragen.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </fieldset>

        {/* Kontakt */}
        <fieldset className="space-y-5 border-t border-border pt-6">
          <legend className="mb-1 font-display text-lg font-semibold tracking-tight">
            Wie erreichen wir Sie?
          </legend>

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
                    <Input type="tel" autoComplete="tel" {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="company"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>Firma oder Verwaltung</FormLabel>
                  <FormControl>
                    <Input autoComplete="organization" {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </fieldset>

        <div aria-hidden className="absolute h-0 w-0 overflow-hidden">
          <input tabIndex={-1} autoComplete="off" {...form.register('website')} />
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
                  Ich bin damit einverstanden, dass meine Angaben zur Erstellung der Offerte
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
          Offerte anfordern
        </Button>
      </form>
    </Form>
  );
}
