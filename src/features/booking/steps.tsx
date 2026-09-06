'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  Building,
  Building2,
  CalendarDays,
  Check,
  Factory,
  HardHat,
  Home,
  Hotel,
  Loader2,
  MapPin,
  School,
  Stethoscope,
  UtensilsCrossed,
} from 'lucide-react';

import { cn, formatCurrency, formatDateLong, toDateKey } from '@/lib/utils';
import { api } from '@/lib/api/client';
import { serviceIconFor } from '@/components/marketing/service-icon';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/form';
import { Checkbox, OptionCard, RadioGroup, Stepper } from '@/components/ui/controls';
import { Alert } from '@/components/ui/primitives';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

import { useBookingStore, type Frequency, type PropertyKind } from './store';
import type {
  AvailabilityDto,
  BookingService,
  SavedAddressDto,
  SavedPropertyDto,
} from './types';

/**
 * Die sechs Schritte des Buchungsassistenten.
 *
 * Gestaltungsregel: pro Schritt eine Frage, in der Sprache der Kundschaft
 * gestellt. Keine Formularfelder ohne Kontext, keine Fachbegriffe.
 */

const PROPERTY_KINDS: { value: PropertyKind; label: string; Icon: React.ComponentType<{ className?: string }> }[] = [
  { value: 'APARTMENT', label: 'Wohnung', Icon: Home },
  { value: 'HOUSE', label: 'Haus', Icon: Home },
  { value: 'OFFICE', label: 'Büro', Icon: Building2 },
  { value: 'COMMERCIAL', label: 'Ladenlokal', Icon: Building },
  { value: 'PRACTICE', label: 'Praxis', Icon: Stethoscope },
  { value: 'RESTAURANT', label: 'Gastronomie', Icon: UtensilsCrossed },
  { value: 'CONSTRUCTION_SITE', label: 'Baustelle', Icon: HardHat },
  { value: 'INDUSTRIAL', label: 'Gewerbe', Icon: Factory },
  { value: 'SCHOOL', label: 'Schule', Icon: School },
  { value: 'OTHER', label: 'Anderes', Icon: Hotel },
];

const FREQUENCIES: { value: Frequency; label: string; hint: string }[] = [
  { value: 'ONCE', label: 'Einmalig', hint: 'Ein einzelner Termin' },
  { value: 'WEEKLY', label: 'Wöchentlich', hint: '15 % Rabatt' },
  { value: 'BIWEEKLY', label: 'Alle zwei Wochen', hint: '10 % Rabatt' },
  { value: 'MONTHLY', label: 'Monatlich', hint: '5 % Rabatt' },
];

// ---------------------------------------------------------------------------
//  1) Leistung
// ---------------------------------------------------------------------------

export function StepService({ services }: { services: BookingService[] }) {
  const serviceId = useBookingStore((s) => s.serviceId);
  const frequency = useBookingStore((s) => s.frequency);
  const patch = useBookingStore((s) => s.patch);

  const selected = services.find((service) => service.id === serviceId);
  const allowsRecurring = selected?.kind === 'RESIDENTIAL_CLEANING' || selected?.kind === 'OFFICE_CLEANING';

  return (
    <div className="space-y-10">
      <fieldset className="space-y-4">
        <legend className="sr-only">Dienstleistung wählen</legend>
        <RadioGroup
          value={serviceId ?? ''}
          onValueChange={(value) => {
            const service = services.find((item) => item.id === value);
            patch({
              serviceId: value,
              serviceSlug: service?.slug ?? null,
              // Extras gehören zur Leistung — bei Wechsel zurücksetzen.
              extras: {},
              ...(service?.kind === 'RESIDENTIAL_CLEANING' || service?.kind === 'OFFICE_CLEANING'
                ? {}
                : { frequency: 'ONCE' as Frequency }),
            });
          }}
          className="sm:grid-cols-2"
        >
          {services.map((service) => {
            const Icon = serviceIconFor(service.icon);
            return (
              <OptionCard
                key={service.id}
                value={service.id}
                title={service.name}
                description={service.shortDesc}
                icon={<Icon />}
                meta={
                  service.pricingModel === 'ON_REQUEST'
                    ? 'Individuelle Offerte'
                    : service.pricingModel === 'PER_HOUR'
                      ? `ab ${formatCurrency(service.hourlyRate ?? 0)} / Std.`
                      : `ab ${formatCurrency(service.minPrice)}`
                }
              />
            );
          })}
        </RadioGroup>
      </fieldset>

      {selected?.pricingModel === 'ON_REQUEST' ? (
        <Alert variant="info" title="Diese Leistung offerieren wir individuell">
          Hauswartung und Liegenschaftsbetreuung planen wir gemeinsam mit Ihnen. Nutzen Sie bitte
          das{' '}
          <Link href="/offerte" className="font-medium underline underline-offset-2">
            Offertformular
          </Link>{' '}
          — wir melden uns innert 24 Stunden.
        </Alert>
      ) : null}

      {allowsRecurring ? (
        <fieldset className="space-y-4">
          <legend className="mb-1 font-display text-lg font-semibold tracking-tight">
            Wie oft sollen wir kommen?
          </legend>
          <p className="text-sm text-muted-foreground">
            Regelmässige Reinigung ist günstiger — Sie bekommen dasselbe Team und können jederzeit
            kündigen.
          </p>
          <RadioGroup
            value={frequency}
            onValueChange={(value) => patch({ frequency: value as Frequency })}
            className="sm:grid-cols-2 lg:grid-cols-4"
          >
            {FREQUENCIES.map((option) => (
              <OptionCard
                key={option.value}
                value={option.value}
                title={option.label}
                meta={option.hint}
              />
            ))}
          </RadioGroup>
        </fieldset>
      ) : null}

      {selected && selected.includes.length > 0 ? (
        <div className="rounded-2xl border border-border bg-surface p-6">
          <h3 className="mb-4 font-display text-base font-semibold">
            Bei {selected.name} inbegriffen
          </h3>
          <ul className="grid gap-2.5 sm:grid-cols-2">
            {selected.includes.map((item) => (
              <li key={item} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                {item}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
//  2) Objekt
// ---------------------------------------------------------------------------

export function StepProperty({
  services,
  savedProperties,
}: {
  services: BookingService[];
  savedProperties: SavedPropertyDto[];
}) {
  const state = useBookingStore();
  const patch = useBookingStore((s) => s.patch);
  const service = services.find((item) => item.id === state.serviceId);

  const isWindowService = service?.kind === 'WINDOW_CLEANING';

  return (
    <div className="space-y-10">
      {savedProperties.length > 0 ? (
        <fieldset className="space-y-4">
          <legend className="mb-1 font-display text-lg font-semibold tracking-tight">
            Gespeicherte Objekte
          </legend>
          <RadioGroup
            value={state.propertyId ?? ''}
            onValueChange={(value) => {
              const property = savedProperties.find((item) => item.id === value);
              if (!property) return;
              patch({
                propertyId: property.id,
                propertyKind: property.kind as PropertyKind,
                squareMeters: property.squareMeters,
                rooms: property.rooms,
                bathrooms: property.bathrooms,
                windows: property.windows,
                addressId: property.addressId,
              });
            }}
            className="sm:grid-cols-2"
          >
            {savedProperties.map((property) => (
              <OptionCard
                key={property.id}
                value={property.id}
                title={property.label}
                description={[
                  property.squareMeters ? `${property.squareMeters} m²` : null,
                  property.rooms ? `${property.rooms} Zimmer` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                icon={<Home />}
              />
            ))}
          </RadioGroup>
          <button
            type="button"
            onClick={() => patch({ propertyId: null })}
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            Anderes Objekt erfassen
          </button>
        </fieldset>
      ) : null}

      <fieldset className="space-y-4">
        <legend className="mb-1 font-display text-lg font-semibold tracking-tight">
          Um was für Räume geht es?
        </legend>
        <div className="flex flex-wrap gap-2">
          {PROPERTY_KINDS.map(({ value, label, Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => patch({ propertyKind: value })}
              aria-pressed={state.propertyKind === value}
              className={cn(
                'inline-flex items-center gap-2 rounded-xl border-2 px-3.5 py-2 text-sm font-medium transition-all duration-200',
                'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/15',
                state.propertyKind === value
                  ? 'border-primary bg-primary/[0.06] text-foreground'
                  : 'border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground',
              )}
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-6 sm:grid-cols-2">
        {isWindowService ? (
          <div className="space-y-2">
            <Label htmlFor="windows" required>
              Anzahl Fenster
            </Label>
            <Input
              id="windows"
              inputMode="numeric"
              value={state.windows ?? ''}
              onChange={(event) =>
                patch({ windows: Number(event.target.value.replace(/\D/g, '')) || null })
              }
              suffix="Stk."
              placeholder="12"
            />
            <p className="text-meta text-muted-foreground">
              Zählen Sie jeden Fensterflügel einzeln. Eine Balkontür zählt als ein Fenster.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="sqm" required>
              Fläche
            </Label>
            <Input
              id="sqm"
              inputMode="numeric"
              value={state.squareMeters ?? ''}
              onChange={(event) =>
                patch({ squareMeters: Number(event.target.value.replace(/\D/g, '')) || null })
              }
              suffix="m²"
              placeholder="85"
            />
            <p className="text-meta text-muted-foreground">
              Die Wohnfläche steht im Mietvertrag. Eine Schätzung genügt.
            </p>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="rooms">Zimmer</Label>
          <Input
            id="rooms"
            inputMode="decimal"
            value={state.rooms ?? ''}
            onChange={(event) => {
              const raw = event.target.value.replace(',', '.').replace(/[^\d.]/g, '');
              patch({ rooms: Number(raw) || null });
            }}
            placeholder="3.5"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="bathrooms">Bäder / WC</Label>
          <Input
            id="bathrooms"
            inputMode="numeric"
            value={state.bathrooms ?? ''}
            onChange={(event) =>
              patch({ bathrooms: Number(event.target.value.replace(/\D/g, '')) || null })
            }
            placeholder="1"
          />
        </div>

        {!isWindowService ? (
          <div className="space-y-2">
            <Label htmlFor="windows-optional">Fenster (optional)</Label>
            <Input
              id="windows-optional"
              inputMode="numeric"
              value={state.windows ?? ''}
              onChange={(event) =>
                patch({ windows: Number(event.target.value.replace(/\D/g, '')) || null })
              }
              suffix="Stk."
              placeholder="9"
            />
          </div>
        ) : null}
      </div>

      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-card p-4">
        <Checkbox
          checked={state.hasPets}
          onCheckedChange={(checked) => patch({ hasPets: checked === true })}
          id="pets"
        />
        <span className="space-y-0.5">
          <span className="block text-sm font-medium">Es leben Haustiere im Haushalt</span>
          <span className="block text-meta leading-relaxed text-muted-foreground">
            Tierhaare brauchen mehr Zeit. Wir planen das ein, damit der Termin nicht knapp wird.
          </span>
        </span>
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  3) Extras
// ---------------------------------------------------------------------------

export function StepExtras({ services }: { services: BookingService[] }) {
  const serviceId = useBookingStore((s) => s.serviceId);
  const extras = useBookingStore((s) => s.extras);
  const setExtra = useBookingStore((s) => s.setExtra);
  const customerNote = useBookingStore((s) => s.customerNote);
  const patch = useBookingStore((s) => s.patch);

  const service = services.find((item) => item.id === serviceId);
  const options = service?.extras ?? [];

  return (
    <div className="space-y-10">
      {options.length > 0 ? (
        <fieldset className="space-y-4">
          <legend className="mb-1 font-display text-lg font-semibold tracking-tight">
            Sollen wir noch etwas erledigen?
          </legend>
          <p className="text-sm text-muted-foreground">
            Alles optional. Sie können Zusätze auch später noch mit uns absprechen.
          </p>

          <div className="protocol-list rounded-2xl border border-border bg-card px-5">
            {options.map((extra) => {
              const quantity = extras[extra.id] ?? 0;
              const active = quantity > 0;

              return (
                <div
                  key={extra.id}
                  className="flex flex-wrap items-center justify-between gap-4 py-4"
                >
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        'font-medium transition-colors',
                        active ? 'text-foreground' : 'text-foreground/90',
                      )}
                    >
                      {extra.name}
                    </p>
                    {extra.description ? (
                      <p className="mt-0.5 text-meta leading-relaxed text-muted-foreground">
                        {extra.description}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex items-center gap-4">
                    <span className="whitespace-nowrap text-sm font-semibold tabular-nums">
                      {formatCurrency(extra.price)}
                    </span>
                    <Stepper
                      value={quantity}
                      onChange={(value) => setExtra(extra.id, value)}
                      max={20}
                      label={extra.name}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="note">Gibt es etwas, das wir wissen sollten?</Label>
        <Textarea
          id="note"
          value={customerNote}
          onChange={(event) => patch({ customerNote: event.target.value })}
          placeholder="Zum Beispiel: Der Backofen wurde lange nicht gereinigt. Die Katze bitte nicht auf den Balkon lassen."
          rows={4}
          maxLength={2000}
        />
        <p className="text-meta text-muted-foreground">
          Je konkreter, desto besser können wir den Einsatz planen.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  4) Termin
// ---------------------------------------------------------------------------

export function StepSchedule() {
  const serviceId = useBookingStore((s) => s.serviceId);
  const scheduledStart = useBookingStore((s) => s.scheduledStart);
  const patch = useBookingStore((s) => s.patch);

  // Frühestens übermorgen — davor reicht die Vorlaufzeit für die Disposition nicht.
  const [selectedDate, setSelectedDate] = React.useState(() => {
    const date = new Date();
    date.setDate(date.getDate() + 2);
    return toDateKey(date);
  });

  const { data, isLoading } = useQuery<AvailabilityDto>({
    queryKey: ['availability', serviceId, selectedDate],
    queryFn: () =>
      api.get<AvailabilityDto>('/api/public/availability', {
        serviceId: serviceId!,
        date: selectedDate,
      }),
    enabled: Boolean(serviceId),
    staleTime: 60_000,
  });

  const days = React.useMemo(() => {
    const list: { key: string; weekday: string; day: string; month: string }[] = [];
    const cursor = new Date();
    cursor.setDate(cursor.getDate() + 1);

    for (let index = 0; index < 21; index++) {
      const key = toDateKey(cursor);
      list.push({
        key,
        weekday: new Intl.DateTimeFormat('de-CH', { weekday: 'short', timeZone: 'Europe/Zurich' }).format(cursor),
        day: new Intl.DateTimeFormat('de-CH', { day: 'numeric', timeZone: 'Europe/Zurich' }).format(cursor),
        month: new Intl.DateTimeFormat('de-CH', { month: 'short', timeZone: 'Europe/Zurich' }).format(cursor),
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    return list;
  }, []);

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <h2 className="font-display text-lg font-semibold tracking-tight">Datum wählen</h2>
        <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-2">
          {days.map((day) => {
            const active = day.key === selectedDate;
            return (
              <button
                key={day.key}
                type="button"
                onClick={() => setSelectedDate(day.key)}
                aria-pressed={active}
                className={cn(
                  'flex min-w-[4.5rem] shrink-0 flex-col items-center gap-0.5 rounded-xl border-2 px-3 py-3 transition-all duration-200',
                  'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/15',
                  active
                    ? 'border-primary bg-primary/[0.06]'
                    : 'border-border bg-card hover:border-primary/40',
                )}
              >
                <span className="text-xs text-muted-foreground">{day.weekday}</span>
                <span className="font-display text-lg font-bold tabular-nums leading-none">
                  {day.day}
                </span>
                <span className="text-xs text-muted-foreground">{day.month}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="font-display text-lg font-semibold tracking-tight">Startzeit wählen</h2>
          <p className="text-sm text-muted-foreground">{formatDateLong(`${selectedDate}T12:00:00Z`)}</p>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Freie Zeitfenster werden geladen …
          </div>
        ) : data?.closed ? (
          <Alert variant="info" title="An diesem Tag arbeiten wir nicht">
            {data.reason ?? 'Bitte wählen Sie ein anderes Datum.'}
          </Alert>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
              {data?.slots.map((slot) => {
                const active = scheduledStart === slot.start;
                return (
                  <button
                    key={slot.start}
                    type="button"
                    disabled={!slot.available}
                    onClick={() => patch({ scheduledStart: slot.start })}
                    aria-pressed={active}
                    className={cn(
                      'rounded-xl border-2 py-2.5 text-sm font-medium tabular-nums transition-all duration-200',
                      'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/15',
                      'disabled:cursor-not-allowed disabled:border-border disabled:bg-muted disabled:text-muted-foreground/50 disabled:line-through',
                      active
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-card hover:border-primary/50',
                    )}
                  >
                    {slot.label}
                  </button>
                );
              })}
            </div>

            {data && data.slots.every((slot) => !slot.available) ? (
              <Alert variant="warning" title="An diesem Tag ist alles ausgebucht">
                Bitte wählen Sie ein anderes Datum — oder rufen Sie uns an, wir finden meist noch
                eine Lösung.
              </Alert>
            ) : null}
          </>
        )}
      </div>

      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <CalendarDays className="size-4 text-primary" aria-hidden />
        Kostenlose Umbuchung oder Stornierung bis 24 Stunden vor dem Termin.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  5) Kontakt & Adresse
// ---------------------------------------------------------------------------

export function StepContact({
  isAuthenticated,
  savedAddresses,
}: {
  isAuthenticated: boolean;
  savedAddresses: SavedAddressDto[];
}) {
  const state = useBookingStore();
  const patch = useBookingStore((s) => s.patch);

  const [manualAddress, setManualAddress] = React.useState(savedAddresses.length === 0);

  return (
    <div className="space-y-10">
      {!isAuthenticated ? (
        <fieldset className="space-y-6">
          <legend className="mb-1 font-display text-lg font-semibold tracking-tight">
            Wie erreichen wir Sie?
          </legend>

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="firstName" required>
                Vorname
              </Label>
              <Input
                id="firstName"
                autoComplete="given-name"
                value={state.firstName}
                onChange={(event) => patch({ firstName: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lastName" required>
                Nachname
              </Label>
              <Input
                id="lastName"
                autoComplete="family-name"
                value={state.lastName}
                onChange={(event) => patch({ lastName: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email" required>
                E-Mail
              </Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                value={state.email}
                onChange={(event) => patch({ email: event.target.value })}
              />
              <p className="text-meta text-muted-foreground">
                Hierhin senden wir Bestätigung, Erinnerung und Rechnung.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="phone" required>
                Telefon
              </Label>
              <Input
                id="phone"
                type="tel"
                autoComplete="tel"
                placeholder="079 123 45 67"
                value={state.phone}
                onChange={(event) => patch({ phone: event.target.value })}
              />
              <p className="text-meta text-muted-foreground">
                Nur für Rückfragen zum Termin.
              </p>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="company">Firma (optional)</Label>
              <Input
                id="company"
                autoComplete="organization"
                value={state.companyName}
                onChange={(event) => patch({ companyName: event.target.value })}
              />
            </div>
          </div>
        </fieldset>
      ) : null}

      {savedAddresses.length > 0 && !manualAddress ? (
        <fieldset className="space-y-4">
          <legend className="mb-1 font-display text-lg font-semibold tracking-tight">
            Wo sollen wir reinigen?
          </legend>
          <RadioGroup
            value={state.addressId ?? ''}
            onValueChange={(value) => patch({ addressId: value })}
            className="sm:grid-cols-2"
          >
            {savedAddresses.map((address) => (
              <OptionCard
                key={address.id}
                value={address.id}
                title={address.label ?? 'Adresse'}
                description={`${address.street} ${address.streetNo ?? ''}, ${address.postalCode} ${address.city}`}
                icon={<MapPin />}
              />
            ))}
          </RadioGroup>
          <Button variant="ghost" size="sm" onClick={() => setManualAddress(true)}>
            Andere Adresse eingeben
          </Button>
        </fieldset>
      ) : (
        <fieldset className="space-y-6">
          <legend className="mb-1 font-display text-lg font-semibold tracking-tight">
            Wo sollen wir reinigen?
          </legend>

          <div className="grid gap-5 sm:grid-cols-[2fr_1fr]">
            <div className="space-y-2">
              <Label htmlFor="street" required>
                Strasse
              </Label>
              <Input
                id="street"
                autoComplete="address-line1"
                value={state.street}
                onChange={(event) => patch({ street: event.target.value, addressId: null })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="streetNo">Nummer</Label>
              <Input
                id="streetNo"
                value={state.streetNo}
                onChange={(event) => patch({ streetNo: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="postalCode" required>
                Postleitzahl
              </Label>
              <Input
                id="postalCode"
                inputMode="numeric"
                maxLength={4}
                value={state.postalCode}
                onChange={(event) =>
                  patch({ postalCode: event.target.value.replace(/\D/g, '').slice(0, 4) })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="city" required>
                Ort
              </Label>
              <Input
                id="city"
                autoComplete="address-level2"
                value={state.city}
                onChange={(event) => patch({ city: event.target.value })}
              />
            </div>
          </div>

          {savedAddresses.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => setManualAddress(false)}>
              Gespeicherte Adresse verwenden
            </Button>
          ) : null}
        </fieldset>
      )}

      <div className="space-y-2">
        <Label htmlFor="access">Wie kommen wir ins Gebäude?</Label>
        <Textarea
          id="access"
          value={state.accessNote}
          onChange={(event) => patch({ accessNote: event.target.value })}
          placeholder="Zum Beispiel: Schlüssel beim Nachbarn im 2. Stock. Parkplatz im Hof, Code 4711."
          rows={3}
          maxLength={500}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  6) Übersicht
// ---------------------------------------------------------------------------

export function StepSummary({ services }: { services: BookingService[] }) {
  const state = useBookingStore();
  const patch = useBookingStore((s) => s.patch);
  const service = services.find((item) => item.id === state.serviceId);

  const address = state.addressId
    ? 'Gespeicherte Adresse'
    : `${state.street} ${state.streetNo}, ${state.postalCode} ${state.city}`.replace(/\s+/g, ' ').trim();

  const selectedExtras = Object.entries(state.extras)
    .map(([extraId, quantity]) => {
      const extra = service?.extras.find((item) => item.id === extraId);
      return extra ? `${quantity}× ${extra.name}` : null;
    })
    .filter(Boolean);

  return (
    <div className="space-y-8">
      <dl className="protocol-list rounded-2xl border border-border bg-card px-6">
        <div className="protocol-row">
          <dt className="protocol-label">Leistung</dt>
          <dd className="protocol-value">{service?.name ?? '—'}</dd>
        </div>
        <div className="protocol-row">
          <dt className="protocol-label">Turnus</dt>
          <dd className="protocol-value">
            {FREQUENCIES.find((f) => f.value === state.frequency)?.label ?? 'Einmalig'}
          </dd>
        </div>
        <div className="protocol-row">
          <dt className="protocol-label">Objekt</dt>
          <dd className="protocol-value">
            {PROPERTY_KINDS.find((k) => k.value === state.propertyKind)?.label}
            {state.squareMeters ? ` · ${state.squareMeters} m²` : ''}
            {state.rooms ? ` · ${state.rooms} Zimmer` : ''}
            {state.windows ? ` · ${state.windows} Fenster` : ''}
          </dd>
        </div>
        {selectedExtras.length > 0 ? (
          <div className="protocol-row">
            <dt className="protocol-label">Zusätze</dt>
            <dd className="protocol-value">{selectedExtras.join(', ')}</dd>
          </div>
        ) : null}
        <div className="protocol-row">
          <dt className="protocol-label">Termin</dt>
          <dd className="protocol-value">
            {state.scheduledStart
              ? new Intl.DateTimeFormat('de-CH', {
                  timeZone: 'Europe/Zurich',
                  weekday: 'long',
                  day: '2-digit',
                  month: 'long',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                }).format(new Date(state.scheduledStart)) + ' Uhr'
              : '—'}
          </dd>
        </div>
        <div className="protocol-row">
          <dt className="protocol-label">Adresse</dt>
          <dd className="protocol-value">{address || '—'}</dd>
        </div>
        {state.customerNote ? (
          <div className="protocol-row">
            <dt className="protocol-label">Ihre Anmerkung</dt>
            <dd className="protocol-value whitespace-pre-line">{state.customerNote}</dd>
          </div>
        ) : null}
      </dl>

      <div className="space-y-2">
        <Label htmlFor="coupon">Gutscheincode</Label>
        <div className="flex gap-2">
          <Input
            id="coupon"
            value={state.couponCode}
            onChange={(event) => patch({ couponCode: event.target.value.toUpperCase() })}
            placeholder="z. B. WILLKOMMEN20"
            className="max-w-xs"
          />
          {state.couponCode ? <Badge variant="success">Wird geprüft</Badge> : null}
        </div>
      </div>

      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-card p-4">
        <Checkbox
          id="terms"
          checked={state.acceptTerms}
          onCheckedChange={(checked) => patch({ acceptTerms: checked === true })}
        />
        <span className="text-sm leading-relaxed">
          Ich akzeptiere die{' '}
          <a href="/legal/agb" target="_blank" className="font-medium underline underline-offset-2">
            AGB
          </a>{' '}
          und die{' '}
          <a
            href="/legal/datenschutz"
            target="_blank"
            className="font-medium underline underline-offset-2"
          >
            Datenschutzerklärung
          </a>
          .
        </span>
      </label>
    </div>
  );
}
