'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Save } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api/client';
import { formatCurrency } from '@/lib/utils';
import {
  createServiceSchema,
  PRICING_MODELS,
  SERVICE_KINDS,
  slugify,
  type CreateServiceInput,
} from '@/lib/validation/catalog';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/primitives';
import { Checkbox, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/controls';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/overlays';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';

import {
  describeError,
  linesToList,
  listToLines,
  PRICING_LABELS,
  SERVICE_KIND_LABELS,
  toNumberInput,
} from './shared';

/**
 * Leistung anlegen und bearbeiten.
 *
 * Gestaltungsentscheide:
 *
 *  • **Ein Seitenpanel, keine eigene Seite.** Wer einen Stundenansatz
 *    korrigiert, will die Liste danach unverändert wiederfinden — mit
 *    derselben Sortierung und an derselben Stelle. Ein Seitenwechsel und
 *    zurück verliert beides.
 *
 *  • **Das Preismodell blendet die Felder um, die es braucht.** Ein
 *    Stundenansatz neben einem Quadratmeteransatz zu zeigen, von denen einer
 *    immer wirkungslos ist, lädt zum Ausfüllen des falschen ein. Die
 *    Preisvorschau darunter rechnet mit denselben Regeln wie der Server.
 *
 *  • **Der Kurzname folgt dem Namen, bis jemand ihn anfasst.** Danach nie
 *    wieder: bei einer bestehenden Leistung ist er eine indexierte Adresse,
 *    und sie beim Umbenennen still zu ändern, wäre der teuerste denkbare
 *    Automatismus.
 */
export interface ServiceRow {
  id: string;
  slug: string;
  kind: string;
  name: string;
  shortDesc: string;
  description: string;
  icon: string;
  heroImage: string | null;
  active: boolean;
  featured: boolean;
  position: number;
  categoryId: string | null;
  pricingModel: string;
  basePrice: number;
  hourlyRate: number | null;
  pricePerSqm: number | null;
  minPrice: number;
  minHours: number;
  vatRate: number;
  defaultDurationMin: number;
  minutesPerSqm: number;
  defaultCrewSize: number;
  bufferMinutes: number;
  bulletPoints: string[];
  includes: string[];
  excludes: string[];
  seoTitle: string | null;
  seoDescription: string | null;
  keywords: string[];
}

const EMPTY: CreateServiceInput = {
  name: '',
  slug: '',
  kind: 'RESIDENTIAL_CLEANING',
  categoryId: null,
  shortDesc: '',
  description: '',
  icon: 'Sparkles',
  heroImage: undefined,
  active: true,
  featured: false,
  position: 0,
  pricingModel: 'PER_HOUR',
  basePrice: 0,
  hourlyRate: 65,
  pricePerSqm: null,
  minPrice: 0,
  minHours: 2,
  vatRate: 8.1,
  defaultDurationMin: 120,
  minutesPerSqm: 1.2,
  defaultCrewSize: 1,
  bufferMinutes: 30,
  bulletPoints: [],
  includes: [],
  excludes: [],
  seoTitle: undefined,
  seoDescription: undefined,
  keywords: [],
};

function toFormValues(service: ServiceRow): CreateServiceInput {
  return {
    name: service.name,
    slug: service.slug,
    kind: service.kind as CreateServiceInput['kind'],
    categoryId: service.categoryId,
    shortDesc: service.shortDesc,
    description: service.description,
    icon: service.icon,
    heroImage: service.heroImage ?? undefined,
    active: service.active,
    featured: service.featured,
    position: service.position,
    pricingModel: service.pricingModel as CreateServiceInput['pricingModel'],
    basePrice: service.basePrice,
    hourlyRate: service.hourlyRate,
    pricePerSqm: service.pricePerSqm,
    minPrice: service.minPrice,
    minHours: service.minHours,
    vatRate: service.vatRate,
    defaultDurationMin: service.defaultDurationMin,
    minutesPerSqm: service.minutesPerSqm,
    defaultCrewSize: service.defaultCrewSize,
    bufferMinutes: service.bufferMinutes,
    bulletPoints: service.bulletPoints,
    includes: service.includes,
    excludes: service.excludes,
    seoTitle: service.seoTitle ?? undefined,
    seoDescription: service.seoDescription ?? undefined,
    keywords: service.keywords,
  };
}

export function ServiceForm({
  open,
  onOpenChange,
  service,
  categories,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Ohne Angabe wird eine neue Leistung angelegt. */
  service?: ServiceRow;
  categories: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [slugTouched, setSlugTouched] = React.useState(false);

  const form = useForm<CreateServiceInput>({
    resolver: zodResolver(createServiceSchema),
    defaultValues: service ? toFormValues(service) : EMPTY,
  });

  // Beim Öffnen den Stand des gewählten Eintrags übernehmen. Ohne das zeigte
  // das Panel nach dem zweiten Öffnen noch die Werte des ersten.
  React.useEffect(() => {
    if (!open) return;
    form.reset(service ? toFormValues(service) : EMPTY);
    setSlugTouched(Boolean(service));
    setError(null);
  }, [open, service, form]);

  const model = form.watch('pricingModel');
  const name = form.watch('name');

  React.useEffect(() => {
    if (slugTouched || service) return;
    form.setValue('slug', slugify(name ?? ''), { shouldValidate: false });
  }, [name, slugTouched, service, form]);

  const onSubmit = async (values: CreateServiceInput) => {
    setError(null);
    try {
      if (service) {
        await api.patch(`/api/services/${service.id}`, values);
        toast.success(`„${values.name}" gespeichert.`);
      } else {
        await api.post('/api/services', values);
        toast.success(`„${values.name}" angelegt.`);
      }
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      const message = describeError(err, 'Die Leistung konnte nicht gespeichert werden.');
      setError(message);
      toast.error(message);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[min(46rem,96vw)]">
        <SheetHeader>
          <SheetTitle>{service ? service.name : 'Neue Leistung'}</SheetTitle>
          <SheetDescription>
            {service
              ? 'Änderungen gelten ab dem nächsten Vorgang. Bestehende Buchungen und Rechnungen behalten ihre Preise.'
              : 'Die Leistung erscheint nach dem Speichern auf der Website, sofern sie aktiv ist.'}
          </SheetDescription>
        </SheetHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="contents" noValidate>
            <SheetBody className="space-y-8 py-6">
              {error ? <Alert variant="destructive">{error}</Alert> : null}

              {/* --- Beschreibung ------------------------------------------- */}
              <section className="space-y-5">
                <h3 className="font-display text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Auftritt
                </h3>

                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel required>Name</FormLabel>
                        <FormControl>
                          <Input placeholder="Umzugsreinigung" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="slug"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel required>Adresse auf der Website</FormLabel>
                        <FormControl>
                          <Input
                            className="font-mono"
                            {...field}
                            onChange={(event) => {
                              setSlugTouched(true);
                              field.onChange(event);
                            }}
                          />
                        </FormControl>
                        <FormDescription>
                          <span className="font-mono">/leistungen/{field.value || '…'}</span>
                          {' — '}
                          {service
                            ? 'Ändern verschiebt eine bereits indexierte Seite; alte Links laufen dann ins Leere.'
                            : 'wird aus dem Namen abgeleitet.'}
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="kind"
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
                            {SERVICE_KINDS.map((kind) => (
                              <SelectItem key={kind} value={kind}>
                                {SERVICE_KIND_LABELS[kind]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormDescription>
                          Steuert Gutscheingültigkeit und die Dauerberechnung.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="categoryId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Kategorie</FormLabel>
                        <Select
                          value={field.value ?? 'none'}
                          onValueChange={(value) => field.onChange(value === 'none' ? null : value)}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Ohne Kategorie" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="none">Ohne Kategorie</SelectItem>
                            {categories.map((category) => (
                              <SelectItem key={category.id} value={category.id}>
                                {category.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="shortDesc"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel required>Kurzbeschreibung</FormLabel>
                      <FormControl>
                        <Textarea rows={2} {...field} />
                      </FormControl>
                      <FormDescription>
                        Steht auf der Übersicht und in den Suchergebnissen. Ein Satz genügt.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel required>Beschreibung</FormLabel>
                      <FormControl>
                        <Textarea rows={6} {...field} />
                      </FormControl>
                      <FormDescription>
                        Der Fliesstext auf der Leistungsseite.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="icon"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Symbol</FormLabel>
                        <FormControl>
                          <Input placeholder="Sparkles" {...field} />
                        </FormControl>
                        <FormDescription>
                          Name eines Lucide-Symbols, z. B. Sparkles, Truck, Building2.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="heroImage"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Titelbild</FormLabel>
                        <FormControl>
                          <Input
                            type="url"
                            placeholder="https://…/umzugsreinigung.jpg"
                            {...field}
                            value={field.value ?? ''}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid gap-4 sm:grid-cols-3">
                  <ListField
                    control={form.control}
                    name="bulletPoints"
                    label="Verkaufsargumente"
                    hint="Eine Zeile je Punkt."
                  />
                  <ListField
                    control={form.control}
                    name="includes"
                    label="Inbegriffen"
                    hint="Eine Zeile je Leistung."
                  />
                  <ListField
                    control={form.control}
                    name="excludes"
                    label="Nicht inbegriffen"
                    hint="Verhindert Diskussionen vor Ort."
                  />
                </div>
              </section>

              {/* --- Preis -------------------------------------------------- */}
              <section className="space-y-5 border-t border-border pt-6">
                <h3 className="font-display text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Preis
                </h3>

                <FormField
                  control={form.control}
                  name="pricingModel"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel required>Preismodell</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {PRICING_MODELS.map((value) => (
                            <SelectItem key={value} value={value}>
                              {PRICING_LABELS[value]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid gap-4 sm:grid-cols-2">
                  {model === 'PER_HOUR' || model === 'PER_UNIT' ? (
                    <NumberField
                      control={form.control}
                      name="hourlyRate"
                      label={model === 'PER_HOUR' ? 'Stundenansatz' : 'Preis pro Einheit'}
                      suffix="CHF"
                      required
                    />
                  ) : null}

                  {model === 'PER_SQM' ? (
                    <NumberField
                      control={form.control}
                      name="pricePerSqm"
                      label="Ansatz pro m²"
                      suffix="CHF"
                      required
                    />
                  ) : null}

                  <NumberField
                    control={form.control}
                    name="basePrice"
                    label={model === 'FLAT' ? 'Pauschale' : 'Grundpauschale'}
                    suffix="CHF"
                    hint={
                      model === 'FLAT'
                        ? 'Der gesamte Preis dieser Leistung.'
                        : 'Wird zusätzlich zum variablen Anteil verrechnet — z. B. Anrückpauschale. 0 = keine.'
                    }
                  />

                  <NumberField
                    control={form.control}
                    name="minPrice"
                    label="Mindestauftragswert"
                    suffix="CHF"
                    hint="Liegt die Rechnung darunter, wird auf diesen Betrag angehoben. 0 = kein Minimum."
                  />

                  <NumberField
                    control={form.control}
                    name="minHours"
                    label="Mindestdauer"
                    suffix="Std."
                    hint="Untergrenze der Dauerschätzung."
                  />

                  <NumberField
                    control={form.control}
                    name="vatRate"
                    label="Mehrwertsteuer"
                    suffix="%"
                    hint="Normalsatz 8.1 %."
                  />
                </div>

                {model === 'ON_REQUEST' ? (
                  <Alert variant="info">
                    Bei „Auf Anfrage&ldquo; berechnet der Buchungsassistent keinen Preis, sondern erzeugt
                    eine Anfrage. Die Preisfelder bleiben ohne Wirkung.
                  </Alert>
                ) : (
                  <PricePreview
                    model={model}
                    hourlyRate={Number(form.watch('hourlyRate')) || 0}
                    pricePerSqm={Number(form.watch('pricePerSqm')) || 0}
                    basePrice={Number(form.watch('basePrice')) || 0}
                    minPrice={Number(form.watch('minPrice')) || 0}
                    vatRate={Number(form.watch('vatRate')) || 0}
                    minutesPerSqm={Number(form.watch('minutesPerSqm')) || 0}
                  />
                )}
              </section>

              {/* --- Planung ------------------------------------------------ */}
              <section className="space-y-5 border-t border-border pt-6">
                <h3 className="font-display text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Einsatzplanung
                </h3>

                <div className="grid gap-4 sm:grid-cols-2">
                  <NumberField
                    control={form.control}
                    name="defaultDurationMin"
                    label="Vorgabedauer"
                    suffix="Min."
                    hint="Gilt, solange keine Fläche angegeben ist."
                  />
                  <NumberField
                    control={form.control}
                    name="minutesPerSqm"
                    label="Minuten pro m²"
                    hint="Grundlage der Dauerschätzung bei Flächenangabe."
                  />
                  <NumberField
                    control={form.control}
                    name="defaultCrewSize"
                    label="Teamgrösse"
                    suffix="Pers."
                  />
                  <NumberField
                    control={form.control}
                    name="bufferMinutes"
                    label="Puffer zwischen Einsätzen"
                    suffix="Min."
                    hint="Fahrt- und Rüstzeit, die der Kalender freihält."
                  />
                </div>
              </section>

              {/* --- Suchmaschinen & Sichtbarkeit --------------------------- */}
              <section className="space-y-5 border-t border-border pt-6">
                <h3 className="font-display text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Sichtbarkeit
                </h3>

                <div className="space-y-3">
                  <FormField
                    control={form.control}
                    name="active"
                    render={({ field }) => (
                      <FormItem>
                        <label className="flex cursor-pointer items-start gap-3 text-sm">
                          <Checkbox
                            checked={field.value}
                            onCheckedChange={(checked) => field.onChange(checked === true)}
                          />
                          <span className="space-y-1">
                            <span className="block font-medium">Aktiv</span>
                            <span className="block text-meta text-muted-foreground">
                              Inaktive Leistungen verschwinden von der Website und aus dem
                              Buchungsassistenten. Bestehende Aufträge laufen weiter.
                            </span>
                          </span>
                        </label>
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="featured"
                    render={({ field }) => (
                      <FormItem>
                        <label className="flex cursor-pointer items-start gap-3 text-sm">
                          <Checkbox
                            checked={field.value}
                            onCheckedChange={(checked) => field.onChange(checked === true)}
                          />
                          <span className="space-y-1">
                            <span className="block font-medium">Auf der Startseite hervorheben</span>
                            <span className="block text-meta text-muted-foreground">
                              Erscheint zusätzlich im oberen Bereich der Startseite.
                            </span>
                          </span>
                        </label>
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid gap-4">
                  <FormField
                    control={form.control}
                    name="seoTitle"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Seitentitel für Suchmaschinen</FormLabel>
                        <FormControl>
                          <Input {...field} value={field.value ?? ''} />
                        </FormControl>
                        <FormDescription>
                          Leer lassen für den Standardtitel aus dem Namen.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="seoDescription"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Beschreibung für Suchmaschinen</FormLabel>
                        <FormControl>
                          <Textarea rows={2} {...field} value={field.value ?? ''} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="keywords"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Schlüsselwörter</FormLabel>
                        <FormControl>
                          <Input
                            value={(field.value ?? []).join(', ')}
                            onChange={(event) =>
                              field.onChange(
                                event.target.value
                                  .split(',')
                                  .map((k) => k.trim())
                                  .filter(Boolean),
                              )
                            }
                            placeholder="Umzugsreinigung Bern, Wohnungsabgabe"
                          />
                        </FormControl>
                        <FormDescription>Mit Komma trennen.</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </section>
            </SheetBody>

            <SheetFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Abbrechen
              </Button>
              <Button type="submit" loading={form.formState.isSubmitting}>
                <Save aria-hidden />
                {service ? 'Speichern' : 'Leistung anlegen'}
              </Button>
            </SheetFooter>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
//  Feldbausteine
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Zahlenfeld mit Schweizer Dezimalkomma.
 *
 * `type="number"` wäre naheliegend, verwirft aber ein eingegebenes Komma
 * stillschweigend — die Zahl wird dann zu `NaN`, und das Formular meldet ein
 * leeres Pflichtfeld, obwohl etwas dasteht.
 */
function NumberField({
  control,
  name,
  label,
  suffix,
  hint,
  required,
}: {
  control: any;
  name: any;
  label: string;
  suffix?: string;
  hint?: string;
  required?: boolean;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }: any) => (
        <FormItem>
          <FormLabel required={required}>{label}</FormLabel>
          <FormControl>
            <Input
              inputMode="decimal"
              suffix={suffix}
              value={field.value ?? ''}
              onChange={(event) => field.onChange(toNumberInput(event.target.value) ?? null)}
            />
          </FormControl>
          {hint ? <FormDescription>{hint}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/** Aufzählung als mehrzeiliges Feld — eine Zeile je Eintrag. */
function ListField({
  control,
  name,
  label,
  hint,
}: {
  control: any;
  name: any;
  label: string;
  hint: string;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }: any) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Textarea
              rows={5}
              value={listToLines(field.value)}
              onChange={(event) => field.onChange(linesToList(event.target.value))}
            />
          </FormControl>
          <FormDescription>{hint}</FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Preisvorschau für zwei typische Aufträge.
 *
 * Sie rechnet absichtlich nur den Grundpreis — Preisregeln, Anfahrt und
 * Rabatte hängen vom konkreten Auftrag ab, und eine Vorschau, die so tut, als
 * kenne sie das Ergebnis, wäre schlimmer als keine. Was sie zeigt, ist der
 * Betrag, der aus *diesen* Feldern entsteht, und ob der Mindestauftragswert
 * greift.
 */
function PricePreview({
  model,
  hourlyRate,
  pricePerSqm,
  basePrice,
  minPrice,
  vatRate,
  minutesPerSqm,
}: {
  model: string;
  hourlyRate: number;
  pricePerSqm: number;
  basePrice: number;
  minPrice: number;
  vatRate: number;
  minutesPerSqm: number;
}) {
  const cases =
    model === 'PER_SQM'
      ? [
          { label: '80 m² Wohnung', net: pricePerSqm * 80 + basePrice },
          { label: '150 m² Büro', net: pricePerSqm * 150 + basePrice },
        ]
      : model === 'FLAT'
        ? [{ label: 'Pauschal', net: basePrice }]
        : model === 'PER_UNIT'
          ? [
              { label: '10 Einheiten', net: hourlyRate * 10 + basePrice },
              { label: '25 Einheiten', net: hourlyRate * 25 + basePrice },
            ]
          : [
              { label: '3 Stunden', net: hourlyRate * 3 + basePrice },
              {
                label: `80 m² (≈ ${Math.round((80 * minutesPerSqm) / 60 * 10) / 10} Std.)`,
                net: hourlyRate * ((80 * minutesPerSqm) / 60) + basePrice,
              },
            ];

  return (
    <div className="rounded-xl bg-muted/50 p-4">
      <p className="text-meta font-medium">Was daraus entsteht</p>
      <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">
        Nur Grundpreis und Mindestauftragswert. Zuschläge, Anfahrt und Rabatte kommen im konkreten
        Auftrag dazu.
      </p>
      <dl className="mt-3 space-y-1.5">
        {cases.map((item) => {
          const net = Math.max(item.net, minPrice);
          const raised = minPrice > 0 && item.net < minPrice;
          return (
            <div key={item.label} className="flex items-baseline justify-between gap-4">
              <dt className="text-sm text-muted-foreground">
                {item.label}
                {raised ? ' · auf Minimum angehoben' : ''}
              </dt>
              <dd className="text-sm tabular-nums">
                {formatCurrency(Math.round(net * 100) / 100)}
                <span className="ml-2 text-2xs text-muted-foreground">
                  {formatCurrency(Math.round(net * (1 + vatRate / 100) * 100) / 100)} inkl. MWST
                </span>
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}
