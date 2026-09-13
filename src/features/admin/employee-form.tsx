'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Save } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { createEmployeeSchema, type CreateEmployeeInput } from '@/lib/validation/operations';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  Label,
} from '@/components/ui/form';
import { DetailSection } from '@/components/app/page-parts';

/**
 * Mitarbeitende/n anlegen.
 *
 * Die Reihenfolge folgt dem Eintrittsprozess: erst Person und Konto, dann
 * Anstellung, dann die Schweizer Personaldaten. AHV-Nummer und IBAN stehen
 * zuunterst und sind freiwillig — sie kommen typischerweise erst mit dem
 * unterschriebenen Vertrag, und ein Pflichtfeld hier würde das Anlegen bis
 * dahin blockieren.
 */
const EMPLOYMENT_TYPES = [
  { value: 'FULL_TIME', label: 'Vollzeit' },
  { value: 'PART_TIME', label: 'Teilzeit' },
  { value: 'HOURLY', label: 'Im Stundenlohn' },
  { value: 'TEMPORARY', label: 'Befristet' },
  { value: 'APPRENTICE', label: 'Lernende/r' },
  { value: 'CONTRACTOR', label: 'Auf Mandat' },
] as const;

const PERMITS = ['CH', 'B', 'C', 'G', 'L', 'F', 'N'] as const;

const LANGUAGES = [
  { value: 'DE', label: 'Deutsch' },
  { value: 'FR', label: 'Französisch' },
  { value: 'IT', label: 'Italienisch' },
  { value: 'EN', label: 'Englisch' },
] as const;

/** Kalenderfarben — aus der Dispositionspalette, nicht frei wählbar. */
const COLORS = ['#0B7285', '#B08900', '#7048E8', '#C0392B', '#2B8A3E', '#1864AB'];

export function EmployeeForm() {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);

  const form = useForm<CreateEmployeeInput>({
    resolver: zodResolver(createEmployeeSchema),
    defaultValues: {
      firstName: '',
      lastName: '',
      email: '',
      role: 'EMPLOYEE',
      employmentType: 'FULL_TIME',
      position: 'Reinigungskraft',
      hiredAt: new Date().toISOString().slice(0, 10) as unknown as Date,
      workloadPct: 100,
      vacationDaysPerYear: 20,
      driverLicense: false,
      languages: ['DE'],
      color: COLORS[0],
      sendInvite: true,
    } as never,
  });

  const languages = form.watch('languages') ?? [];
  const color = form.watch('color');

  const onSubmit = async (values: CreateEmployeeInput) => {
    setError(null);
    try {
      const result = await api.post<{ id: string; employeeNumber: string }>(
        '/api/employees',
        values,
      );
      toast.success(`Personalnummer ${result.employeeNumber} angelegt. Einladung versendet.`);
      router.push(`/admin/personal/${result.id}`);
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Der Datensatz konnte nicht angelegt werden.';
      setError(message);
      toast.error(message);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="max-w-3xl space-y-8" noValidate>
        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <DetailSection title="Person und Konto" body="form">

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
                  <FormDescription>Zugleich der Login fürs Mitarbeiterportal.</FormDescription>
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
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Rolle</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="EMPLOYEE">Mitarbeitende/r</SelectItem>
                      <SelectItem value="MANAGER">Betriebsleitung</SelectItem>
                      <SelectItem value="ADMIN">Administration</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Administration sieht Löhne und Einstellungen, Betriebsleitung nicht.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </DetailSection>

        <DetailSection title="Anstellung" body="form">

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="position"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Funktion</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="employmentType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Anstellungsart</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {EMPLOYMENT_TYPES.map((type) => (
                        <SelectItem key={type.value} value={type.value}>
                          {type.label}
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
              name="hiredAt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Eintritt</FormLabel>
                  <FormControl>
                    <Input
                      type="date"
                      value={String(field.value ?? '').slice(0, 10)}
                      onChange={(event) => field.onChange(event.target.value)}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="workloadPct"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Pensum (%)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={10}
                      max={100}
                      step={5}
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
              name="hourlyRate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Stundenansatz (CHF)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      step={0.05}
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
            <FormField
              control={form.control}
              name="monthlySalary"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Monatslohn (CHF)</FormLabel>
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
                  <FormDescription>Entweder Stundenansatz oder Monatslohn.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="vacationDaysPerYear"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Ferientage pro Jahr</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      max={60}
                      step={0.5}
                      {...field}
                      onChange={(event) => field.onChange(Number(event.target.value))}
                    />
                  </FormControl>
                  <FormDescription>
                    Gesetzliches Minimum: 20 Tage, unter 20 Jahren 25 (Art. 329a OR).
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Kalenderfarbe</legend>
            <div className="flex flex-wrap gap-2">
              {COLORS.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-label={`Farbe ${value}`}
                  aria-pressed={color === value}
                  onClick={() => form.setValue('color', value)}
                  className="size-9 rounded-xl ring-offset-2 ring-offset-card transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:ring-2 aria-pressed:ring-foreground"
                  style={{ backgroundColor: value }}
                />
              ))}
            </div>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Sprachen</legend>
            <div className="flex flex-wrap gap-4">
              {LANGUAGES.map((language) => (
                <Label
                  key={language.value}
                  className="flex items-center gap-2 font-normal"
                  htmlFor={`lang-${language.value}`}
                >
                  <Checkbox
                    id={`lang-${language.value}`}
                    checked={languages.includes(language.value)}
                    onCheckedChange={(checked) => {
                      const next = checked
                        ? [...languages, language.value]
                        : languages.filter((item) => item !== language.value);
                      form.setValue('languages', next.length ? next : ['DE']);
                    }}
                  />
                  {language.label}
                </Label>
              ))}
            </div>
          </fieldset>

          <FormField
            control={form.control}
            name="driverLicense"
            render={({ field }) => (
              <FormItem className="flex items-center gap-3 space-y-0">
                <FormControl>
                  <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
                <FormLabel className="font-normal">
                  Führerausweis vorhanden — kann Einsatzfahrzeug übernehmen
                </FormLabel>
              </FormItem>
            )}
          />
        </DetailSection>

        <DetailSection title="Personaldaten" body="form">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Diese Angaben sieht nur die Administration. Sie lassen sich später ergänzen — für das
            Anlegen sind sie nicht nötig.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="ahvNumber"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>AHV-Nummer</FormLabel>
                  <FormControl>
                    <Input placeholder="756.1234.5678.90" {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="iban"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>IBAN</FormLabel>
                  <FormControl>
                    <Input placeholder="CH.." {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="nationality"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nationalität</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="permitType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Bewilligung</FormLabel>
                  <Select
                    value={field.value ?? 'none'}
                    onValueChange={(value) => field.onChange(value === 'none' ? undefined : value)}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Keine Angabe" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="none">Keine Angabe</SelectItem>
                      {PERMITS.map((permit) => (
                        <SelectItem key={permit} value={permit}>
                          {permit}
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
              name="emergencyContact"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notfallkontakt</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="emergencyPhone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notfallnummer</FormLabel>
                  <FormControl>
                    <Input type="tel" {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </DetailSection>

        <div className="flex flex-wrap gap-3">
          <Button type="submit" loading={form.formState.isSubmitting}>
            <Save aria-hidden />
            Anlegen und einladen
          </Button>
          <Button type="button" variant="outline" onClick={() => router.back()}>
            Abbrechen
          </Button>
        </div>
      </form>
    </Form>
  );
}
