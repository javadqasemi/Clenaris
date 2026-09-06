'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Save } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { createCustomerSchema, type CreateCustomerInput } from '@/lib/validation/crm';
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
 * Kundendatensatz anlegen.
 *
 * Der Typ (privat/geschäftlich) steht bewusst zuoberst: er entscheidet, ob
 * Firmenname und MWST-Nummer verlangt werden, und ob die Zahlungsfrist von
 * 30 Tagen überhaupt sinnvoll ist. Ein Formular, das diese Weiche erst am
 * Ende stellt, lässt Leute Felder ausfüllen, die sie gar nicht brauchen.
 */
export function CustomerForm() {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);

  const form = useForm<CreateCustomerInput>({
    resolver: zodResolver(createCustomerSchema),
    defaultValues: {
      type: 'PRIVATE',
      firstName: '',
      lastName: '',
      email: '',
      language: 'DE',
      paymentTermDays: 30,
      discountPercent: 0,
      taxExempt: false,
      tagIds: [],
      createLogin: true,
      address: {
        label: 'Hauptadresse',
        street: '',
        postalCode: '',
        city: '',
        country: 'CH',
      },
    } as never,
  });

  const type = form.watch('type');

  const onSubmit = async (values: CreateCustomerInput) => {
    setError(null);
    try {
      const result = await api.post<{ id: string; number: string }>('/api/customers', values);
      toast.success(`Kunde ${result.number} angelegt.`);
      router.push(`/admin/kunden/${result.id}`);
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Der Kunde konnte nicht angelegt werden.';
      setError(message);
      toast.error(message);
    }
  };

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="max-w-3xl space-y-8"
        noValidate
      >
        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <section className="space-y-5 rounded-2xl border border-border bg-card p-6 shadow-soft">
          <h2 className="font-display text-base font-semibold tracking-tight">Stammdaten</h2>

          <FormField
            control={form.control}
            name="type"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>Art</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="PRIVATE">Privatkundschaft</SelectItem>
                    <SelectItem value="BUSINESS">Geschäftskundschaft</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          {type === 'BUSINESS' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="companyName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Firma</FormLabel>
                    <FormControl>
                      <Input {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="vatNumber"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>MWST-Nummer</FormLabel>
                    <FormControl>
                      <Input placeholder="CHE-123.456.789 MWST" {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
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
                      placeholder="+41 31 123 45 67"
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
              name="mobile"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Mobil</FormLabel>
                  <FormControl>
                    <Input type="tel" {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormDescription>Für SMS-Erinnerungen vor dem Termin.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="language"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Korrespondenzsprache</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="DE">Deutsch</SelectItem>
                      <SelectItem value="FR">Français</SelectItem>
                      <SelectItem value="IT">Italiano</SelectItem>
                      <SelectItem value="EN">English</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </section>

        <section className="space-y-5 rounded-2xl border border-border bg-card p-6 shadow-soft">
          <h2 className="font-display text-base font-semibold tracking-tight">Adresse</h2>

          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_6rem]">
            <FormField
              control={form.control}
              name="address.street"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Strasse</FormLabel>
                  <FormControl>
                    <Input autoComplete="address-line1" {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="address.streetNo"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nr.</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-[8rem_minmax(0,1fr)]">
            <FormField
              control={form.control}
              name="address.postalCode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>PLZ</FormLabel>
                  <FormControl>
                    <Input
                      inputMode="numeric"
                      maxLength={4}
                      autoComplete="postal-code"
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
              name="address.city"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Ort</FormLabel>
                  <FormControl>
                    <Input autoComplete="address-level2" {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </section>

        <section className="space-y-5 rounded-2xl border border-border bg-card p-6 shadow-soft">
          <h2 className="font-display text-base font-semibold tracking-tight">
            Konditionen und Zugang
          </h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="paymentTermDays"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Zahlungsfrist (Tage)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      max={180}
                      {...field}
                      onChange={(event) => field.onChange(Number(event.target.value))}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="discountPercent"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Dauerrabatt (%)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step={0.5}
                      {...field}
                      onChange={(event) => field.onChange(Number(event.target.value))}
                    />
                  </FormControl>
                  <FormDescription>Gilt zusätzlich zum Abo-Rabatt.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="createLogin"
            render={({ field }) => (
              <FormItem className="flex items-start gap-3 space-y-0">
                <FormControl>
                  <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
                <div className="space-y-1">
                  <FormLabel>Kundenkonto einrichten und einladen</FormLabel>
                  <FormDescription>
                    Sendet eine E-Mail mit Link zur Passwortvergabe. Ohne Konto sieht die
                    Kundschaft weder Rechnungen noch Termine online.
                  </FormDescription>
                </div>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="internalNotes"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Interne Notizen</FormLabel>
                <FormControl>
                  <Textarea
                    rows={3}
                    placeholder="Schlüsseldepot, Hausordnung, Ansprechperson …"
                    {...field}
                    value={field.value ?? ''}
                  />
                </FormControl>
                <FormDescription>Nur für das Team sichtbar.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </section>

        <div className="flex flex-wrap gap-3">
          <Button type="submit" loading={form.formState.isSubmitting}>
            <Save aria-hidden />
            Kunde anlegen
          </Button>
          <Button type="button" variant="outline" onClick={() => router.back()}>
            Abbrechen
          </Button>
        </div>
      </form>
    </Form>
  );
}
