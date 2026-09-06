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
  createPriceRuleSchema,
  FREQUENCIES,
  PROPERTY_KINDS,
  type CreatePriceRuleInput,
} from '@/lib/validation/catalog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/primitives';
import {
  Checkbox,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/controls';
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
  FREQUENCY_LABELS,
  PROPERTY_KIND_LABELS,
  toNumberInput,
  WEEKDAY_LABELS,
} from './shared';

/**
 * Preisregel anlegen und bearbeiten.
 *
 * Die Bedingung wird als Formular geführt, nicht als JSON-Feld. Das ist die
 * eigentliche Arbeit dieses Bildschirms: `{"weekday":[0,6],"hourFrom":18}`
 * ist für die Engine die richtige Form und für einen Menschen die falsche.
 * Ein Tippfehler im Schlüssel — „weekdays" statt „weekday" — liesse die Regel
 * *immer* greifen, weil eine leere Bedingung auf alles passt. Genau deshalb
 * gibt es hier Ankreuzfelder und kein Textfeld.
 *
 * Der Satz unter dem Formular beschreibt die Regel in Worten. Er ist die
 * Gegenprobe: wer ihn liest und stutzt, hat etwas falsch angekreuzt.
 */
export interface PriceRuleRow {
  id: string;
  name: string;
  serviceId: string | null;
  condition: Record<string, unknown>;
  multiplier: number;
  surcharge: number;
  priority: number;
  active: boolean;
}

const EMPTY: CreatePriceRuleInput = {
  name: '',
  serviceId: null,
  condition: {},
  multiplier: 1,
  surcharge: 0,
  priority: 0,
  active: true,
};

function toFormValues(rule: PriceRuleRow): CreatePriceRuleInput {
  return {
    name: rule.name,
    serviceId: rule.serviceId,
    condition: (rule.condition ?? {}) as CreatePriceRuleInput['condition'],
    multiplier: rule.multiplier,
    surcharge: rule.surcharge,
    priority: rule.priority,
    active: rule.active,
  };
}

type Condition = CreatePriceRuleInput['condition'];

export function PriceRuleForm({
  open,
  onOpenChange,
  rule,
  services,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rule?: PriceRuleRow;
  services: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);

  const form = useForm<CreatePriceRuleInput>({
    resolver: zodResolver(createPriceRuleSchema),
    defaultValues: rule ? toFormValues(rule) : EMPTY,
  });

  React.useEffect(() => {
    if (!open) return;
    form.reset(rule ? toFormValues(rule) : EMPTY);
    setError(null);
  }, [open, rule, form]);

  const condition = (form.watch('condition') ?? {}) as Condition;
  const multiplier = Number(form.watch('multiplier')) || 1;
  const surcharge = Number(form.watch('surcharge')) || 0;
  const serviceId = form.watch('serviceId');

  /** Ein Merkmal setzen — oder entfernen, sobald es leer wird. */
  const setCondition = (patch: Partial<Condition>) => {
    const next: Record<string, unknown> = { ...condition, ...patch };
    for (const [key, value] of Object.entries(next)) {
      const empty =
        value === undefined ||
        value === null ||
        value === '' ||
        (Array.isArray(value) && value.length === 0);
      if (empty) delete next[key];
    }
    form.setValue('condition', next as Condition, { shouldDirty: true, shouldValidate: true });
  };

  const toggleIn = <T,>(list: T[] | undefined, value: T, checked: boolean): T[] =>
    checked ? [...(list ?? []), value] : (list ?? []).filter((item) => item !== value);

  const onSubmit = async (values: CreatePriceRuleInput) => {
    setError(null);
    try {
      if (rule) {
        await api.patch(`/api/price-rules/${rule.id}`, values);
        toast.success(`„${values.name}" gespeichert.`);
      } else {
        await api.post('/api/price-rules', values);
        toast.success(`„${values.name}" angelegt.`);
      }
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      const message = describeError(err, 'Die Preisregel konnte nicht gespeichert werden.');
      setError(message);
      toast.error(message);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[min(38rem,96vw)]">
        <SheetHeader>
          <SheetTitle>{rule ? rule.name : 'Neue Preisregel'}</SheetTitle>
          <SheetDescription>
            Regeln wirken auf die Summe aus Grundpreis und Zusatzleistungen — vor Rabatten und
            Mindestauftragswert.
          </SheetDescription>
        </SheetHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="contents" noValidate>
            <SheetBody className="space-y-6 py-6">
              {error ? <Alert variant="destructive">{error}</Alert> : null}

              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Bezeichnung</FormLabel>
                    <FormControl>
                      <Input placeholder="Wochenendzuschlag" {...field} />
                    </FormControl>
                    <FormDescription>
                      Erscheint als eigene Zeile auf Offerte und Rechnung — die Kundschaft liest
                      sie.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="serviceId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Gilt für</FormLabel>
                    <Select
                      value={field.value ?? 'all'}
                      onValueChange={(value) => field.onChange(value === 'all' ? null : value)}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="all">Alle Leistungen</SelectItem>
                        {services.map((service) => (
                          <SelectItem key={service.id} value={service.id}>
                            {service.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* --- Wirkung ------------------------------------------------ */}
              <fieldset className="space-y-4 rounded-xl border border-border p-4">
                <legend className="px-1 text-sm font-medium">Wirkung</legend>

                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="multiplier"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Faktor</FormLabel>
                        <FormControl>
                          <Input
                            inputMode="decimal"
                            value={field.value ?? ''}
                            onChange={(event) =>
                              field.onChange(toNumberInput(event.target.value) ?? 1)
                            }
                          />
                        </FormControl>
                        <FormDescription>
                          1.25 = +25 %, 0.9 = −10 %, 1 = keine Wirkung.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="surcharge"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Fixbetrag</FormLabel>
                        <FormControl>
                          <Input
                            inputMode="decimal"
                            suffix="CHF"
                            value={field.value ?? ''}
                            onChange={(event) =>
                              field.onChange(toNumberInput(event.target.value) ?? 0)
                            }
                          />
                        </FormControl>
                        <FormDescription>Negativ für einen Abschlag.</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="priority"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Reihenfolge</FormLabel>
                      <FormControl>
                        <Input
                          inputMode="numeric"
                          value={field.value ?? ''}
                          onChange={(event) =>
                            field.onChange(toNumberInput(event.target.value) ?? 0)
                          }
                        />
                      </FormControl>
                      <FormDescription>
                        Kleinere Zahl greift zuerst. Nur wichtig, wenn mehrere Regeln zugleich
                        zutreffen.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <RuleSentence
                  multiplier={multiplier}
                  surcharge={surcharge}
                  condition={condition}
                  serviceName={services.find((s) => s.id === serviceId)?.name}
                />
              </fieldset>

              {/* --- Bedingung ---------------------------------------------- */}
              <fieldset className="space-y-5 rounded-xl border border-border p-4">
                <legend className="px-1 text-sm font-medium">Wann sie greift</legend>
                <p className="text-meta leading-relaxed text-muted-foreground">
                  Ohne jede Angabe greift die Regel bei <strong>jedem</strong> Auftrag. Alle
                  gesetzten Merkmale müssen zugleich zutreffen.
                </p>

                <div className="space-y-2">
                  <span className="text-sm font-medium">Wochentag</span>
                  <div className="flex flex-wrap gap-3">
                    {WEEKDAY_LABELS.map((label, index) => (
                      <label key={label} className="flex cursor-pointer items-center gap-2 text-sm">
                        <Checkbox
                          checked={(condition.weekday ?? []).includes(index)}
                          onCheckedChange={(checked) =>
                            setCondition({
                              weekday: toggleIn(condition.weekday, index, checked === true),
                            })
                          }
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <label htmlFor="rule-hour-from" className="text-sm font-medium">
                      Ab Uhrzeit
                    </label>
                    <Input
                      id="rule-hour-from"
                      inputMode="numeric"
                      suffix="Uhr"
                      value={condition.hourFrom ?? ''}
                      onChange={(event) =>
                        setCondition({ hourFrom: toNumberInput(event.target.value) })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="rule-hour-to" className="text-sm font-medium">
                      Bis Uhrzeit
                    </label>
                    <Input
                      id="rule-hour-to"
                      inputMode="numeric"
                      suffix="Uhr"
                      value={condition.hourTo ?? ''}
                      onChange={(event) =>
                        setCondition({ hourTo: toNumberInput(event.target.value) })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="rule-min-sqm" className="text-sm font-medium">
                      Ab Fläche
                    </label>
                    <Input
                      id="rule-min-sqm"
                      inputMode="numeric"
                      suffix="m²"
                      value={condition.minSqm ?? ''}
                      onChange={(event) =>
                        setCondition({ minSqm: toNumberInput(event.target.value) })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="rule-max-sqm" className="text-sm font-medium">
                      Bis Fläche
                    </label>
                    <Input
                      id="rule-max-sqm"
                      inputMode="numeric"
                      suffix="m²"
                      value={condition.maxSqm ?? ''}
                      onChange={(event) =>
                        setCondition({ maxSqm: toNumberInput(event.target.value) })
                      }
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <span className="text-sm font-medium">Rhythmus</span>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {FREQUENCIES.map((value) => (
                      <label key={value} className="flex cursor-pointer items-center gap-2 text-sm">
                        <Checkbox
                          checked={(condition.frequency ?? []).includes(value)}
                          onCheckedChange={(checked) =>
                            setCondition({
                              frequency: toggleIn(condition.frequency, value, checked === true),
                            })
                          }
                        />
                        {FREQUENCY_LABELS[value]}
                      </label>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <span className="text-sm font-medium">Objektart</span>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {PROPERTY_KINDS.map((value) => (
                      <label key={value} className="flex cursor-pointer items-center gap-2 text-sm">
                        <Checkbox
                          checked={(condition.propertyKind ?? []).includes(value)}
                          onCheckedChange={(checked) =>
                            setCondition({
                              propertyKind: toggleIn(
                                condition.propertyKind,
                                value,
                                checked === true,
                              ),
                            })
                          }
                        />
                        {PROPERTY_KIND_LABELS[value]}
                      </label>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <span className="text-sm font-medium">Weitere Merkmale</span>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    <TriState
                      label="Haustiere"
                      value={condition.hasPets}
                      onChange={(value) => setCondition({ hasPets: value })}
                    />
                    <TriState
                      label="Express (innert 48 Std.)"
                      value={condition.urgent}
                      onChange={(value) => setCondition({ urgent: value })}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <label htmlFor="rule-postal" className="text-sm font-medium">
                    Postleitzahlen
                  </label>
                  <Input
                    id="rule-postal"
                    placeholder="3000, 3006, 3012"
                    value={(condition.postalCode ?? []).join(', ')}
                    onChange={(event) =>
                      setCondition({
                        postalCode: event.target.value
                          .split(',')
                          .map((code) => code.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                  <p className="text-meta text-muted-foreground">
                    Mit Komma trennen. Leer = alle Postleitzahlen im Einsatzgebiet.
                  </p>
                </div>

                <FormField
                  control={form.control}
                  name="condition"
                  render={() => (
                    <FormItem>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </fieldset>

              <FormField
                control={form.control}
                name="active"
                render={({ field }) => (
                  <FormItem>
                    <label className="flex cursor-pointer items-center gap-2.5 text-sm">
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={(checked) => field.onChange(checked === true)}
                      />
                      Aktiv — wird bei der Preisberechnung berücksichtigt
                    </label>
                  </FormItem>
                )}
              />
            </SheetBody>

            <SheetFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Abbrechen
              </Button>
              <Button type="submit" loading={form.formState.isSubmitting}>
                <Save aria-hidden />
                {rule ? 'Speichern' : 'Regel anlegen'}
              </Button>
            </SheetFooter>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Dreiwertiges Ankreuzfeld: egal / ja / nein.
 *
 * Ein gewöhnliches Kontrollkästchen kann „ist mir egal" nicht ausdrücken —
 * und genau das ist bei einer Bedingung der häufigste Fall. Ohne den dritten
 * Zustand liesse sich eine Regel nicht anlegen, die für Aufträge *mit und
 * ohne* Haustiere gilt.
 */
function TriState({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | undefined;
  onChange: (value: boolean | undefined) => void;
}) {
  const id = React.useId();
  return (
    <span className="flex items-center gap-2 text-sm">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="h-9 rounded-lg border border-input bg-card px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        value={value === undefined ? '' : value ? 'yes' : 'no'}
        onChange={(event) =>
          onChange(
            event.target.value === '' ? undefined : event.target.value === 'yes',
          )
        }
      >
        <option value="">egal</option>
        <option value="yes">ja</option>
        <option value="no">nein</option>
      </select>
    </span>
  );
}

/** Die Regel in einem Satz — die Gegenprobe zum Ankreuzen. */
function RuleSentence({
  multiplier,
  surcharge,
  condition,
  serviceName,
}: {
  multiplier: number;
  surcharge: number;
  condition: Condition;
  serviceName?: string;
}) {
  const effects: string[] = [];
  if (multiplier > 1) effects.push(`+${Math.round((multiplier - 1) * 1000) / 10} %`);
  if (multiplier < 1) effects.push(`−${Math.round((1 - multiplier) * 1000) / 10} %`);
  if (surcharge > 0) effects.push(`+ ${formatCurrency(surcharge)}`);
  if (surcharge < 0) effects.push(`− ${formatCurrency(Math.abs(surcharge))}`);

  const parts: string[] = [];
  if (condition.weekday?.length) {
    parts.push(`am ${condition.weekday.map((d) => WEEKDAY_LABELS[d]).join(', ')}`);
  }
  if (condition.hourFrom !== undefined || condition.hourTo !== undefined) {
    parts.push(
      `zwischen ${condition.hourFrom ?? 0} und ${condition.hourTo ?? 23} Uhr`,
    );
  }
  if (condition.minSqm !== undefined || condition.maxSqm !== undefined) {
    parts.push(`bei ${condition.minSqm ?? 0}–${condition.maxSqm ?? '∞'} m²`);
  }
  if (condition.frequency?.length) {
    parts.push(`bei ${condition.frequency.map((f) => FREQUENCY_LABELS[f]).join(' oder ')}`);
  }
  if (condition.propertyKind?.length) {
    parts.push(`für ${condition.propertyKind.map((p) => PROPERTY_KIND_LABELS[p]).join(' oder ')}`);
  }
  if (condition.hasPets !== undefined) {
    parts.push(condition.hasPets ? 'mit Haustieren' : 'ohne Haustiere');
  }
  if (condition.urgent !== undefined) {
    parts.push(condition.urgent ? 'bei Express-Terminen' : 'ausser bei Express-Terminen');
  }
  if (condition.postalCode?.length) {
    parts.push(`in ${condition.postalCode.join(', ')}`);
  }

  return (
    <p className="rounded-lg bg-muted/60 px-3 py-2.5 text-meta leading-relaxed">
      {effects.length === 0 ? (
        <span className="text-warning">
          Ohne Faktor und ohne Betrag hätte die Regel keine Wirkung.
        </span>
      ) : (
        <>
          <strong>{effects.join(' und ')}</strong> auf {serviceName ?? 'alle Leistungen'}
          {parts.length ? ` — ${parts.join(', ')}` : ' — bei jedem Auftrag'}.
        </>
      )}
    </p>
  );
}
