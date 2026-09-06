'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/controls';
import { cn, formatCurrency, isValidSwissPostalCode } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';

/**
 * Sofort-Preisrechner im Hero.
 *
 * Architekturentscheid: Die Rechnung passiert *serverseitig*. Der Client
 * schickt die Eingaben und zeigt das Ergebnis — er kennt die Preislogik nicht.
 * Damit lässt sich der Preis nicht manipulieren, und Katalogänderungen wirken
 * sofort, ohne dass eine Client-Version nachgezogen werden muss.
 *
 * Die Anfrage ist entprellt (450 ms) und wird bei jeder Änderung neu gestellt,
 * damit die Zahl mitläuft, statt auf einen Klick zu warten.
 */

interface QuickEstimateService {
  slug: string;
  name: string;
  kind: string;
  pricingModel: string;
}

interface EstimateResponse {
  grossTotal: number;
  netTotal: number;
  durationMinutes: number;
  onRequest: boolean;
  notes: string[];
}

export function QuickEstimate({ services }: { services: QuickEstimateService[] }) {
  const router = useRouter();

  const [serviceSlug, setServiceSlug] = React.useState(services[0]?.slug ?? '');
  const [squareMeters, setSquareMeters] = React.useState('80');
  const [postalCode, setPostalCode] = React.useState('');
  const [estimate, setEstimate] = React.useState<EstimateResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [note, setNote] = React.useState<string | null>(null);

  const service = services.find((s) => s.slug === serviceSlug);
  const needsArea = service?.pricingModel !== 'ON_REQUEST';
  const onRequestOnly = service?.pricingModel === 'ON_REQUEST';

  React.useEffect(() => {
    if (!serviceSlug || onRequestOnly) {
      setEstimate(null);
      return;
    }

    const sqm = Number(squareMeters);
    if (!Number.isFinite(sqm) || sqm < 5) {
      setEstimate(null);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setNote(null);
      try {
        const result = await api.post<EstimateResponse>('/api/public/pricing/estimate', {
          serviceSlug,
          squareMeters: Math.round(sqm),
          postalCode: isValidSwissPostalCode(postalCode) ? postalCode : undefined,
          frequency: 'ONCE',
          propertyKind: 'APARTMENT',
          extras: [],
        });
        setEstimate(result);
        if (result.notes.length > 0) setNote(result.notes[0]);
      } catch (error) {
        setEstimate(null);
        setNote(
          error instanceof ApiError
            ? error.message
            : 'Der Preis lässt sich gerade nicht berechnen. Bitte versuchen Sie es erneut.',
        );
      } finally {
        setLoading(false);
      }
    }, 450);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [serviceSlug, squareMeters, postalCode, onRequestOnly]);

  const goToBooking = () => {
    const params = new URLSearchParams({ leistung: serviceSlug });
    if (needsArea && squareMeters) params.set('flaeche', squareMeters);
    if (isValidSwissPostalCode(postalCode)) params.set('plz', postalCode);
    router.push(`/buchen?${params.toString()}`);
  };

  return (
    <div className="rounded-2xl border border-border bg-card/85 p-5 shadow-card backdrop-blur-sm sm:p-6">
      <div className="grid gap-4 sm:grid-cols-[1.4fr_0.8fr_0.8fr]">
        <div className="space-y-2">
          <Label htmlFor="qe-service">Leistung</Label>
          <Select value={serviceSlug} onValueChange={setServiceSlug}>
            <SelectTrigger id="qe-service">
              <SelectValue placeholder="Leistung wählen" />
            </SelectTrigger>
            <SelectContent>
              {services.map((item) => (
                <SelectItem key={item.slug} value={item.slug}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="qe-area">Fläche</Label>
          <Input
            id="qe-area"
            inputMode="numeric"
            value={squareMeters}
            onChange={(event) => setSquareMeters(event.target.value.replace(/\D/g, '').slice(0, 4))}
            suffix="m²"
            disabled={onRequestOnly}
            aria-describedby="qe-result"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="qe-zip">Postleitzahl</Label>
          <Input
            id="qe-zip"
            inputMode="numeric"
            placeholder="3011"
            value={postalCode}
            onChange={(event) => setPostalCode(event.target.value.replace(/\D/g, '').slice(0, 4))}
            maxLength={4}
          />
        </div>
      </div>

      <div
        id="qe-result"
        aria-live="polite"
        className="mt-5 flex flex-col gap-4 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="min-w-0">
          {onRequestOnly ? (
            <p className="text-sm leading-relaxed text-muted-foreground">
              Diese Leistung offerieren wir individuell. Wir melden uns innert 24 Stunden.
            </p>
          ) : loading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Preis wird berechnet …
            </p>
          ) : estimate ? (
            <div className="space-y-1">
              <p className="flex items-baseline gap-2">
                <span className="font-display text-3xl font-bold tabular-nums tracking-tight">
                  {formatCurrency(estimate.grossTotal)}
                </span>
                <span className="text-sm text-muted-foreground">inkl. MWST</span>
              </p>
              <p className="text-sm text-muted-foreground">
                Rund {Math.round(estimate.durationMinutes / 60)} Stunden Einsatzzeit
                {note ? ` · ${note}` : ''}
              </p>
            </div>
          ) : (
            <p className={cn('text-sm', note ? 'text-destructive' : 'text-muted-foreground')}>
              {note ?? 'Fläche eingeben, um den Preis zu sehen.'}
            </p>
          )}
        </div>

        <Button size="lg" onClick={goToBooking} className="shrink-0">
          {onRequestOnly ? 'Offerte anfordern' : 'Termin wählen'}
          <ArrowRight aria-hidden />
        </Button>
      </div>
    </div>
  );
}
