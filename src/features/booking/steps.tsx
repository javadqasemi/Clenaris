'use client';

import * as React from 'react';
import Link from 'next/link';
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

import { cn, formatCurrency, formatDateLong, formatDuration, toDateKey } from '@/lib/utils';
import { ApiError } from '@/lib/api/client';
import { serviceIconFor } from '@/components/marketing/service-icon';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/form';
import { Checkbox, OptionCard, RadioGroup, Stepper } from '@/components/ui/controls';
import { Alert } from '@/components/ui/primitives';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

import { useBookingStore, WIEDERKEHRENDE_ARTEN, type Frequency, type PropertyKind } from './store';
import { useVerfuegbarkeit } from './use-availability';
import { useLivePrice } from './use-price';
import type {
  BookingService,
  CouponCheckDto,
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
  const auswahl = useBookingStore((s) => s.auswahl);
  const frequency = useBookingStore((s) => s.frequency);
  const patch = useBookingStore((s) => s.patch);
  const toggleLeistung = useBookingStore((s) => s.toggleLeistung);
  const price = useLivePrice();

  const gewaehlt = auswahl
    .map((l) => services.find((service) => service.id === l.id))
    .filter((service): service is BookingService => Boolean(service));
  const allowsRecurring = gewaehlt.length > 0 && gewaehlt.every((s) => WIEDERKEHRENDE_ARTEN.includes(s.kind));
  const aufAnfrage = gewaehlt.find((s) => s.pricingModel === 'ON_REQUEST');

  return (
    <div className="space-y-10">
      {/*
        Mehrfachauswahl (Produktsprint 2026-09-26): Büroreinigung *und*
        Fensterreinigung in einer Buchung. Die Karten sind Umschalter
        (`role="checkbox"`), keine Radioknöpfe mehr — eine zweite Wahl ersetzt
        die erste nicht, sie kommt dazu.
      */}
      <fieldset className="space-y-4">
        <legend className="mb-1 font-display text-lg font-semibold tracking-tight">
          Welche Leistungen wünschen Sie?
        </legend>
        <p className="text-sm text-muted-foreground">
          Sie können mehrere wählen — wir erledigen sie nacheinander am selben Termin.
        </p>
        <div className="grid gap-3 sm:grid-cols-2" role="group" aria-label="Dienstleistungen">
          {services.map((service) => {
            const Icon = serviceIconFor(service.icon);
            const checked = auswahl.some((l) => l.id === service.id);
            return (
              <button
                key={service.id}
                type="button"
                role="checkbox"
                aria-checked={checked}
                onClick={() => toggleLeistung({ id: service.id, slug: service.slug, kind: service.kind })}
                className={cn(
                  'flex items-start gap-3 rounded-2xl border-2 p-4 text-left transition-all duration-200',
                  'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/15',
                  checked ? 'border-primary bg-primary/[0.06]' : 'border-border bg-card hover:border-primary/40',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border-2 transition-colors',
                    checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                  )}
                  aria-hidden
                >
                  {checked ? <Check className="size-3.5" strokeWidth={3} /> : null}
                </span>
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-primary [&_svg]:size-5">
                  <Icon aria-hidden />
                </span>
                <span className="min-w-0 space-y-1">
                  <span className="block font-medium">{service.name}</span>
                  <span className="block text-meta leading-relaxed text-muted-foreground">{service.shortDesc}</span>
                  <span className="block text-xs font-medium text-primary">
                    {service.pricingModel === 'ON_REQUEST'
                      ? 'Individuelle Offerte'
                      : service.pricingModel === 'PER_HOUR'
                        ? `ab ${formatCurrency(service.hourlyRate ?? 0)} / Std.`
                        : `ab ${formatCurrency(service.minPrice)}`}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      {gewaehlt.length > 0 ? (
        <section aria-label="Ihre Leistungen" className="space-y-3 rounded-2xl border border-border bg-surface p-5">
          <h3 className="font-display text-base font-semibold">Ihre Leistungen</h3>
          <ul className="divide-y divide-border text-sm">
            {gewaehlt.map((service) => {
              const position = price.data?.positionen?.find((p) => p.serviceId === service.id);
              return (
                <li key={service.id} className="flex items-baseline justify-between gap-4 py-2">
                  <span className="font-medium">{service.name}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {position ? `ca. ${formatDuration(position.durationMinutes)}` : 'Dauer nach Ihren Angaben'}
                  </span>
                </li>
              );
            })}
          </ul>
          {price.data && gewaehlt.length > 1 ? (
            <p className="flex items-baseline justify-between gap-4 border-t border-border pt-3 text-sm">
              <span className="text-muted-foreground">Gesamtdauer</span>
              <span className="font-medium tabular-nums">ca. {formatDuration(price.data.durationMinutes)}</span>
            </p>
          ) : null}
        </section>
      ) : null}

      {aufAnfrage ? (
        <Alert variant="info" title={`${aufAnfrage.name} offerieren wir individuell`}>
          Hauswartung und Liegenschaftsbetreuung planen wir gemeinsam mit Ihnen. Wählen Sie diese
          Leistung ab, um den Rest direkt zu buchen, oder nutzen Sie das{' '}
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

      {gewaehlt
        .filter((service) => service.includes.length > 0)
        .map((service) => (
          <div key={service.id} className="rounded-2xl border border-border bg-surface p-6">
            <h3 className="mb-4 font-display text-base font-semibold">Bei {service.name} inbegriffen</h3>
            <ul className="grid gap-2.5 sm:grid-cols-2">
              {service.includes.map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                  <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
//  2) Objekt
// ---------------------------------------------------------------------------

export function StepProperty({
  savedProperties,
}: {
  services: BookingService[];
  savedProperties: SavedPropertyDto[];
}) {
  const state = useBookingStore();
  const patch = useBookingStore((s) => s.patch);

  // Welche Angaben Pflicht sind, hängt an der ganzen Auswahl: Fensterreinigung
  // braucht die Fensterzahl, jede andere Leistung Fläche oder Zimmer — bei
  // Büro- und Fensterreinigung zusammen also beides.
  const isWindowService = state.auswahl.some((l) => l.kind === 'WINDOW_CLEANING');
  const needsArea = state.auswahl.some((l) => l.kind !== 'WINDOW_CLEANING');

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
        ) : null}
        {needsArea ? (
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
        ) : null}

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
  const auswahl = useBookingStore((s) => s.auswahl);
  const extras = useBookingStore((s) => s.extras);
  const setExtra = useBookingStore((s) => s.setExtra);
  const customerNote = useBookingStore((s) => s.customerNote);
  const patch = useBookingStore((s) => s.patch);

  // Je gewählte Leistung ihre eigenen Zusätze — mit Überschrift, sobald es
  // mehr als eine Leistung ist, damit „Fensterrahmen" nicht bei der
  // Büroreinigung zu stehen scheint.
  const gruppen = auswahl
    .map((l) => services.find((service) => service.id === l.id))
    .filter((service): service is BookingService => Boolean(service && service.extras.length > 0));

  return (
    <div className="space-y-10">
      {gruppen.map((service) => (
        <fieldset key={service.id} className="space-y-4">
          <legend className="mb-1 font-display text-lg font-semibold tracking-tight">
            {auswahl.length > 1 ? `Zusätze zu ${service.name}` : 'Sollen wir noch etwas erledigen?'}
          </legend>
          <p className="text-sm text-muted-foreground">
            Alles optional. Sie können Zusätze auch später noch mit uns absprechen.
          </p>

          <div className="protocol-list rounded-2xl border border-border bg-card px-5">
            {service.extras.map((extra) => {
              const quantity = extras[service.id]?.[extra.id] ?? 0;
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
                      onChange={(value) => setExtra(service.id, extra.id, value)}
                      max={20}
                      label={auswahl.length > 1 ? `${extra.name} (${service.name})` : extra.name}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </fieldset>
      ))}

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
  const scheduledStart = useBookingStore((s) => s.scheduledStart);
  const terminHinweis = useBookingStore((s) => s.terminHinweis);
  const patch = useBookingStore((s) => s.patch);
  const { data, isLoading, isError, error, refetch, isFetching } = useVerfuegbarkeit(true);

  /**
   * Der gewählte Tag. Vorbelegt mit dem Tag des gewählten Termins, sonst mit
   * dem ersten Tag, der ein buchbares Zeitfenster hat — nie mit einem Tag,
   * den der Kalender gar nicht anbieten darf.
   */
  const [selectedDate, setSelectedDate] = React.useState<string | null>(
    scheduledStart ? toDateKey(scheduledStart) : null,
  );
  const tage = data?.tage ?? [];
  const ersterFreier = tage.find((t) => t.available)?.date ?? null;
  const tag = tage.find((t) => t.date === selectedDate && t.available) ?? tage.find((t) => t.date === ersterFreier);

  const beschriftung = (datum: string) => {
    const d = new Date(`${datum}T12:00:00Z`);
    const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('de-CH', { ...o, timeZone: 'Europe/Zurich' }).format(d);
    return { weekday: f({ weekday: 'short' }), day: f({ day: 'numeric' }), month: f({ month: 'short' }) };
  };

  return (
    <div className="space-y-8">
      {terminHinweis ? (
        <Alert variant="warning" title="Bitte Uhrzeit neu wählen">
          <span role="status">{terminHinweis}</span>
        </Alert>
      ) : null}

      <div className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display text-lg font-semibold tracking-tight">Datum wählen</h2>
          {data ? (
            <p className="text-sm text-muted-foreground">
              Einsatzdauer ca. {formatDuration(data.dauerMin)}
              {data.crew > 1 ? ` · ${data.crew} Personen` : ''}
            </p>
          ) : null}
        </div>

        {isLoading ? (
          // Skelett statt leerer Fläche: dieselbe Form wie die Tage, damit
          // nichts springt, wenn sie kommen.
          <div className="flex gap-2 overflow-hidden pb-2" aria-busy="true" aria-label="Kalender wird geladen">
            {Array.from({ length: 7 }, (_, i) => (
              <div key={i} className="h-[4.75rem] min-w-[4.5rem] animate-pulse rounded-xl bg-muted" />
            ))}
          </div>
        ) : isError ? (
          <Alert variant="destructive" title="Die freien Termine konnten nicht geladen werden">
            <span className="block">
              {error instanceof ApiError ? error.message : 'Bitte versuchen Sie es in einem Moment erneut.'}
            </span>
            <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void refetch()} loading={isFetching}>
              Erneut versuchen
            </Button>
          </Alert>
        ) : (
          <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-2" role="group" aria-label="Verfügbare Tage">
            {tage.map((t) => {
              const active = t.date === tag?.date;
              const b = beschriftung(t.date);
              return (
                <button
                  key={t.date}
                  type="button"
                  data-datum={t.date}
                  onClick={() => setSelectedDate(t.date)}
                  disabled={!t.available}
                  aria-pressed={active}
                  aria-label={`${formatDateLong(`${t.date}T12:00:00Z`)}${t.available ? '' : ' — nicht verfügbar'}`}
                  title={t.available ? undefined : (t.reason ?? 'Kein freies Zeitfenster')}
                  className={cn(
                    'flex min-w-[4.5rem] shrink-0 flex-col items-center gap-0.5 rounded-xl border-2 px-3 py-3 transition-all duration-200',
                    'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/15',
                    'disabled:cursor-not-allowed disabled:border-border disabled:bg-muted disabled:opacity-50',
                    active ? 'border-primary bg-primary/[0.06]' : 'border-border bg-card hover:border-primary/40',
                  )}
                >
                  <span className="text-xs text-muted-foreground">{b.weekday}</span>
                  <span className="font-display text-lg font-bold tabular-nums leading-none">{b.day}</span>
                  <span className="text-xs text-muted-foreground">{b.month}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {!isLoading && !isError ? (
        <div className="space-y-4">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="font-display text-lg font-semibold tracking-tight">Startzeit wählen</h2>
            {tag ? <p className="text-sm text-muted-foreground">{formatDateLong(`${tag.date}T12:00:00Z`)}</p> : null}
          </div>

          {!tag ? (
            <Alert variant="warning" title="In den nächsten drei Wochen ist kein Termin frei">
              Für diese Auswahl findet sich kein freies Zeitfenster. Rufen Sie uns an — wir finden
              meist trotzdem eine Lösung, oder buchen Sie die Leistungen getrennt.
            </Alert>
          ) : (
            // Nur buchbare Anfangszeiten: Jede davon lässt die ganze Auswahl
            // vollständig in die Einsatzzeit passen und hat freies Personal.
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6" role="group" aria-label="Freie Startzeiten">
              {tag.slots
                .filter((slot) => slot.available)
                .map((slot) => {
                  const active = scheduledStart === slot.start;
                  return (
                    <button
                      key={slot.start}
                      type="button"
                      onClick={() => patch({ scheduledStart: slot.start, terminHinweis: null })}
                      aria-pressed={active}
                      className={cn(
                        'rounded-xl border-2 py-2.5 text-sm font-medium tabular-nums transition-all duration-200',
                        'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/15',
                        active ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:border-primary/50',
                      )}
                    >
                      {slot.label}
                    </button>
                  );
                })}
            </div>
          )}
        </div>
      ) : null}

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
  staffBooking = false,
  savedAddresses,
}: {
  /** Buchung auf das eigene Kundenprofil — Kontaktfelder entfallen. */
  isAuthenticated: boolean;
  /** Angemeldet ohne Kundenprofil (Personal): Kontaktfelder gelten der Kundschaft. */
  staffBooking?: boolean;
  savedAddresses: SavedAddressDto[];
}) {
  const state = useBookingStore();
  const patch = useBookingStore((s) => s.patch);

  const [manualAddress, setManualAddress] = React.useState(savedAddresses.length === 0);

  return (
    <div className="space-y-10">
      {staffBooking ? (
        <Alert variant="info" title="Sie sind als Personal angemeldet">
          Die Buchung wird für die hier angegebene Kundschaft angelegt. Gibt es unter der
          E-Mail-Adresse bereits einen Kundendatensatz, wird er verwendet — sonst entsteht ein
          neuer.
        </Alert>
      ) : null}

      {!isAuthenticated ? (
        <fieldset className="space-y-6">
          <legend className="mb-1 font-display text-lg font-semibold tracking-tight">
            {staffBooking ? 'Für wen buchen Sie?' : 'Wie erreichen wir Sie?'}
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

export function StepSummary({
  services,
  coupon,
  couponChecking,
}: {
  services: BookingService[];
  /** Prüfergebnis des Servers zum eingegebenen Code — `null`, solange keiner eingegeben ist. */
  coupon: CouponCheckDto | null;
  /** Läuft gerade eine Preisabfrage? Dann ist `coupon` womöglich noch der alte Stand. */
  couponChecking: boolean;
}) {
  const state = useBookingStore();
  const patch = useBookingStore((s) => s.patch);
  const gewaehlt = state.auswahl
    .map((l) => services.find((item) => item.id === l.id))
    .filter((service): service is BookingService => Boolean(service));

  // Der Gutschein ist freiwillig: ohne Eingabe gibt es weder Badge noch
  // Hinweis. Mit Eingabe zeigt das Feld genau den Zustand, den der Server
  // gemeldet hat — die Antwort gehört zum eingegebenen Code, sonst wäre sie
  // während des Nachladens der Stand des vorherigen Codes.
  const enteredCode = state.couponCode.trim();
  const verdict = enteredCode && coupon?.code === enteredCode ? coupon : null;
  const pending = enteredCode.length > 0 && (couponChecking || !verdict);

  const address = state.addressId
    ? 'Gespeicherte Adresse'
    : `${state.street} ${state.streetNo}, ${state.postalCode} ${state.city}`.replace(/\s+/g, ' ').trim();

  const selectedExtras = gewaehlt.flatMap((service) =>
    Object.entries(state.extras[service.id] ?? {})
      .map(([extraId, quantity]) => {
        const extra = service.extras.find((item) => item.id === extraId);
        if (!extra) return null;
        return gewaehlt.length > 1 ? `${quantity}× ${extra.name} (${service.name})` : `${quantity}× ${extra.name}`;
      })
      .filter((text): text is string => Boolean(text)),
  );

  return (
    <div className="space-y-8">
      <dl className="protocol-list rounded-2xl border border-border bg-card px-6">
        <div className="protocol-row">
          <dt className="protocol-label">{gewaehlt.length > 1 ? 'Leistungen' : 'Leistung'}</dt>
          <dd className="protocol-value">
            {gewaehlt.length ? (
              <ul className="space-y-0.5">
                {gewaehlt.map((service) => (
                  <li key={service.id}>{service.name}</li>
                ))}
              </ul>
            ) : (
              '—'
            )}
          </dd>
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
        <Label htmlFor="coupon">Gutscheincode (optional)</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="coupon"
            value={state.couponCode}
            onChange={(event) => patch({ couponCode: event.target.value.toUpperCase() })}
            placeholder="z. B. WILLKOMMEN20"
            className="max-w-xs"
            aria-describedby={enteredCode ? 'coupon-status' : undefined}
            aria-invalid={verdict ? verdict.status !== 'APPLIED' : undefined}
          />
          {pending ? (
            <Badge variant="neutral">
              <Loader2 className="size-3 animate-spin" aria-hidden />
              Wird geprüft
            </Badge>
          ) : verdict?.status === 'APPLIED' ? (
            <Badge variant="success">
              <Check className="size-3" strokeWidth={3} aria-hidden />
              Eingelöst · −{formatCurrency(verdict.amount)}
            </Badge>
          ) : verdict ? (
            <Badge variant="destructive">Nicht anwendbar</Badge>
          ) : null}
        </div>
        {enteredCode ? (
          <p
            id="coupon-status"
            role="status"
            className={cn(
              'text-meta',
              verdict && verdict.status !== 'APPLIED' ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {pending
              ? 'Der Code wird mit Ihrer Buchung abgeglichen.'
              : verdict?.status === 'APPLIED'
                ? verdict.message
                : `${verdict?.message ?? ''} Korrigieren Sie den Code oder leeren Sie das Feld.`}
          </p>
        ) : null}
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
