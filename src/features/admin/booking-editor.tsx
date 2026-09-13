'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Lock, Plus, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { cn, formatCurrency, round2 } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import { updateBookingSchema, type UpdateBookingInput } from '@/lib/validation/booking';
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
  Label,
} from '@/components/ui/form';

/**
 * Auftragsbearbeitung.
 *
 * Gestaltungsentscheide:
 *
 *  • **Eine Maske, nicht sechs Dialoge.** Wer einen Auftrag korrigiert,
 *    korrigiert meistens mehreres auf einmal: Der Termin verschiebt sich, weil
 *    die Kundschaft angerufen hat, und bei der Gelegenheit kommt eine
 *    Zusatzleistung dazu. Sechs einzelne Dialoge hiessen sechs Speichervorgänge
 *    und sechs Einträge in der Änderungsspur für einen einzigen Anruf.
 *
 *  • **Der Preisblock ist gesperrt statt versteckt, wenn das Recht fehlt.** Ein
 *    unsichtbarer Abschnitt lässt die Betriebsleitung glauben, es gäbe ihn
 *    nicht; ein gesperrter mit Begründung sagt, an wen sie sich wendet. Die
 *    Sperre ist Höflichkeit — verbindlich ist die Prüfung im Server.
 *
 *  • **Der Grund der Änderung ist ein eigenes Feld.** Er landet in der
 *    Änderungsspur am Auftrag, wo ihn das Büro beim nächsten Anruf findet. Beim
 *    Storno ist er Pflicht, sonst freiwillig.
 */

export interface BookingEditorService {
  id: string;
  name: string;
  unit: string;
  unitPrice: number;
  defaultDurationMin: number;
}

export interface BookingEditorExtra {
  id: string;
  name: string;
  price: number;
}

export interface BookingEditorOption {
  id: string;
  label: string;
}

const STATUS_OPTIONS = [
  { value: 'DRAFT', label: 'Entwurf' },
  { value: 'PENDING', label: 'Offen' },
  { value: 'CONFIRMED', label: 'Bestätigt' },
  { value: 'IN_PROGRESS', label: 'In Arbeit' },
  { value: 'COMPLETED', label: 'Abgeschlossen' },
  { value: 'NO_SHOW', label: 'Nicht angetroffen' },
  { value: 'CANCELLED', label: 'Storniert' },
] as const;

const FREQUENCY_OPTIONS = [
  { value: 'ONCE', label: 'Einmalig' },
  { value: 'WEEKLY', label: 'Wöchentlich' },
  { value: 'BIWEEKLY', label: 'Alle zwei Wochen' },
  { value: 'MONTHLY', label: 'Monatlich' },
  { value: 'QUARTERLY', label: 'Vierteljährlich' },
  { value: 'SEMIANNUAL', label: 'Halbjährlich' },
  { value: 'ANNUAL', label: 'Jährlich' },
  { value: 'CUSTOM', label: 'Nach Absprache' },
] as const;

const PROPERTY_KINDS = [
  { value: 'APARTMENT', label: 'Wohnung' },
  { value: 'HOUSE', label: 'Haus' },
  { value: 'OFFICE', label: 'Büro' },
  { value: 'COMMERCIAL', label: 'Gewerbe' },
  { value: 'INDUSTRIAL', label: 'Industrie' },
  { value: 'CONSTRUCTION_SITE', label: 'Baustelle' },
  { value: 'PRACTICE', label: 'Praxis' },
  { value: 'RESTAURANT', label: 'Gastronomie' },
  { value: 'SCHOOL', label: 'Schule' },
  { value: 'OTHER', label: 'Anderes' },
] as const;

export function BookingEditor({
  bookingId,
  bookingNumber,
  customers,
  addresses,
  properties,
  services,
  extras,
  canEditPricing,
  canChangeCustomer,
  initial,
}: {
  bookingId: string;
  bookingNumber: string;
  customers: BookingEditorOption[];
  addresses: BookingEditorOption[];
  properties: BookingEditorOption[];
  services: BookingEditorService[];
  extras: BookingEditorExtra[];
  canEditPricing: boolean;
  canChangeCustomer: boolean;
  initial: UpdateBookingInput;
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);

  const form = useForm<UpdateBookingInput>({
    resolver: zodResolver(updateBookingSchema),
    defaultValues: initial,
  });

  const itemFields = useFieldArray({ control: form.control, name: 'items' });
  const extraFields = useFieldArray({ control: form.control, name: 'extras' });

  const items = form.watch('items');
  const extraLines = form.watch('extras');
  const travelFee = form.watch('travelFee');
  const discountAmount = form.watch('discountAmount');
  const vatRate = form.watch('vatRate');
  const status = form.watch('status');

  /**
   * Live-Vorschau der Summen — dieselbe Formel wie `recalculateBookingTotals`
   * auf dem Server. Massgebend ist der Server; hier geht es darum, die Wirkung
   * einer Eingabe zu sehen, bevor man speichert.
   */
  const totals = React.useMemo(() => {
    const subtotal = round2(
      (items ?? []).reduce(
        (sum, item) => sum + (Number(item?.quantity) || 0) * (Number(item?.unitPrice) || 0),
        0,
      ),
    );
    const extrasTotal = round2(
      (extraLines ?? []).reduce(
        (sum, extra) => sum + (Number(extra?.quantity) || 0) * (Number(extra?.unitPrice) || 0),
        0,
      ),
    );
    const travel = round2(Number(travelFee) || 0);
    const beforeDiscount = round2(subtotal + extrasTotal + travel);
    const discount = round2(Math.min(Number(discountAmount) || 0, beforeDiscount));
    const netTotal = round2(beforeDiscount - discount);
    const vat = round2(netTotal * ((Number(vatRate) || 0) / 100));

    return {
      subtotal,
      extrasTotal,
      travel,
      discount,
      netTotal,
      vat,
      grossTotal: round2(netTotal + vat),
    };
  }, [items, extraLines, travelFee, discountAmount, vatRate]);

  /** Gesamtdauer aus den Positionen — sie steuert Planung und Einsatzlänge. */
  const totalDuration = React.useMemo(
    () => (items ?? []).reduce((sum, item) => sum + (Number(item?.durationMin) || 0), 0),
    [items],
  );

  const addItem = (serviceId: string) => {
    const service = services.find((entry) => entry.id === serviceId);
    if (!service) return;
    itemFields.append({
      serviceId: service.id,
      name: service.name,
      description: null,
      quantity: 1,
      unit: service.unit,
      unitPrice: service.unitPrice,
      durationMin: service.defaultDurationMin,
    });
  };

  const addExtra = (extraId: string) => {
    const extra = extras.find((entry) => entry.id === extraId);
    if (!extra) return;
    if ((extraLines ?? []).some((line) => line?.extraId === extra.id)) {
      toast.error('Diese Zusatzleistung ist bereits erfasst — bitte die Menge erhöhen.');
      return;
    }
    extraFields.append({ extraId: extra.id, name: extra.name, quantity: 1, unitPrice: extra.price });
  };

  const onSubmit = async (values: UpdateBookingInput) => {
    setError(null);

    // Preisfelder gar nicht erst mitschicken, wenn das Recht fehlt: der Server
    // würde die Anfrage sonst *vollständig* ablehnen, obwohl die erlaubten
    // Änderungen in Ordnung sind.
    const payload: UpdateBookingInput = canEditPricing
      ? values
      : {
          ...values,
          items: undefined,
          extras: undefined,
          travelFee: undefined,
          discountAmount: undefined,
          vatRate: undefined,
        };

    try {
      await api.patch(`/api/bookings/${bookingId}`, payload);
      toast.success('Auftrag gespeichert.');
      router.push(`/admin/buchungen/${bookingId}`);
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Der Auftrag konnte nicht gespeichert werden.';
      setError(message);
      toast.error(message);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8" noValidate>
        {error ? <Alert variant="destructive">{error}</Alert> : null}

        {status === 'CANCELLED' ? (
          <Alert variant="warning" title="Storno">
            Beim Speichern wird der Auftrag storniert, zugehörige Einsätze werden abgesagt und die
            Kundschaft erhält eine E-Mail mit Ihrer Begründung. Der Grund ist deshalb Pflicht.
          </Alert>
        ) : null}

        {/* --- Status und Termin --------------------------------------- */}
        <section className="space-y-4">
          <h2 className="font-display text-base font-semibold tracking-tight">Status und Termin</h2>

          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Status</FormLabel>
                  <Select value={field.value ?? ''} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {STATUS_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
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
              name="scheduledStart"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Beginn</FormLabel>
                  <FormControl>
                    <Input
                      type="datetime-local"
                      value={toLocalInput(field.value)}
                      onChange={(event) =>
                        field.onChange(
                          event.target.value ? new Date(event.target.value) : undefined,
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
              name="durationMin"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Dauer</FormLabel>
                  <FormControl>
                    <Input
                      inputMode="numeric"
                      suffix="Min."
                      value={field.value ?? ''}
                      onChange={(event) => field.onChange(Number(event.target.value) || undefined)}
                    />
                  </FormControl>
                  {totalDuration > 0 && totalDuration !== field.value ? (
                    <FormDescription>
                      Positionen ergeben {totalDuration} Minuten.{' '}
                      <button
                        type="button"
                        onClick={() => field.onChange(totalDuration)}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        Übernehmen
                      </button>
                    </FormDescription>
                  ) : null}
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="crewSize"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Personen</FormLabel>
                  <FormControl>
                    <Input
                      inputMode="numeric"
                      value={field.value ?? ''}
                      onChange={(event) => field.onChange(Number(event.target.value) || undefined)}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="frequency"
            render={({ field }) => (
              <FormItem className="max-w-xs">
                <FormLabel>Turnus</FormLabel>
                <Select value={field.value ?? 'ONCE'} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {FREQUENCY_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>
                  Der Turnus steuert die Folgetermine der Serie, nicht diesen einen Termin.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </section>

        {/* --- Kundschaft, Adresse, Objekt ----------------------------- */}
        <section className="space-y-4 border-t border-border pt-6">
          <h2 className="font-display text-base font-semibold tracking-tight">
            Kundschaft und Objekt
          </h2>

          <div className="grid gap-5 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="customerId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Kundschaft</FormLabel>
                  <Select
                    value={field.value ?? ''}
                    onValueChange={field.onChange}
                    disabled={!canChangeCustomer}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Kunde wählen" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {customers.map((customer) => (
                        <SelectItem key={customer.id} value={customer.id}>
                          {customer.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {!canChangeCustomer ? (
                    <FormDescription>
                      Für den Wechsel der Kundschaft fehlt Ihnen die Berechtigung.
                    </FormDescription>
                  ) : null}
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="addressId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Einsatzadresse</FormLabel>
                  <Select value={field.value ?? ''} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Adresse wählen" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {addresses.map((address) => (
                        <SelectItem key={address.id} value={address.id}>
                          {address.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Es stehen die Adressen der oben gewählten Kundschaft zur Auswahl.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {properties.length > 0 ? (
              <FormField
                control={form.control}
                name="propertyId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Objekt</FormLabel>
                    <Select
                      value={field.value ?? 'none'}
                      onValueChange={(value) => field.onChange(value === 'none' ? null : value)}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="none">Kein Objekt hinterlegt</SelectItem>
                        {properties.map((property) => (
                          <SelectItem key={property.id} value={property.id}>
                            {property.label}
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
              name="propertyKind"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Objektart</FormLabel>
                  <Select value={field.value ?? 'APARTMENT'} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {PROPERTY_KINDS.map((kind) => (
                        <SelectItem key={kind.value} value={kind.value}>
                          {kind.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <NumberField control={form.control} name="squareMeters" label="Fläche" suffix="m²" />
            <NumberField control={form.control} name="rooms" label="Zimmer" />
            <NumberField control={form.control} name="windows" label="Fenster" />
          </div>
        </section>

        {/* --- Positionen und Preis ------------------------------------ */}
        <section className="space-y-4 border-t border-border pt-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h2 className="font-display text-base font-semibold tracking-tight">
              Leistungen und Preis
            </h2>

            {canEditPricing ? (
              <div className="flex flex-wrap items-center gap-2">
                <Select value="" onValueChange={addItem}>
                  <SelectTrigger className="w-56" aria-label="Leistung hinzufügen">
                    <SelectValue placeholder="Leistung hinzufügen …" />
                  </SelectTrigger>
                  <SelectContent>
                    {services.map((service) => (
                      <SelectItem key={service.id} value={service.id}>
                        {service.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {extras.length > 0 ? (
                  <Select value="" onValueChange={addExtra}>
                    <SelectTrigger className="w-56" aria-label="Zusatzleistung hinzufügen">
                      <SelectValue placeholder="Zusatzleistung …" />
                    </SelectTrigger>
                    <SelectContent>
                      {extras.map((extra) => (
                        <SelectItem key={extra.id} value={extra.id}>
                          {extra.name} · {formatCurrency(extra.price)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
              </div>
            ) : null}
          </div>

          {!canEditPricing ? (
            <Alert variant="info" title="Preise ändert die Verwaltung">
              <span className="flex items-start gap-2">
                <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
                Positionen, Zuschläge und Rabatt eines Auftrags sind eine kaufmännische
                Entscheidung. Termin, Team, Adresse, Objektangaben und Notizen können Sie
                bearbeiten.
              </span>
            </Alert>
          ) : null}

          <ul className={cn('space-y-3', !canEditPricing && 'pointer-events-none opacity-60')}>
            {itemFields.fields.map((field, index) => (
              <li key={field.id} className="rounded-2xl border border-border bg-card p-4">
                <div className="grid gap-3 sm:grid-cols-12">
                  <div className="sm:col-span-12">
                    <Label htmlFor={`booking-item-name-${index}`} className="text-xs">
                      Bezeichnung
                    </Label>
                    <Input
                      id={`booking-item-name-${index}`}
                      {...form.register(`items.${index}.name`)}
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <Label htmlFor={`booking-item-qty-${index}`} className="text-xs">
                      Menge
                    </Label>
                    <Input
                      id={`booking-item-qty-${index}`}
                      inputMode="decimal"
                      {...form.register(`items.${index}.quantity`, { valueAsNumber: true })}
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <Label htmlFor={`booking-item-unit-${index}`} className="text-xs">
                      Einheit
                    </Label>
                    <Input
                      id={`booking-item-unit-${index}`}
                      {...form.register(`items.${index}.unit`)}
                    />
                  </div>

                  <div className="sm:col-span-3">
                    <Label htmlFor={`booking-item-price-${index}`} className="text-xs">
                      Preis (netto)
                    </Label>
                    <Input
                      id={`booking-item-price-${index}`}
                      inputMode="decimal"
                      suffix="CHF"
                      {...form.register(`items.${index}.unitPrice`, { valueAsNumber: true })}
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <Label htmlFor={`booking-item-duration-${index}`} className="text-xs">
                      Dauer
                    </Label>
                    <Input
                      id={`booking-item-duration-${index}`}
                      inputMode="numeric"
                      suffix="Min."
                      {...form.register(`items.${index}.durationMin`, { valueAsNumber: true })}
                    />
                  </div>

                  <div className="flex items-end justify-between gap-2 sm:col-span-3">
                    <p className="flex h-11 flex-1 items-center justify-end font-medium tabular-nums">
                      {formatCurrency(
                        round2(
                          (Number(items?.[index]?.quantity) || 0) *
                            (Number(items?.[index]?.unitPrice) || 0),
                        ),
                      )}
                    </p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => itemFields.remove(index)}
                      disabled={itemFields.fields.length === 1}
                      aria-label={`Position ${index + 1} entfernen`}
                      className="mb-1.5 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                </div>
              </li>
            ))}

            {extraFields.fields.map((field, index) => (
              <li
                key={field.id}
                className="rounded-2xl border border-dashed border-border bg-muted/30 p-4"
              >
                <div className="grid items-end gap-3 sm:grid-cols-12">
                  <div className="sm:col-span-6">
                    <Label className="text-xs">Zusatzleistung</Label>
                    <Input readOnly {...form.register(`extras.${index}.name`)} />
                  </div>
                  <div className="sm:col-span-2">
                    <Label htmlFor={`booking-extra-qty-${index}`} className="text-xs">
                      Menge
                    </Label>
                    <Input
                      id={`booking-extra-qty-${index}`}
                      inputMode="numeric"
                      {...form.register(`extras.${index}.quantity`, { valueAsNumber: true })}
                    />
                  </div>
                  <div className="sm:col-span-3">
                    <Label htmlFor={`booking-extra-price-${index}`} className="text-xs">
                      Preis
                    </Label>
                    <Input
                      id={`booking-extra-price-${index}`}
                      inputMode="decimal"
                      suffix="CHF"
                      {...form.register(`extras.${index}.unitPrice`, { valueAsNumber: true })}
                    />
                  </div>
                  <div className="sm:col-span-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => extraFields.remove(index)}
                      aria-label={`Zusatzleistung ${index + 1} entfernen`}
                      className="mb-1.5 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>

          {itemFields.fields.length === 0 && canEditPricing ? (
            <Button type="button" variant="outline" size="sm" onClick={() => addItem(services[0]?.id ?? '')}>
              <Plus aria-hidden />
              Erste Position hinzufügen
            </Button>
          ) : null}

          <div className="grid gap-6 lg:grid-cols-2">
            <div
              className={cn(
                'grid gap-4 sm:grid-cols-3',
                !canEditPricing && 'pointer-events-none opacity-60',
              )}
            >
              <NumberField control={form.control} name="travelFee" label="Anfahrt" suffix="CHF" />
              <NumberField control={form.control} name="discountAmount" label="Rabatt" suffix="CHF" />
              <NumberField control={form.control} name="vatRate" label="MWST" suffix="%" />
            </div>

            <dl className="space-y-1 rounded-2xl border border-border bg-card p-5">
              <SumRow label="Leistungen" value={totals.subtotal} />
              {totals.extrasTotal > 0 ? (
                <SumRow label="Zusatzleistungen" value={totals.extrasTotal} />
              ) : null}
              {totals.travel > 0 ? <SumRow label="Anfahrt" value={totals.travel} /> : null}
              {totals.discount > 0 ? (
                <SumRow label="Rabatt" value={-totals.discount} tone="success" />
              ) : null}
              <SumRow label="Total netto" value={totals.netTotal} />
              <SumRow label={`MWST ${Number(vatRate ?? 0).toFixed(1)} %`} value={totals.vat} />
              <div className="flex items-baseline justify-between gap-4 border-t border-border pt-3">
                <dt className="font-semibold">Gesamtbetrag</dt>
                <dd className="font-display text-xl font-bold tabular-nums">
                  {formatCurrency(totals.grossTotal)}
                </dd>
              </div>
            </dl>
          </div>
        </section>

        {/* --- Notizen -------------------------------------------------- */}
        <section className="space-y-5 border-t border-border pt-6">
          <h2 className="font-display text-base font-semibold tracking-tight">Notizen</h2>

          <FormField
            control={form.control}
            name="accessNote"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Zugang</FormLabel>
                <FormControl>
                  <Textarea rows={2} {...field} value={field.value ?? ''} />
                </FormControl>
                <FormDescription>
                  Schlüsselkasten, Code, Ansprechperson — steht dem Team auf dem Telefon.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="customerNote"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Anmerkung der Kundschaft</FormLabel>
                <FormControl>
                  <Textarea rows={3} {...field} value={field.value ?? ''} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="internalNote"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Interne Notiz</FormLabel>
                <FormControl>
                  <Textarea rows={3} {...field} value={field.value ?? ''} />
                </FormControl>
                <FormDescription>Nur intern sichtbar, nie in Kundendokumenten.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="changeReason"
            render={({ field }) => (
              <FormItem>
                <FormLabel required={status === 'CANCELLED'}>Grund der Änderung</FormLabel>
                <FormControl>
                  <Input
                    placeholder="z. B. Kundschaft hat Termin telefonisch verschoben"
                    {...field}
                    value={field.value ?? ''}
                  />
                </FormControl>
                <FormDescription>
                  Erscheint in der Änderungsspur am Auftrag. Beim Storno geht er zusätzlich an die
                  Kundschaft.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </section>

        <div className="flex flex-wrap justify-end gap-3 border-t border-border pt-6">
          <Button type="button" variant="ghost" onClick={() => router.back()}>
            Abbrechen
          </Button>
          <Button type="submit" size="lg" loading={form.formState.isSubmitting}>
            <Save aria-hidden />
            Auftrag {bookingNumber} speichern
          </Button>
        </div>
      </form>
    </Form>
  );
}

function SumRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'success';
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className={cn('text-sm', tone === 'success' ? 'text-success' : 'text-muted-foreground')}>
        {label}
      </dt>
      <dd className={cn('text-sm tabular-nums', tone === 'success' && 'text-success')}>
        {formatCurrency(value)}
      </dd>
    </div>
  );
}

/**
 * Zahlenfeld mit leerem statt `0`-Zustand.
 *
 * `valueAsNumber` macht aus einem geleerten Feld `NaN`; das schriebe still eine
 * Null in die Datenbank. Hier wird ein leeres Feld zu `undefined` — und ein
 * nicht gesendetes Feld lässt der Server unverändert.
 */
function NumberField({
  control,
  name,
  label,
  suffix,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  control: any;
  name:
    | 'squareMeters'
    | 'rooms'
    | 'windows'
    | 'travelFee'
    | 'discountAmount'
    | 'vatRate';
  label: string;
  suffix?: string;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              inputMode="decimal"
              suffix={suffix}
              value={field.value ?? ''}
              onChange={(event) => {
                const raw = event.target.value.trim();
                field.onChange(raw === '' ? undefined : Number(raw.replace(',', '.')));
              }}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/** ISO-Zeitstempel in den Wert eines `datetime-local`-Feldes umwandeln. */
function toLocalInput(value: unknown): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
