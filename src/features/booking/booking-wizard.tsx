'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, ArrowRight, Check, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import { cn, formatCurrency, formatDuration } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import { trackEvent } from '@/components/marketing/analytics';

import { BOOKING_STEPS, useBookingStore, type Frequency, type PropertyKind } from './store';
import { useLivePrice } from './use-price';
import {
  StepContact,
  StepExtras,
  StepProperty,
  StepSchedule,
  StepService,
  StepSummary,
} from './steps';
import type {
  BookingService,
  PriceBreakdownDto,
  SavedAddressDto,
  SavedPropertyDto,
} from './types';

/**
 * Buchungsassistent.
 *
 * Architekturentscheide:
 *  • Sechs kurze Schritte statt eines langen Formulars. Jeder Schritt stellt
 *    genau eine Frage; das senkt die Abbruchrate spürbar.
 *  • Die Preiszusammenfassung ist auf dem Desktop eine Seitenspalte, auf dem
 *    Mobilgerät eine schwebende Leiste am unteren Rand — der Preis ist immer
 *    sichtbar, ohne den Fluss zu unterbrechen.
 *  • Der Fortschritt steht als `aria-current` und in einer Live-Region, damit
 *    Screenreader den Schrittwechsel mitbekommen.
 */

export function BookingWizard({
  services,
  isAuthenticated,
  savedAddresses,
  savedProperties,
  prefill,
}: {
  services: BookingService[];
  isAuthenticated: boolean;
  savedAddresses: SavedAddressDto[];
  savedProperties: SavedPropertyDto[];
  prefill?: { serviceSlug?: string; squareMeters?: number; postalCode?: string };
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const step = useBookingStore((s) => s.step);
  const patch = useBookingStore((s) => s.patch);
  const next = useBookingStore((s) => s.next);
  const back = useBookingStore((s) => s.back);
  const setStep = useBookingStore((s) => s.setStep);
  const canProceed = useBookingStore((s) => s.canProceed);
  const reset = useBookingStore((s) => s.reset);

  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const price = useLivePrice();
  const stepIndex = BOOKING_STEPS.findIndex((s) => s.key === step);
  const current = BOOKING_STEPS[stepIndex];

  // Vorbelegung aus dem Hero-Rechner übernehmen.
  React.useEffect(() => {
    const slug = prefill?.serviceSlug ?? searchParams.get('leistung') ?? undefined;
    const area = prefill?.squareMeters ?? (Number(searchParams.get('flaeche')) || undefined);
    const zip = prefill?.postalCode ?? searchParams.get('plz') ?? undefined;

    const service = slug ? services.find((item) => item.slug === slug) : undefined;

    patch({
      ...(service ? { serviceId: service.id, serviceSlug: service.slug } : {}),
      ...(area ? { squareMeters: area } : {}),
      ...(zip && /^[1-9]\d{3}$/.test(zip) ? { postalCode: zip } : {}),
    });
    // Nur beim ersten Rendern — spätere Eingaben dürfen nicht überschrieben werden.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [step]);

  const submit = async () => {
    const state = useBookingStore.getState();
    setSubmitting(true);
    setError(null);

    try {
      const result = await api.post<{ id: string; number: string; confirmationUrl: string }>(
        '/api/public/bookings',
        {
          serviceId: state.serviceId,
          extras: Object.entries(state.extras).map(([extraId, quantity]) => ({
            extraId,
            quantity,
          })),
          frequency: state.frequency,
          scheduledStart: state.scheduledStart,
          urgent: state.urgent,
          propertyKind: state.propertyKind,
          squareMeters: state.squareMeters,
          rooms: state.rooms,
          bathrooms: state.bathrooms,
          windows: state.windows,
          hasPets: state.hasPets,
          propertyId: state.propertyId,
          firstName: state.firstName || undefined,
          lastName: state.lastName || undefined,
          email: state.email || undefined,
          phone: state.phone || undefined,
          companyName: state.companyName || undefined,
          addressId: state.addressId,
          address: state.addressId
            ? undefined
            : {
                street: state.street,
                streetNo: state.streetNo || undefined,
                postalCode: state.postalCode,
                city: state.city,
                canton: 'BE',
                country: 'CH',
              },
          customerNote: state.customerNote || undefined,
          accessNote: state.accessNote || undefined,
          couponCode: state.couponCode || undefined,
          fileIds: state.fileIds,
          recurrence:
            state.frequency === 'ONCE'
              ? undefined
              : { interval: 1, weekdays: [], endDate: null, count: null },
          acceptTerms: true,
        },
      );

      trackEvent('booking_completed', {
        value: price.data?.grossTotal ?? 0,
        currency: 'CHF',
        service: state.serviceSlug ?? '',
      });

      reset();
      router.push(`/buchen/bestaetigt?nr=${encodeURIComponent(result.number)}`);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : 'Die Buchung konnte nicht abgeschlossen werden. Bitte versuchen Sie es erneut.';
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
      <div className="space-y-8">
        {/* Fortschritt */}
        <nav aria-label="Buchungsschritte">
          <ol className="flex flex-wrap items-center gap-x-2 gap-y-3">
            {BOOKING_STEPS.map((item, index) => {
              const done = index < stepIndex;
              const active = index === stepIndex;

              return (
                <li key={item.key} className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => (done ? setStep(item.key) : undefined)}
                    disabled={!done}
                    aria-current={active ? 'step' : undefined}
                    className={cn(
                      'flex items-center gap-2 rounded-lg px-2 py-1 text-sm transition-colors',
                      done && 'cursor-pointer hover:bg-muted',
                      active ? 'font-semibold text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    <span
                      className={cn(
                        'flex size-6 items-center justify-center rounded-full border-2 text-xs font-semibold tabular-nums transition-colors',
                        done && 'border-primary bg-primary text-primary-foreground',
                        active && 'border-primary text-primary',
                        !done && !active && 'border-border text-muted-foreground',
                      )}
                    >
                      {done ? <Check className="size-3.5" strokeWidth={3} aria-hidden /> : index + 1}
                    </span>
                    <span className="hidden sm:inline">{item.label}</span>
                  </button>
                  {index < BOOKING_STEPS.length - 1 ? (
                    <span className="h-px w-4 bg-border sm:w-6" aria-hidden />
                  ) : null}
                </li>
              );
            })}
          </ol>
        </nav>

        <header className="space-y-2">
          <h1 className="text-headline font-bold tracking-tight">{current.description}</h1>
          <p className="sr-only" aria-live="polite">
            Schritt {stepIndex + 1} von {BOOKING_STEPS.length}: {current.label}
          </p>
        </header>

        {error ? <Alert variant="destructive" title="Buchung fehlgeschlagen">{error}</Alert> : null}

        <div className="min-h-[24rem]">
          {step === 'leistung' ? <StepService services={services} /> : null}
          {step === 'objekt' ? (
            <StepProperty services={services} savedProperties={savedProperties} />
          ) : null}
          {step === 'extras' ? <StepExtras services={services} /> : null}
          {step === 'termin' ? <StepSchedule /> : null}
          {step === 'kontakt' ? (
            <StepContact isAuthenticated={isAuthenticated} savedAddresses={savedAddresses} />
          ) : null}
          {step === 'uebersicht' ? <StepSummary services={services} /> : null}
        </div>

        {/* Navigation (Desktop) */}
        <div className="hidden items-center justify-between gap-4 border-t border-border pt-6 lg:flex">
          <Button variant="ghost" onClick={back} disabled={stepIndex === 0}>
            <ArrowLeft aria-hidden />
            Zurück
          </Button>

          {step === 'uebersicht' ? (
            <Button size="lg" onClick={submit} loading={submitting} disabled={!canProceed()}>
              Kostenpflichtig buchen
            </Button>
          ) : (
            <Button size="lg" onClick={next} disabled={!canProceed()}>
              Weiter
              <ArrowRight aria-hidden />
            </Button>
          )}
        </div>
      </div>

      {/* Preiszusammenfassung */}
      <aside className="hidden lg:sticky lg:top-24 lg:block">
        <PriceSummary
          loading={price.isFetching}
          data={price.data}
          error={price.error instanceof ApiError ? price.error.message : null}
        />
      </aside>

      {/* Schwebende Leiste (Mobile) */}
      <div className="glass-panel fixed inset-x-0 bottom-0 z-40 border-t p-4 lg:hidden">
        <div className="mb-3 flex items-baseline justify-between gap-4">
          <div>
            <p className="text-xs text-muted-foreground">Geschätzter Preis</p>
            <p className="font-display text-xl font-bold tabular-nums">
              {price.data ? formatCurrency(price.data.grossTotal) : '—'}
            </p>
          </div>
          {price.isFetching ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
          ) : null}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={back} disabled={stepIndex === 0} size="lg">
            <ArrowLeft aria-hidden />
            <span className="sr-only">Zurück</span>
          </Button>
          {step === 'uebersicht' ? (
            <Button
              size="lg"
              width="full"
              onClick={submit}
              loading={submitting}
              disabled={!canProceed()}
            >
              Kostenpflichtig buchen
            </Button>
          ) : (
            <Button size="lg" width="full" onClick={next} disabled={!canProceed()}>
              Weiter
              <ArrowRight aria-hidden />
            </Button>
          )}
        </div>
      </div>

      {/* Platz für die schwebende Leiste */}
      <div className="h-28 lg:hidden" aria-hidden />
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Preiszusammenfassung
// ---------------------------------------------------------------------------

function PriceSummary({
  loading,
  data,
  error,
}: {
  loading: boolean;
  data?: PriceBreakdownDto;
  error: string | null;
}) {
  return (
    <div className="space-y-4 rounded-2xl border border-border bg-card p-6 shadow-card">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-base font-semibold">Ihre Buchung</h2>
        {loading ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
        ) : null}
      </div>

      {error ? (
        <p className="text-sm leading-relaxed text-destructive">{error}</p>
      ) : !data ? (
        <p className="text-sm leading-relaxed text-muted-foreground">
          Sobald Leistung und Fläche feststehen, sehen Sie hier den verbindlichen Preis.
        </p>
      ) : (
        <>
          <dl className="protocol-list text-sm">
            {data.lines.map((line) => (
              <div key={line.key} className="flex items-baseline justify-between gap-4 py-2.5">
                <dt
                  className={cn(
                    'min-w-0 flex-1',
                    line.kind === 'discount' ? 'text-success' : 'text-muted-foreground',
                  )}
                >
                  {line.label}
                </dt>
                <dd
                  className={cn(
                    'shrink-0 tabular-nums',
                    line.kind === 'discount' ? 'font-medium text-success' : 'text-foreground',
                  )}
                >
                  {formatCurrency(line.amount)}
                </dd>
              </div>
            ))}
          </dl>

          <div className="space-y-2 border-t border-border pt-4 text-sm">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-muted-foreground">Total netto</span>
              <span className="tabular-nums">{formatCurrency(data.netTotal)}</span>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-muted-foreground">MWST {data.vatRate.toFixed(1)} %</span>
              <span className="tabular-nums">{formatCurrency(data.vatAmount)}</span>
            </div>
            <div className="flex items-baseline justify-between gap-4 border-t border-border pt-3">
              <span className="font-semibold">Gesamtbetrag</span>
              <span className="font-display text-2xl font-bold tabular-nums">
                {formatCurrency(data.grossTotal)}
              </span>
            </div>
          </div>

          <div className="space-y-2 border-t border-border pt-4 text-meta text-muted-foreground">
            <p>
              Einsatzdauer ca. {formatDuration(data.durationMinutes)}
              {data.crewSize > 1 ? ` · ${data.crewSize} Personen` : ''}
            </p>
            {data.notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
        </>
      )}

      <div className="flex items-start gap-2.5 border-t border-border pt-4 text-meta leading-relaxed text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        Bis 24 Stunden vor dem Termin kostenlos stornieren. Sie zahlen erst nach dem Einsatz.
      </div>
    </div>
  );
}

export type { Frequency, PropertyKind };
