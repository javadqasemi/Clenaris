'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Save } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { createLeadSchema, type CreateLeadInput } from '@/lib/validation/crm';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/primitives';
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
 * Anfrage von Hand erfassen.
 *
 * Der häufigste Fall: jemand ruft an. Deshalb sind nur Name, E-Mail und die
 * Nachricht Pflicht — alles andere lässt sich später ergänzen. Ein Formular,
 * das am Telefon zwölf Felder verlangt, wird nach dem Gespräch ausgefüllt
 * oder gar nicht.
 */
const SOURCES = [
  { value: 'PHONE', label: 'Telefon' },
  { value: 'EMAIL', label: 'E-Mail' },
  { value: 'WEBSITE', label: 'Website' },
  { value: 'REFERRAL', label: 'Empfehlung' },
  { value: 'WALK_IN', label: 'Laufkundschaft' },
  { value: 'PARTNER', label: 'Partner' },
  { value: 'GOOGLE_ADS', label: 'Google Ads' },
  { value: 'META_ADS', label: 'Meta Ads' },
  { value: 'OTHER', label: 'Anderes' },
] as const;

const SERVICES = [
  { value: 'OFFICE_CLEANING', label: 'Büroreinigung' },
  { value: 'MOVE_OUT_CLEANING', label: 'Umzugsreinigung' },
  { value: 'RESIDENTIAL_CLEANING', label: 'Wohnungsreinigung' },
  { value: 'WINDOW_CLEANING', label: 'Fensterreinigung' },
  { value: 'CONSTRUCTION_CLEANING', label: 'Baureinigung' },
  { value: 'BUILDING_MAINTENANCE', label: 'Hauswartung' },
  { value: 'SPECIAL', label: 'Spezialreinigung' },
] as const;

export function LeadForm({
  stages,
  employees,
}: {
  stages: { id: string; name: string }[];
  employees: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);

  const form = useForm<CreateLeadInput>({
    resolver: zodResolver(createLeadSchema),
    defaultValues: {
      firstName: '',
      lastName: '',
      email: '',
      source: 'PHONE',
      stageId: stages[0]?.id,
      tagIds: [],
    } as never,
  });

  const onSubmit = async (values: CreateLeadInput) => {
    setError(null);
    try {
      const result = await api.post<{ id: string; number: string }>('/api/leads', values);
      toast.success(`Anfrage ${result.number} erfasst.`);
      router.push(`/admin/leads/${result.id}`);
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Die Anfrage konnte nicht erfasst werden.';
      setError(message);
      toast.error(message);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="max-w-3xl space-y-8" noValidate>
        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <section className="space-y-5 rounded-2xl border border-border bg-card p-6 shadow-soft">
          <h2 className="font-display text-base font-semibold tracking-tight">Kontakt</h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="firstName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Vorname</FormLabel>
                  <FormControl>
                    <Input {...field} />
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
                    <Input {...field} />
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
                    <Input type="email" {...field} />
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
                    <Input type="tel" {...field} value={field.value ?? ''} />
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
                  <FormLabel>Firma</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem_minmax(0,1fr)]">
            <FormField
              control={form.control}
              name="street"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Strasse</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ''} />
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
                  <FormLabel>PLZ</FormLabel>
                  <FormControl>
                    <Input inputMode="numeric" maxLength={4} {...field} value={field.value ?? ''} />
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
                    <Input {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </section>

        <section className="space-y-5 rounded-2xl border border-border bg-card p-6 shadow-soft">
          <h2 className="font-display text-base font-semibold tracking-tight">Anliegen</h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="serviceKind"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Leistung</FormLabel>
                  <Select
                    value={field.value ?? 'none'}
                    onValueChange={(value) => field.onChange(value === 'none' ? undefined : value)}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Noch offen" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="none">Noch offen</SelectItem>
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
              name="estimatedValue"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Erwarteter Auftragswert (CHF)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      step={50}
                      value={field.value ?? ''}
                      onChange={(event) =>
                        field.onChange(
                          event.target.value === '' ? undefined : Number(event.target.value),
                        )
                      }
                    />
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
                <FormLabel>Notiz zum Gespräch</FormLabel>
                <FormControl>
                  <Textarea
                    rows={5}
                    placeholder="Was wurde besprochen? Objektgrösse, Termin, Besonderheiten …"
                    {...field}
                    value={field.value ?? ''}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </section>

        <section className="space-y-5 rounded-2xl border border-border bg-card p-6 shadow-soft">
          <h2 className="font-display text-base font-semibold tracking-tight">Zuordnung</h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="source"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Herkunft</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {SOURCES.map((source) => (
                        <SelectItem key={source.value} value={source.value}>
                          {source.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {stages.length > 0 ? (
              <FormField
                control={form.control}
                name="stageId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Pipeline-Stufe</FormLabel>
                    <Select value={field.value ?? 'none'} onValueChange={(value) => field.onChange(value === 'none' ? undefined : value)}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Ohne Zuordnung" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="none">Ohne Zuordnung</SelectItem>
                        {stages.map((stage) => (
                          <SelectItem key={stage.id} value={stage.id}>
                            {stage.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : null}

            <FormField
              control={form.control}
              name="ownerId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Zuständig</FormLabel>
                  <Select
                    value={field.value ?? 'none'}
                    onValueChange={(value) => field.onChange(value === 'none' ? undefined : value)}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Niemand" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="none">Niemand</SelectItem>
                      {employees.map((employee) => (
                        <SelectItem key={employee.id} value={employee.id}>
                          {employee.name}
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
              name="nextFollowUpAt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nachfassen am</FormLabel>
                  <FormControl>
                    <Input
                      type="date"
                      value={
                        field.value instanceof Date
                          ? field.value.toISOString().slice(0, 10)
                          : (field.value ?? '')
                      }
                      onChange={(event) =>
                        field.onChange(event.target.value ? new Date(event.target.value) : undefined)
                      }
                    />
                  </FormControl>
                  <FormDescription>
                    Erzeugt am Stichtag eine Erinnerung im Aufgabenbereich.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </section>

        <div className="flex flex-wrap gap-3">
          <Button type="submit" loading={form.formState.isSubmitting}>
            <Save aria-hidden />
            Anfrage erfassen
          </Button>
          <Button type="button" variant="outline" onClick={() => router.back()}>
            Abbrechen
          </Button>
        </div>
      </form>
    </Form>
  );
}
