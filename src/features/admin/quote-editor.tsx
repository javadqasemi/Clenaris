'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { GripVertical, Plus, Save, Sparkles, Trash2, UserPlus } from 'lucide-react';
import { toast } from 'sonner';

import { cn, formatCurrency, round2 } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import { rateForService, unitForService } from '@/lib/pricing/units';
import { createQuoteSchema, type CreateQuoteInput } from '@/lib/validation/operations';
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/overlays';
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

/**
 * Offerten-Editor.
 *
 * Architekturentscheide:
 *  • Die Totale werden im Formular *live* berechnet, damit man die Wirkung
 *    einer Änderung sofort sieht — massgebend ist aber die Berechnung auf dem
 *    Server. Beide nutzen dieselbe Formel.
 *  • Optionale Positionen erscheinen in der Offerte, zählen aber nicht ins
 *    Total. Das ist im Reinigungsgewerbe üblich („Fenster auf Wunsch").
 *  • Der KI-Entwurf füllt nur die Felder aus; gespeichert wird erst nach
 *    einer bewussten Prüfung durch eine Person.
 */

export interface QuoteEditorService {
  id: string;
  name: string;
  kind: string;
  pricingModel: string;
  hourlyRate: number | null;
  pricePerSqm: number | null;
  basePrice: number;
  vatRate: number;
}

export interface QuoteEditorCustomer {
  id: string;
  label: string;
}

export function QuoteEditor({
  services,
  customers,
  defaultCustomerId,
  initial,
  quoteId,
}: {
  services: QuoteEditorService[];
  customers: QuoteEditorCustomer[];
  defaultCustomerId?: string;
  initial?: Partial<CreateQuoteInput>;
  quoteId?: string;
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [aiPending, setAiPending] = React.useState(false);
  const [aiPrompt, setAiPrompt] = React.useState('');
  const [customerDialog, setCustomerDialog] = React.useState(false);
  /**
   * Neu angelegte Kundschaft kommt zur Auswahlliste dazu, ohne die Seite neu
   * zu laden. `router.refresh()` würde das Formular zwar nicht zurücksetzen,
   * aber die Liste kommt aus einer Server Component — bis sie nachgeladen ist,
   * stünde in der Auswahl ein Name, den es scheinbar nicht gibt.
   */
  const [addedCustomers, setAddedCustomers] = React.useState<QuoteEditorCustomer[]>([]);
  const customerOptions = React.useMemo(
    () => [...addedCustomers, ...customers],
    [addedCustomers, customers],
  );

  const form = useForm<CreateQuoteInput>({
    resolver: zodResolver(createQuoteSchema),
    defaultValues: {
      customerId: initial?.customerId ?? defaultCustomerId,
      title: initial?.title ?? '',
      validUntil:
        initial?.validUntil ?? (new Date(Date.now() + 30 * 86_400_000) as unknown as Date),
      introText: initial?.introText ?? '',
      outroText:
        initial?.outroText ??
        'Wir freuen uns auf Ihre Rückmeldung und stehen für Fragen gerne zur Verfügung.',
      discountType: initial?.discountType,
      discountValue: initial?.discountValue ?? 0,
      items: initial?.items ?? [
        {
          name: '',
          quantity: 1,
          unit: 'Std.',
          unitPrice: 0,
          discount: 0,
          vatRate: 8.1,
          optional: false,
        },
      ],
    } as never,
  });

  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'items' });
  const items = form.watch('items');
  const discountType = form.watch('discountType');
  const discountValue = form.watch('discountValue');

  /**
   * Position aus dem Leistungskatalog übernehmen.
   *
   * Was sich hier geändert hat und warum:
   *
   *  • **Die Einheit folgt dem Preismodell der Leistung**, nicht einer
   *    Ja/Nein-Abfrage auf `PER_SQM`. Fensterreinigung wird nach Fenstern
   *    abgerechnet, Bauendreinigung nach Stunden, eine Pauschale gar nicht nach
   *    Menge — mit „m² oder Std." liess sich das nicht ausdrücken.
   *
   *  • **Der Ansatz folgt derselben Einheit.** Vorher wurde durchweg der
   *    Stundensatz eingesetzt, auch bei Flächenpreisen: Eine Position las sich
   *    dann „120 m² × CHF 65.00" statt „120 m² × CHF 4.20" — Faktor 15 zu
   *    hoch, und zwar in einem Dokument, das an die Kundschaft geht.
   *
   *  • **Der MWST-Satz kommt aus dem Katalog**, nicht als fest verdrahtete 8.1.
   *    Für die wenigen Leistungen mit abweichendem Satz war jede Offerte
   *    falsch.
   *
   * Die Menge bleibt eine Vorgabe der Einheit: den Aufwand schätzt die Person,
   * die das Objekt gesehen hat, nicht der Katalog.
   */
  const addFromCatalogue = (serviceId: string) => {
    const service = services.find((entry) => entry.id === serviceId);
    if (!service) return;

    const unit = unitForService(service.pricingModel, service.kind);

    append({
      serviceId: service.id,
      name: service.name,
      quantity: unit.defaultQuantity,
      unit: unit.unit,
      unitPrice: rateForService(service),
      discount: 0,
      vatRate: service.vatRate,
      optional: false,
    } as never);
  };

  // Live-Vorschau der Summen — dieselbe Formel wie auf dem Server.
  const totals = React.useMemo(() => {
    const computed = (items ?? []).map((item) => ({
      optional: item?.optional ?? false,
      lineTotal: round2(
        (Number(item?.quantity) || 0) *
          (Number(item?.unitPrice) || 0) *
          (1 - (Number(item?.discount) || 0) / 100),
      ),
      vatRate: Number(item?.vatRate) || 0,
    }));

    const billable = computed.filter((item) => !item.optional);
    const subtotal = round2(billable.reduce((sum, item) => sum + item.lineTotal, 0));
    // Ohne gewählte Rabattart kein Rabatt — dieselbe Regel wie auf dem Server.
    const discountAmount = !discountType
      ? 0
      : discountType === 'PERCENT'
        ? round2(subtotal * ((Number(discountValue) || 0) / 100))
        : round2(Math.min(Number(discountValue) || 0, subtotal));
    const netTotal = round2(subtotal - discountAmount);
    const factor = subtotal > 0 ? netTotal / subtotal : 1;
    const vatAmount = round2(
      billable.reduce((sum, item) => sum + item.lineTotal * factor * (item.vatRate / 100), 0),
    );

    return {
      subtotal,
      discountAmount,
      netTotal,
      vatAmount,
      grossTotal: round2(netTotal + vatAmount),
      optionalTotal: round2(
        computed.filter((item) => item.optional).reduce((sum, item) => sum + item.lineTotal, 0),
      ),
    };
  }, [items, discountType, discountValue]);

  const generateDraft = async () => {
    if (!aiPrompt.trim()) {
      toast.error('Bitte beschreiben Sie kurz, worum es geht.');
      return;
    }

    setAiPending(true);
    try {
      const draft = await api.post<{
        title: string;
        introText: string;
        outroText: string;
        assumptions: string[];
        items: {
          name: string;
          description: string;
          quantity: number;
          unit: string;
          unitPrice: number;
          optional: boolean;
        }[];
      }>('/api/ai/quote-draft', {
        message: aiPrompt,
        customerId: form.getValues('customerId'),
      });

      form.setValue('title', draft.title);
      form.setValue('introText', draft.introText);
      form.setValue('outroText', draft.outroText);
      form.setValue(
        'items',
        draft.items.map((item) => ({
          name: item.name,
          description: item.description,
          quantity: item.quantity,
          unit: item.unit,
          unitPrice: item.unitPrice,
          discount: 0,
          vatRate: 8.1,
          optional: item.optional,
        })) as never,
      );

      toast.success('Entwurf erstellt. Bitte Positionen und Annahmen prüfen.', {
        description:
          draft.assumptions.length > 0 ? `Annahmen: ${draft.assumptions.join(' · ')}` : undefined,
        duration: 12_000,
      });
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Der Entwurf konnte nicht erstellt werden.',
      );
    } finally {
      setAiPending(false);
    }
  };

  const onSubmit = async (values: CreateQuoteInput) => {
    setError(null);
    try {
      const result = quoteId
        ? await api.patch<{ id: string }>(`/api/quotes/${quoteId}`, values)
        : await api.post<{ id: string }>('/api/quotes', values);

      toast.success(quoteId ? 'Offerte gespeichert.' : 'Offerte erstellt.');
      router.push(`/admin/offerten/${result.id}`);
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Die Offerte konnte nicht gespeichert werden.';
      setError(message);
      toast.error(message);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8" noValidate>
        {error ? <Alert variant="destructive">{error}</Alert> : null}

        {/* KI-Entwurf */}
        <section className="space-y-3 rounded-2xl border border-primary/25 bg-primary/[0.04] p-5">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" aria-hidden />
            <h2 className="font-display text-sm font-semibold">Entwurf aus der Anfrage erzeugen</h2>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Fügen Sie die Kundenanfrage ein. Wir schlagen Positionen und Aufwand vor — den Preis
            prüfen und verantworten Sie.
          </p>
          <Textarea
            value={aiPrompt}
            onChange={(event) => setAiPrompt(event.target.value)}
            rows={3}
            placeholder="z. B. 4.5-Zimmer-Wohnung, 112 m², Umzugsreinigung mit Abgabegarantie per Ende Monat, Fenster und Storen inklusive."
            aria-label="Kundenanfrage"
          />
          <Button type="button" variant="outline" onClick={generateDraft} loading={aiPending}>
            <Sparkles aria-hidden />
            Entwurf erstellen
          </Button>
        </section>

        {/* Kopfdaten */}
        <div className="grid gap-5 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="customerId"
            render={({ field }) => (
              <FormItem>
                <div className="flex items-baseline justify-between gap-4">
                  <FormLabel required>Kundschaft</FormLabel>
                  {/*
                    Neue Kundschaft direkt hier anlegen.

                    Vorher gab es diesen Weg nicht: Wer telefonisch eine Anfrage
                    von jemandem erhielt, der noch nicht erfasst war, musste die
                    Offerte verlassen, in der Kundschaft einen Datensatz anlegen
                    und von vorn beginnen — samt allem, was bis dahin getippt
                    war. Der Dialog legt den Datensatz im CRM an (er ist danach
                    dort auffindbar) und wählt ihn hier aus.
                  */}
                  <button
                    type="button"
                    onClick={() => setCustomerDialog(true)}
                    className="inline-flex items-center gap-1 text-meta font-medium text-primary underline-offset-4 hover:underline"
                  >
                    <UserPlus className="size-3.5" aria-hidden />
                    Neue Kundschaft
                  </button>
                </div>
                <Select value={field.value ?? ''} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Kunde wählen" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {customerOptions.map((customer) => (
                      <SelectItem key={customer.id} value={customer.id}>
                        {customer.label}
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
            name="validUntil"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>Gültig bis</FormLabel>
                <FormControl>
                  <Input
                    type="date"
                    value={toDateInput(field.value)}
                    onChange={(event) => field.onChange(event.target.value)}
                  />
                </FormControl>
                <FormDescription>Üblich sind 30 Tage.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="title"
            render={({ field }) => (
              <FormItem className="sm:col-span-2">
                <FormLabel required>Betreff</FormLabel>
                <FormControl>
                  <Input placeholder="z. B. Umzugsreinigung Länggassstrasse 42" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="introText"
            render={({ field }) => (
              <FormItem className="sm:col-span-2">
                <FormLabel>Einleitung</FormLabel>
                <FormControl>
                  <Textarea rows={3} {...field} value={field.value ?? ''} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Positionen */}
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h2 className="font-display text-base font-semibold tracking-tight">Positionen</h2>

            <div className="flex flex-wrap items-center gap-2">
              {/*
                Aus dem Katalog übernehmen: Bezeichnung und Ansatz stammen aus
                den eigenen Leistungen, nicht aus dem Gedächtnis. Der Aufwand
                bleibt offen — den schätzt die Person, die das Objekt kennt.
              */}
              {services.length > 0 ? (
                <Select value="" onValueChange={addFromCatalogue}>
                  <SelectTrigger className="w-56" aria-label="Position aus dem Katalog">
                    <SelectValue placeholder="Aus dem Katalog …" />
                  </SelectTrigger>
                  <SelectContent>
                    {services.map((service) => (
                      <SelectItem key={service.id} value={service.id}>
                        {service.name}
                        {service.hourlyRate ? ` · ${formatCurrency(service.hourlyRate)}/Std.` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  append({
                    name: '',
                    quantity: 1,
                    unit: 'Std.',
                    unitPrice: 0,
                    discount: 0,
                    vatRate: 8.1,
                    optional: false,
                  } as never)
                }
              >
                <Plus aria-hidden />
                Position
              </Button>
            </div>
          </div>

          <ul className="space-y-3">
            {fields.map((field, index) => {
              const row = items?.[index];
              const isOptional = row?.optional;
              const lineTotal = round2(
                (Number(row?.quantity) || 0) *
                  (Number(row?.unitPrice) || 0) *
                  (1 - (Number(row?.discount) || 0) / 100),
              );

              /**
               * Das Mengenfeld passt sich der gewählten Leistung an: „Fläche"
               * mit Schrittweite 1, „Anzahl Fenster" ganzzahlig, „Aufwand" in
               * Viertelstunden. Ohne Katalogbezug (Freitextposition) bleibt es
               * bei der neutralen Beschriftung „Menge" — dort weiss niemand,
               * was gemeint ist, und eine geratene Einheit wäre irreführender
               * als gar keine.
               */
              const service = row?.serviceId
                ? services.find((entry) => entry.id === row.serviceId)
                : undefined;
              const unit = service
                ? unitForService(service.pricingModel, service.kind)
                : null;

              return (
                <li
                  key={field.id}
                  className={cn(
                    'space-y-3 rounded-2xl border p-4',
                    isOptional ? 'border-dashed border-border bg-muted/30' : 'border-border bg-card',
                  )}
                >
                  <div className="flex items-start gap-3">
                    <GripVertical
                      className="mt-2.5 size-4 shrink-0 text-muted-foreground/50"
                      aria-hidden
                    />

                    <div className="grid flex-1 gap-3 sm:grid-cols-12">
                      <div className="sm:col-span-12">
                        <Label htmlFor={`item-name-${index}`} className="sr-only">
                          Bezeichnung
                        </Label>
                        <Input
                          id={`item-name-${index}`}
                          placeholder="Bezeichnung"
                          {...form.register(`items.${index}.name`)}
                        />
                      </div>

                      <div className="sm:col-span-12">
                        <Label htmlFor={`item-desc-${index}`} className="sr-only">
                          Beschreibung
                        </Label>
                        <Input
                          id={`item-desc-${index}`}
                          placeholder="Beschreibung (optional)"
                          {...form.register(`items.${index}.description`)}
                        />
                      </div>

                      <div className="sm:col-span-2">
                        <Label htmlFor={`item-qty-${index}`} className="text-xs">
                          {unit?.quantityLabel ?? 'Menge'}
                        </Label>
                        <Input
                          id={`item-qty-${index}`}
                          inputMode={unit?.integer ? 'numeric' : 'decimal'}
                          type="number"
                          step={unit?.step ?? 'any'}
                          min={unit?.min}
                          max={unit?.max}
                          aria-describedby={unit ? `item-qty-hint-${index}` : undefined}
                          {...form.register(`items.${index}.quantity`, { valueAsNumber: true })}
                        />
                      </div>

                      <div className="sm:col-span-2">
                        <Label htmlFor={`item-unit-${index}`} className="text-xs">
                          Einheit
                        </Label>
                        <Input id={`item-unit-${index}`} {...form.register(`items.${index}.unit`)} />
                      </div>

                      <div className="sm:col-span-3">
                        <Label htmlFor={`item-price-${index}`} className="text-xs">
                          Preis (netto)
                        </Label>
                        <Input
                          id={`item-price-${index}`}
                          inputMode="decimal"
                          suffix="CHF"
                          {...form.register(`items.${index}.unitPrice`, { valueAsNumber: true })}
                        />
                      </div>

                      <div className="sm:col-span-2">
                        <Label htmlFor={`item-discount-${index}`} className="text-xs">
                          Rabatt
                        </Label>
                        <Input
                          id={`item-discount-${index}`}
                          inputMode="decimal"
                          suffix="%"
                          {...form.register(`items.${index}.discount`, { valueAsNumber: true })}
                        />
                      </div>

                      <div className="sm:col-span-3">
                        <Label className="text-xs">Zeilentotal</Label>
                        <p className="flex h-11 items-center justify-end px-1 font-medium tabular-nums">
                          {formatCurrency(lineTotal)}
                        </p>
                      </div>
                    </div>

                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => remove(index)}
                      disabled={fields.length === 1}
                      aria-label={`Position ${index + 1} entfernen`}
                      className="mt-1.5 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>

                  {unit ? (
                    <p id={`item-qty-hint-${index}`} className="ml-7 text-xs text-muted-foreground">
                      {unit.hint}
                    </p>
                  ) : null}

                  <label className="ml-7 flex w-fit cursor-pointer items-center gap-2.5 text-sm">
                    <Checkbox
                      checked={isOptional ?? false}
                      onCheckedChange={(checked) =>
                        form.setValue(`items.${index}.optional`, checked === true)
                      }
                    />
                    <span className="text-muted-foreground">
                      Optionale Position (wird ausgewiesen, zählt nicht ins Total)
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Rabatt & Summen */}
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-4">
            <h2 className="font-display text-base font-semibold tracking-tight">Gesamtrabatt</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="discountType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Art</FormLabel>
                    <Select value={field.value ?? 'none'} onValueChange={(value) => field.onChange(value === 'none' ? undefined : value)}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="none">Kein Rabatt</SelectItem>
                        <SelectItem value="PERCENT">Prozentual</SelectItem>
                        <SelectItem value="FIXED">Fixbetrag</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="discountValue"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Wert</FormLabel>
                    <FormControl>
                      <Input
                        inputMode="decimal"
                        suffix={discountType === 'PERCENT' ? '%' : 'CHF'}
                        disabled={!discountType}
                        {...field}
                        value={field.value ?? 0}
                        onChange={(event) => field.onChange(Number(event.target.value) || 0)}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="outroText"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Schlusstext</FormLabel>
                  <FormControl>
                    <Textarea rows={3} {...field} value={field.value ?? ''} />
                  </FormControl>
                </FormItem>
              )}
            />
          </div>

          <div className="space-y-2 rounded-2xl border border-border bg-card p-5">
            <dl className="protocol-list">
              <div className="flex items-baseline justify-between gap-4 py-2">
                <dt className="text-sm text-muted-foreground">Zwischentotal</dt>
                <dd className="text-sm tabular-nums">{formatCurrency(totals.subtotal)}</dd>
              </div>
              {totals.discountAmount > 0 ? (
                <div className="flex items-baseline justify-between gap-4 py-2">
                  <dt className="text-sm text-success">Rabatt</dt>
                  <dd className="text-sm tabular-nums text-success">
                    − {formatCurrency(totals.discountAmount)}
                  </dd>
                </div>
              ) : null}
              <div className="flex items-baseline justify-between gap-4 py-2">
                <dt className="text-sm text-muted-foreground">Total netto</dt>
                <dd className="text-sm tabular-nums">{formatCurrency(totals.netTotal)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-2">
                <dt className="text-sm text-muted-foreground">MWST</dt>
                <dd className="text-sm tabular-nums">{formatCurrency(totals.vatAmount)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-3">
                <dt className="font-semibold">Gesamtbetrag</dt>
                <dd className="font-display text-xl font-bold tabular-nums">
                  {formatCurrency(totals.grossTotal)}
                </dd>
              </div>
              {totals.optionalTotal > 0 ? (
                <div className="flex items-baseline justify-between gap-4 py-2">
                  <dt className="text-sm text-muted-foreground">Optionen (nicht enthalten)</dt>
                  <dd className="text-sm tabular-nums text-muted-foreground">
                    {formatCurrency(totals.optionalTotal)}
                  </dd>
                </div>
              ) : null}
            </dl>
          </div>
        </div>

        <div className="flex justify-end gap-3 border-t border-border pt-6">
          <Button type="button" variant="ghost" onClick={() => router.back()}>
            Abbrechen
          </Button>
          <Button type="submit" size="lg" loading={form.formState.isSubmitting}>
            <Save aria-hidden />
            {quoteId ? 'Änderungen speichern' : 'Offerte erstellen'}
          </Button>
        </div>
      </form>

      <NewCustomerDialog
        open={customerDialog}
        onOpenChange={setCustomerDialog}
        onCreated={(customer) => {
          setAddedCustomers((current) => [customer, ...current]);
          form.setValue('customerId', customer.id, { shouldValidate: true });
          setCustomerDialog(false);
        }}
      />
    </Form>
  );
}

/**
 * Neue Kundschaft aus der Offerte heraus anlegen.
 *
 * Bewusst schmal: Typ, Name, Firma, E-Mail, Telefon und optional die Adresse.
 * Zahlungsziel, Rabattsatz und Kreditlimit stehen nicht hier — wer eine
 * Offerte schreibt, kennt sie in diesem Moment nicht, und ein Formular mit
 * zwölf Feldern für einen Zwischenschritt bricht den Arbeitsfluss genauso wie
 * der Seitenwechsel, den es ersetzen soll. Alles Weitere lässt sich in der
 * Kundenakte nachtragen.
 */
function NewCustomerDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (customer: QuoteEditorCustomer) => void;
}) {
  const [type, setType] = React.useState<'PRIVATE' | 'BUSINESS'>('PRIVATE');
  const [values, setValues] = React.useState({
    companyName: '',
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    street: '',
    streetNo: '',
    postalCode: '',
    city: '',
  });
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const set = (key: keyof typeof values, value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const hasAddress = Boolean(values.street.trim() && values.postalCode.trim() && values.city.trim());

      const customer = await api.post<{ id: string; number: string }>('/api/customers', {
        type,
        companyName: values.companyName.trim() || undefined,
        firstName: values.firstName.trim(),
        lastName: values.lastName.trim(),
        email: values.email.trim(),
        phone: values.phone.trim() || undefined,
        language: 'DE',
        ...(hasAddress
          ? {
              address: {
                street: values.street.trim(),
                streetNo: values.streetNo.trim() || undefined,
                postalCode: values.postalCode.trim(),
                city: values.city.trim(),
                canton: 'BE',
                country: 'CH',
              },
            }
          : {}),
      });

      const label = `${values.companyName.trim() || `${values.firstName.trim()} ${values.lastName.trim()}`} · ${customer.number}`;
      toast.success(`Kundschaft ${customer.number} angelegt und im CRM gespeichert.`);
      onCreated({ id: customer.id, label });

      setValues({
        companyName: '',
        firstName: '',
        lastName: '',
        email: '',
        phone: '',
        street: '',
        streetNo: '',
        postalCode: '',
        city: '',
      });
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Die Kundschaft konnte nicht angelegt werden.';
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const valid =
    values.firstName.trim().length >= 2 &&
    values.lastName.trim().length >= 2 &&
    /.+@.+\..+/.test(values.email) &&
    (type === 'PRIVATE' || values.companyName.trim().length >= 2);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Neue Kundschaft</DialogTitle>
          <DialogDescription>
            Der Datensatz wird in der Kundschaft gespeichert und hier direkt ausgewählt.
            Zahlungsziel, Rabatt und weitere Konditionen lassen sich später in der Kundenakte
            ergänzen.
          </DialogDescription>
        </DialogHeader>

        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="nc-type">Art</Label>
            <Select value={type} onValueChange={(value) => setType(value as 'PRIVATE' | 'BUSINESS')}>
              <SelectTrigger id="nc-type" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="PRIVATE">Privatkundschaft</SelectItem>
                <SelectItem value="BUSINESS">Geschäftskundschaft</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {type === 'BUSINESS' ? (
            <div className="space-y-1.5">
              <Label htmlFor="nc-company" required>
                Firma
              </Label>
              <Input
                id="nc-company"
                value={values.companyName}
                onChange={(event) => set('companyName', event.target.value)}
                autoComplete="organization"
              />
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="nc-first" required>
                Vorname
              </Label>
              <Input
                id="nc-first"
                value={values.firstName}
                onChange={(event) => set('firstName', event.target.value)}
                autoComplete="given-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nc-last" required>
                Nachname
              </Label>
              <Input
                id="nc-last"
                value={values.lastName}
                onChange={(event) => set('lastName', event.target.value)}
                autoComplete="family-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nc-email" required>
                E-Mail
              </Label>
              <Input
                id="nc-email"
                type="email"
                value={values.email}
                onChange={(event) => set('email', event.target.value)}
                autoComplete="email"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nc-phone">Telefon</Label>
              <Input
                id="nc-phone"
                type="tel"
                value={values.phone}
                onChange={(event) => set('phone', event.target.value)}
                autoComplete="tel"
              />
            </div>
          </div>

          <fieldset className="grid gap-4 border-t border-border pt-4 sm:grid-cols-[minmax(0,2fr)_6rem_6rem_minmax(0,1fr)]">
            <legend className="mb-1 text-sm font-medium text-muted-foreground">
              Adresse (optional)
            </legend>
            <div className="space-y-1.5">
              <Label htmlFor="nc-street">Strasse</Label>
              <Input
                id="nc-street"
                value={values.street}
                onChange={(event) => set('street', event.target.value)}
                autoComplete="address-line1"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nc-no">Nr.</Label>
              <Input
                id="nc-no"
                value={values.streetNo}
                onChange={(event) => set('streetNo', event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nc-zip">PLZ</Label>
              <Input
                id="nc-zip"
                inputMode="numeric"
                maxLength={4}
                value={values.postalCode}
                onChange={(event) => set('postalCode', event.target.value)}
                autoComplete="postal-code"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nc-city">Ort</Label>
              <Input
                id="nc-city"
                value={values.city}
                onChange={(event) => set('city', event.target.value)}
                autoComplete="address-level2"
              />
            </div>
          </fieldset>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button onClick={submit} loading={saving} disabled={!valid}>
            <UserPlus aria-hidden />
            Anlegen und auswählen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function toDateInput(value: unknown): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}
