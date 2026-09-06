'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Save } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api/client';
import {
  createExtraSchema,
  PRICING_MODELS,
  slugify,
  type CreateExtraInput,
} from '@/lib/validation/catalog';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
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

import { describeError, PRICING_LABELS, toNumberInput } from './shared';

/**
 * Zusatzleistung anlegen und bearbeiten.
 *
 * Die Zuordnung zu Leistungen ist eine Mehrfachauswahl mit einem
 * ausdrücklichen Sonderfall: **keine Auswahl bedeutet „bei allen"**. Das ist
 * nicht selbsterklärend, deshalb steht es als Satz im Formular und nicht nur
 * in der Dokumentation — es ist die Voreinstellung, mit der die meisten
 * Zusätze angelegt werden.
 */
export interface ExtraRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string;
  price: number;
  pricingModel: string;
  durationMin: number;
  vatRate: number;
  active: boolean;
  position: number;
  serviceIds: string[];
}

const EMPTY: CreateExtraInput = {
  name: '',
  slug: '',
  description: undefined,
  icon: 'Plus',
  price: 0,
  pricingModel: 'FLAT',
  durationMin: 15,
  vatRate: 8.1,
  active: true,
  position: 0,
  serviceIds: [],
};

function toFormValues(extra: ExtraRow): CreateExtraInput {
  return {
    name: extra.name,
    slug: extra.slug,
    description: extra.description ?? undefined,
    icon: extra.icon,
    price: extra.price,
    pricingModel: extra.pricingModel as CreateExtraInput['pricingModel'],
    durationMin: extra.durationMin,
    vatRate: extra.vatRate,
    active: extra.active,
    position: extra.position,
    serviceIds: extra.serviceIds,
  };
}

export function ExtraForm({
  open,
  onOpenChange,
  extra,
  services,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  extra?: ExtraRow;
  services: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [slugTouched, setSlugTouched] = React.useState(false);

  const form = useForm<CreateExtraInput>({
    resolver: zodResolver(createExtraSchema),
    defaultValues: extra ? toFormValues(extra) : EMPTY,
  });

  React.useEffect(() => {
    if (!open) return;
    form.reset(extra ? toFormValues(extra) : EMPTY);
    setSlugTouched(Boolean(extra));
    setError(null);
  }, [open, extra, form]);

  const name = form.watch('name');
  const selected = form.watch('serviceIds') ?? [];

  React.useEffect(() => {
    if (slugTouched || extra) return;
    form.setValue('slug', slugify(name ?? ''), { shouldValidate: false });
  }, [name, slugTouched, extra, form]);

  const toggleService = (id: string, checked: boolean) => {
    const next = checked ? [...selected, id] : selected.filter((value) => value !== id);
    form.setValue('serviceIds', next, { shouldDirty: true });
  };

  const onSubmit = async (values: CreateExtraInput) => {
    setError(null);
    try {
      if (extra) {
        await api.patch(`/api/service-extras/${extra.id}`, values);
        toast.success(`„${values.name}" gespeichert.`);
      } else {
        await api.post('/api/service-extras', values);
        toast.success(`„${values.name}" angelegt.`);
      }
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      const message = describeError(err, 'Die Zusatzleistung konnte nicht gespeichert werden.');
      setError(message);
      toast.error(message);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[min(34rem,96vw)]">
        <SheetHeader>
          <SheetTitle>{extra ? extra.name : 'Neue Zusatzleistung'}</SheetTitle>
          <SheetDescription>
            Zusatzleistungen erscheinen im Buchungsassistenten als ankreuzbare Optionen.
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
                    <FormLabel required>Name</FormLabel>
                    <FormControl>
                      <Input placeholder="Backofenreinigung" {...field} />
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
                    <FormLabel required>Kurzname</FormLabel>
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
                      Technische Kennung, erscheint nicht auf der Website.
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
                    <FormLabel>Beschreibung</FormLabel>
                    <FormControl>
                      <Textarea rows={2} {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormDescription>
                      Steht als Erläuterung unter der Option. Ein Satz genügt.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="price"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel required>Preis</FormLabel>
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
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="pricingModel"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Modell</FormLabel>
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

                <FormField
                  control={form.control}
                  name="durationMin"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Zusatzdauer</FormLabel>
                      <FormControl>
                        <Input
                          inputMode="numeric"
                          suffix="Min."
                          value={field.value ?? ''}
                          onChange={(event) =>
                            field.onChange(toNumberInput(event.target.value) ?? 0)
                          }
                        />
                      </FormControl>
                      <FormDescription>Verlängert den Einsatz im Kalender.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="vatRate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Mehrwertsteuer</FormLabel>
                      <FormControl>
                        <Input
                          inputMode="decimal"
                          suffix="%"
                          value={field.value ?? ''}
                          onChange={(event) =>
                            field.onChange(toNumberInput(event.target.value) ?? 0)
                          }
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="icon"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Symbol</FormLabel>
                    <FormControl>
                      <Input placeholder="Plus" {...field} />
                    </FormControl>
                    <FormDescription>Name eines Lucide-Symbols.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Zuordnung */}
              <fieldset className="space-y-3 rounded-xl border border-border p-4">
                <legend className="px-1 text-sm font-medium">Angeboten bei</legend>
                <p className="text-meta leading-relaxed text-muted-foreground">
                  Ohne Auswahl wird die Zusatzleistung bei <strong>allen</strong> Leistungen
                  angeboten. Kreuzen Sie an, um sie auf einzelne zu beschränken.
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {services.map((service) => (
                    <label
                      key={service.id}
                      className="flex cursor-pointer items-center gap-2.5 text-sm"
                    >
                      <Checkbox
                        checked={selected.includes(service.id)}
                        onCheckedChange={(checked) => toggleService(service.id, checked === true)}
                      />
                      <span className="min-w-0 truncate">{service.name}</span>
                    </label>
                  ))}
                </div>
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
                      Aktiv — im Buchungsassistenten wählbar
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
                {extra ? 'Speichern' : 'Anlegen'}
              </Button>
            </SheetFooter>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  );
}
