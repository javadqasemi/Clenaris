'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Save } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { updateCompanySchema, type UpdateCompanyInput } from '@/lib/validation/cms';
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
import { DetailSection } from '@/components/app/page-parts';

/**
 * Firmenstammdaten bearbeiten.
 *
 * Gestaltungsentscheide:
 *
 *  • **Ein Formular, vier Gruppen, ein Speichern.** Die Felder gehören
 *    zusammen — wer die Adresse ändert, ändert oft auch die Telefonnummer.
 *    Vier getrennte Formulare bedeuteten vier Speichervorgänge und vier
 *    Gelegenheiten, eines davon zu vergessen.
 *
 *  • **Die Schaltfläche erscheint erst, wenn sich etwas geändert hat.** Ein
 *    immer aktives „Speichern" auf einer Seite mit dreiundzwanzig Feldern lädt
 *    zum versehentlichen Klick ein; ein ausgegrautes verwirrt. Sichtbar wird
 *    sie zusammen mit dem Hinweis, was noch nicht gespeichert ist.
 *
 *  • **Die IBAN wird beim Speichern geprüft, nicht beim Tippen.** Eine
 *    Prüfsummenmeldung nach dem vierten Zeichen ist immer rot und immer
 *    unnütz.
 */

const GROUPS: { title: string; hint?: string; fields: FieldSpec[] }[] = [
  {
    title: 'Firmenangaben',
    fields: [
      { name: 'name', label: 'Name', required: true, placeholder: 'Clenaris' },
      {
        name: 'legalName',
        label: 'Firma (rechtlich)',
        placeholder: 'Clenaris GmbH',
        description: 'Erscheint im Impressum und auf Rechnungen.',
      },
      { name: 'email', label: 'E-Mail', required: true, type: 'email' },
      { name: 'phone', label: 'Telefon', placeholder: '+41 31 123 45 67' },
      {
        name: 'whatsapp',
        label: 'WhatsApp',
        placeholder: '+41 79 123 45 67',
        description: 'Leer lassen, wenn kein WhatsApp-Knopf erscheinen soll.',
      },
      { name: 'website', label: 'Website', placeholder: 'https://clenaris.ch' },
      { name: 'vatNumber', label: 'MWST-Nummer', placeholder: 'CHE-123.456.789 MWST' },
    ],
  },
  {
    title: 'Adresse',
    fields: [
      { name: 'street', label: 'Strasse', required: true, className: 'sm:col-span-2' },
      { name: 'streetNo', label: 'Nummer' },
      { name: 'postalCode', label: 'PLZ', required: true, placeholder: '3011' },
      { name: 'city', label: 'Ort', required: true, placeholder: 'Bern' },
    ],
  },
  {
    title: 'Bankverbindung',
    hint: 'Ohne QR-IBAN tragen Rechnungen keine QR-Referenz — der Einzahlungsschein funktioniert dann nur mit manueller Zuordnung.',
    fields: [
      { name: 'bankName', label: 'Bank', placeholder: 'Berner Kantonalbank' },
      { name: 'iban', label: 'IBAN', placeholder: 'CH93 0076 2011 6238 5295 7' },
      { name: 'qrIban', label: 'QR-IBAN', placeholder: 'CH44 3199 9123 0008 8901 2' },
    ],
  },
  {
    title: 'Bilder',
    hint: 'Adressen aus der Mediathek. Fehlt ein Logo, wird die Wortmarke gesetzt.',
    fields: [
      { name: 'logoUrl', label: 'Logo (hell)' },
      { name: 'logoDarkUrl', label: 'Logo (dunkel)' },
      { name: 'faviconUrl', label: 'Favicon' },
    ],
  },
  {
    title: 'Karte und soziale Netzwerke',
    hint: 'Leere Felder erzeugen kein Symbol — ein Verweis ins Leere ist schlimmer als keiner.',
    fields: [
      { name: 'mapsUrl', label: 'Karte' },
      { name: 'facebookUrl', label: 'Facebook' },
      { name: 'instagramUrl', label: 'Instagram' },
      { name: 'linkedinUrl', label: 'LinkedIn' },
      { name: 'tiktokUrl', label: 'TikTok' },
      { name: 'youtubeUrl', label: 'YouTube' },
    ],
  },
];

interface FieldSpec {
  name: keyof UpdateCompanyInput;
  label: string;
  required?: boolean;
  type?: string;
  placeholder?: string;
  description?: string;
  className?: string;
}

export function CompanyForm({ company }: { company: UpdateCompanyInput }) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);

  const form = useForm<UpdateCompanyInput>({
    resolver: zodResolver(updateCompanySchema),
    // Kein Feld darf `undefined` sein, sonst wechselt das Eingabefeld beim
    // ersten Tastendruck von ungesteuert zu gesteuert — React beschwert sich
    // zu Recht, und der Cursor springt.
    defaultValues: normalize(company),
  });

  const onSubmit = async (values: UpdateCompanyInput) => {
    setError(null);
    try {
      await api.patch('/api/company', values);
      toast.success('Firmendaten gespeichert.');
      form.reset(values);
      router.refresh();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Speichern fehlgeschlagen.';
      setError(message);
      toast.error(message);
    }
  };

  const dirty = form.formState.isDirty;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6" noValidate>
        {error ? <Alert variant="destructive">{error}</Alert> : null}

        {GROUPS.map((group) => (
          <DetailSection
            key={group.title}
            title={group.title}
            description={group.hint}
            body="flush"
          >
            <div className="grid gap-5 px-6 py-5 sm:grid-cols-2">
              {group.fields.map((spec) => (
                <FormField
                  key={spec.name}
                  control={form.control}
                  name={spec.name}
                  render={({ field }) => (
                    <FormItem className={spec.className}>
                      <FormLabel required={spec.required}>{spec.label}</FormLabel>
                      <FormControl>
                        <Input
                          type={spec.type}
                          placeholder={spec.placeholder}
                          {...field}
                          value={field.value ?? ''}
                        />
                      </FormControl>
                      {spec.description ? (
                        <FormDescription>{spec.description}</FormDescription>
                      ) : null}
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ))}
            </div>
          </DetailSection>
        ))}

        {dirty ? (
          <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-primary/25 bg-card/95 p-4 shadow-elevated backdrop-blur">
            <p className="text-sm text-muted-foreground">
              Nicht gespeicherte Änderungen. Sie wirken sofort auf Website, Rechnungen und
              Buchungsassistent.
            </p>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => form.reset()}>
                Verwerfen
              </Button>
              <Button type="submit" loading={form.formState.isSubmitting}>
                <Save aria-hidden />
                Speichern
              </Button>
            </div>
          </div>
        ) : null}
      </form>
    </Form>
  );
}

/** Aus `null`/`undefined` wird der leere String — siehe Kommentar oben. */
function normalize(company: UpdateCompanyInput): UpdateCompanyInput {
  const out = {} as Record<string, string>;
  for (const group of GROUPS) {
    for (const spec of group.fields) {
      out[spec.name] = (company[spec.name] as string | null | undefined) ?? '';
    }
  }
  return out as unknown as UpdateCompanyInput;
}
