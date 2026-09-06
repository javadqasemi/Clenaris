'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, CheckCircle2, Loader2, MapPin, XCircle } from 'lucide-react';

import { formatCurrency, isValidSwissPostalCode } from '@/lib/utils';
import { api } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/form';

/**
 * Postleitzahl-Prüfung.
 *
 * Die häufigste Frage vor der Buchung ist „kommt ihr überhaupt zu mir?".
 * Diese eine Eingabe beantwortet sie in einer Sekunde und nennt gleich die
 * Anfahrtspauschale — beides senkt die Absprungrate deutlich.
 */
interface CheckResult {
  covered: boolean;
  city?: string;
  travelFee?: number;
  travelMinutes?: number;
}

export function PostalCodeCheck() {
  const [value, setValue] = React.useState('');
  const [result, setResult] = React.useState<CheckResult | null>(null);
  const [loading, setLoading] = React.useState(false);

  const check = async (postalCode: string) => {
    setLoading(true);
    try {
      const data = await api.get<CheckResult>('/api/public/service-areas/check', { postalCode });
      setResult(data);
    } catch {
      setResult({ covered: false });
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => {
    if (!isValidSwissPostalCode(value)) {
      setResult(null);
      return;
    }
    const timer = window.setTimeout(() => void check(value), 350);
    return () => window.clearTimeout(timer);
  }, [value]);

  return (
    <div className="rounded-2xl border border-border bg-card p-6 shadow-card sm:p-8">
      <div className="space-y-2">
        <Label htmlFor="plz-check" className="text-base">
          Kommen wir zu Ihnen?
        </Label>
        <p className="text-sm text-muted-foreground">
          Postleitzahl eingeben — Sie sehen sofort, ob Ihr Ort im Einsatzgebiet liegt.
        </p>
      </div>

      <div className="mt-4">
        <Input
          id="plz-check"
          inputMode="numeric"
          maxLength={4}
          value={value}
          onChange={(event) => setValue(event.target.value.replace(/\D/g, '').slice(0, 4))}
          placeholder="3011"
          startIcon={<MapPin />}
          endIcon={loading ? <Loader2 className="animate-spin" /> : undefined}
          className="text-lg"
          aria-describedby="plz-result"
        />
      </div>

      <div id="plz-result" aria-live="polite" className="mt-4">
        {result === null ? (
          <p className="text-sm text-muted-foreground">
            {value.length > 0 && value.length < 4
              ? 'Bitte vier Ziffern eingeben.'
              : 'Zum Beispiel 3011 für die Berner Innenstadt.'}
          </p>
        ) : result.covered ? (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-xl border border-success/25 bg-success/8 p-4">
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
              <div className="space-y-1 text-sm">
                <p className="font-medium text-success">
                  Ja, wir reinigen in {result.city}.
                </p>
                <p className="text-success/90">
                  {result.travelFee && result.travelFee > 0
                    ? `Anfahrtspauschale ${formatCurrency(result.travelFee)}`
                    : 'Die Anfahrt ist kostenlos.'}
                  {result.travelMinutes ? ` · ca. ${result.travelMinutes} Minuten ab Bern` : ''}
                </p>
              </div>
            </div>

            <Button asChild width="full" size="lg">
              <Link href={`/buchen?plz=${value}`}>
                Termin in {result.city} buchen
                <ArrowRight aria-hidden />
              </Link>
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-xl border border-warning/25 bg-warning/8 p-4">
              <XCircle className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
              <div className="space-y-1 text-sm">
                <p className="font-medium text-warning">
                  Diese Postleitzahl liegt ausserhalb unseres Standardgebiets.
                </p>
                <p className="text-warning/90">
                  Bei grösseren Objekten oder wiederkehrenden Aufträgen fahren wir trotzdem — fragen
                  Sie einfach an.
                </p>
              </div>
            </div>

            <Button asChild width="full" size="lg" variant="outline">
              <Link href="/kontakt">Anfrage stellen</Link>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
