'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Save } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api/client';
import {
  createCategorySchema,
  createCouponSchema,
  createTaxRateSchema,
  SERVICE_KINDS,
  slugify,
  type CreateCategoryInput,
  type CreateCouponInput,
  type CreateTaxRateInput,
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
} from '@/components/ui/form';

import { describeError, SERVICE_KIND_LABELS, toNumberInput } from './shared';

/**
 * Die drei kürzeren Katalogformulare: Kategorie, Steuersatz, Gutschein.
 *
 * Sie stehen zusammen in einer Datei, weil jedes davon aus einer Handvoll
 * Feldern besteht und einem Dialog genügt — ein Seitenpanel wie bei Leistung
 * und Preisregel wäre für vier Felder eine überdimensionierte Geste. Drei
 * eigene Dateien mit identischem Rahmen wären hier reine Verwaltung.
 */

// ---------------------------------------------------------------------------
//  Kategorie
// ---------------------------------------------------------------------------

export interface CategoryRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string;
  position: number;
  active: boolean;
}

const EMPTY_CATEGORY: CreateCategoryInput = {
  name: '',
  slug: '',
  description: undefined,
  icon: 'Sparkles',
  position: 0,
  active: true,
};

export function CategoryForm({
  open,
  onOpenChange,
  category,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  category?: CategoryRow;
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [slugTouched, setSlugTouched] = React.useState(false);

  const form = useForm<CreateCategoryInput>({
    resolver: zodResolver(createCategorySchema),
    defaultValues: EMPTY_CATEGORY,
  });

  React.useEffect(() => {
    if (!open) return;
    form.reset(
      category
        ? {
            name: category.name,
            slug: category.slug,
            description: category.description ?? undefined,
            icon: category.icon,
            position: category.position,
            active: category.active,
          }
        : EMPTY_CATEGORY,
    );
    setSlugTouched(Boolean(category));
    setError(null);
  }, [open, category, form]);

  const name = form.watch('name');
  React.useEffect(() => {
    if (slugTouched || category) return;
    form.setValue('slug', slugify(name ?? ''), { shouldValidate: false });
  }, [name, slugTouched, category, form]);

  const onSubmit = async (values: CreateCategoryInput) => {
    setError(null);
    try {
      if (category) {
        await api.patch(`/api/service-categories/${category.id}`, values);
      } else {
        await api.post('/api/service-categories', values);
      }
      toast.success(`Kategorie „${values.name}" gespeichert.`);
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      const message = describeError(err, 'Die Kategorie konnte nicht gespeichert werden.');
      setError(message);
      toast.error(message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{category ? category.name : 'Neue Kategorie'}</DialogTitle>
          <DialogDescription>
            Kategorien gruppieren die Leistungen auf der Übersichtsseite.
          </DialogDescription>
        </DialogHeader>

        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" noValidate>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Name</FormLabel>
                    <FormControl>
                      <Input placeholder="Privathaushalt" {...field} />
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
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Beschreibung</FormLabel>
                  <FormControl>
                    <Textarea rows={2} {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="icon"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Symbol</FormLabel>
                  <FormControl>
                    <Input placeholder="Sparkles" {...field} />
                  </FormControl>
                  <FormDescription>Name eines Lucide-Symbols.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

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
                    Aktiv
                  </label>
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Abbrechen
              </Button>
              <Button type="submit" loading={form.formState.isSubmitting}>
                <Save aria-hidden />
                Speichern
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
//  Steuersatz
// ---------------------------------------------------------------------------

export interface TaxRateRow {
  id: string;
  name: string;
  rate: number;
  isDefault: boolean;
  active: boolean;
}

const EMPTY_TAX: CreateTaxRateInput = {
  name: '',
  rate: 8.1,
  isDefault: false,
  active: true,
};

export function TaxRateForm({
  open,
  onOpenChange,
  taxRate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taxRate?: TaxRateRow;
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);

  const form = useForm<CreateTaxRateInput>({
    resolver: zodResolver(createTaxRateSchema),
    defaultValues: EMPTY_TAX,
  });

  React.useEffect(() => {
    if (!open) return;
    form.reset(
      taxRate
        ? {
            name: taxRate.name,
            rate: taxRate.rate,
            isDefault: taxRate.isDefault,
            active: taxRate.active,
          }
        : EMPTY_TAX,
    );
    setError(null);
  }, [open, taxRate, form]);

  const onSubmit = async (values: CreateTaxRateInput) => {
    setError(null);
    try {
      if (taxRate) {
        await api.patch(`/api/tax-rates/${taxRate.id}`, values);
      } else {
        await api.post('/api/tax-rates', values);
      }
      toast.success(`Steuersatz „${values.name}" gespeichert.`);
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      const message = describeError(err, 'Der Steuersatz konnte nicht gespeichert werden.');
      setError(message);
      toast.error(message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{taxRate ? taxRate.name : 'Neuer Steuersatz'}</DialogTitle>
          <DialogDescription>
            Seit dem 1. Januar 2024 gilt in der Schweiz der Normalsatz von 8.1 %, der reduzierte
            Satz von 2.6 % und der Beherbergungssatz von 3.8 %.
          </DialogDescription>
        </DialogHeader>

        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" noValidate>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Bezeichnung</FormLabel>
                    <FormControl>
                      <Input placeholder="Normalsatz" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="rate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Satz</FormLabel>
                    <FormControl>
                      <Input
                        inputMode="decimal"
                        suffix="%"
                        value={field.value ?? ''}
                        onChange={(event) => field.onChange(toNumberInput(event.target.value) ?? 0)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="isDefault"
              render={({ field }) => (
                <FormItem>
                  <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={(checked) => field.onChange(checked === true)}
                    />
                    <span className="space-y-1">
                      <span className="block font-medium">Als Standard verwenden</span>
                      <span className="block text-meta text-muted-foreground">
                        Der bisherige Standardsatz verliert diese Markierung.
                      </span>
                    </span>
                  </label>
                </FormItem>
              )}
            />

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
                    Aktiv
                  </label>
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Abbrechen
              </Button>
              <Button type="submit" loading={form.formState.isSubmitting}>
                <Save aria-hidden />
                Speichern
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
//  Gutschein
// ---------------------------------------------------------------------------

export interface CouponRow {
  id: string;
  code: string;
  description: string | null;
  discountType: string;
  discountValue: number;
  minOrderValue: number;
  maxDiscount: number | null;
  status: string;
  validFrom: string;
  validUntil: string | null;
  usageLimit: number | null;
  usageCount: number;
  perCustomerLimit: number;
  firstOrderOnly: boolean;
  serviceKinds: string[];
}

const EMPTY_COUPON: CreateCouponInput = {
  code: '',
  description: undefined,
  discountType: 'PERCENT',
  discountValue: 10,
  minOrderValue: 0,
  maxDiscount: null,
  status: 'ACTIVE',
  validFrom: new Date().toISOString().slice(0, 10),
  validUntil: undefined,
  usageLimit: null,
  perCustomerLimit: 1,
  firstOrderOnly: false,
  serviceKinds: [],
};

const COUPON_STATUS = [
  { value: 'ACTIVE', label: 'Aktiv' },
  { value: 'PAUSED', label: 'Pausiert' },
  { value: 'EXPIRED', label: 'Abgelaufen' },
  { value: 'DEPLETED', label: 'Aufgebraucht' },
] as const;

export function CouponForm({
  open,
  onOpenChange,
  coupon,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  coupon?: CouponRow;
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);

  const form = useForm<CreateCouponInput>({
    resolver: zodResolver(createCouponSchema),
    defaultValues: EMPTY_COUPON,
  });

  React.useEffect(() => {
    if (!open) return;
    form.reset(
      coupon
        ? {
            code: coupon.code,
            description: coupon.description ?? undefined,
            discountType: coupon.discountType as CreateCouponInput['discountType'],
            discountValue: coupon.discountValue,
            minOrderValue: coupon.minOrderValue,
            maxDiscount: coupon.maxDiscount,
            status: coupon.status as CreateCouponInput['status'],
            validFrom: coupon.validFrom.slice(0, 10),
            validUntil: coupon.validUntil?.slice(0, 10),
            usageLimit: coupon.usageLimit,
            perCustomerLimit: coupon.perCustomerLimit,
            firstOrderOnly: coupon.firstOrderOnly,
            serviceKinds: coupon.serviceKinds as CreateCouponInput['serviceKinds'],
          }
        : EMPTY_COUPON,
    );
    setError(null);
  }, [open, coupon, form]);

  const kinds = form.watch('serviceKinds') ?? [];
  const discountType = form.watch('discountType');

  const onSubmit = async (values: CreateCouponInput) => {
    setError(null);
    try {
      if (coupon) {
        await api.patch(`/api/coupons/${coupon.id}`, values);
      } else {
        await api.post('/api/coupons', values);
      }
      toast.success(`Gutschein ${values.code} gespeichert.`);
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      const message = describeError(err, 'Der Gutschein konnte nicht gespeichert werden.');
      setError(message);
      toast.error(message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{coupon ? coupon.code : 'Neuer Gutschein'}</DialogTitle>
          <DialogDescription>
            {coupon
              ? `${coupon.usageCount}× eingelöst. Der Zähler lässt sich nicht zurücksetzen.`
              : 'Der Code wird beim Buchen und im Kundenkonto akzeptiert.'}
          </DialogDescription>
        </DialogHeader>

        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" noValidate>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="code"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Code</FormLabel>
                    <FormControl>
                      <Input
                        className="font-mono uppercase"
                        placeholder="FRUEHLING26"
                        {...field}
                        onChange={(event) => field.onChange(event.target.value.toUpperCase())}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Status</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {COUPON_STATUS.map((status) => (
                          <SelectItem key={status.value} value={status.value}>
                            {status.label}
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
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Interne Notiz</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Frühlingsaktion, Flyer Bümpliz"
                      {...field}
                      value={field.value ?? ''}
                    />
                  </FormControl>
                  <FormDescription>Nur für das Team sichtbar.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="discountType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Rabattart</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="PERCENT">Prozentual</SelectItem>
                        <SelectItem value="FIXED">Fixbetrag</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="discountValue"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Rabatt</FormLabel>
                    <FormControl>
                      <Input
                        inputMode="decimal"
                        suffix={discountType === 'PERCENT' ? '%' : 'CHF'}
                        value={field.value ?? ''}
                        onChange={(event) => field.onChange(toNumberInput(event.target.value) ?? 0)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="minOrderValue"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Mindestauftragswert</FormLabel>
                    <FormControl>
                      <Input
                        inputMode="decimal"
                        suffix="CHF"
                        value={field.value ?? ''}
                        onChange={(event) => field.onChange(toNumberInput(event.target.value) ?? 0)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="maxDiscount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Höchstrabatt</FormLabel>
                    <FormControl>
                      <Input
                        inputMode="decimal"
                        suffix="CHF"
                        value={field.value ?? ''}
                        onChange={(event) =>
                          field.onChange(toNumberInput(event.target.value) ?? null)
                        }
                      />
                    </FormControl>
                    <FormDescription>
                      Deckelt einen Prozentrabatt. Leer = keine Obergrenze.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="validFrom"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Gültig ab</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="validUntil"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Gültig bis</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormDescription>Leer = unbefristet.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="usageLimit"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Gesamtzahl Einlösungen</FormLabel>
                    <FormControl>
                      <Input
                        inputMode="numeric"
                        value={field.value ?? ''}
                        onChange={(event) =>
                          field.onChange(toNumberInput(event.target.value) ?? null)
                        }
                      />
                    </FormControl>
                    <FormDescription>Leer = unbegrenzt.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="perCustomerLimit"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Je Kundschaft</FormLabel>
                    <FormControl>
                      <Input
                        inputMode="numeric"
                        value={field.value ?? ''}
                        onChange={(event) => field.onChange(toNumberInput(event.target.value) ?? 1)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <fieldset className="space-y-3 rounded-xl border border-border p-4">
              <legend className="px-1 text-sm font-medium">Gilt für</legend>
              <p className="text-meta leading-relaxed text-muted-foreground">
                Ohne Auswahl gilt der Gutschein für <strong>alle</strong> Leistungen.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {SERVICE_KINDS.map((kind) => (
                  <label key={kind} className="flex cursor-pointer items-center gap-2.5 text-sm">
                    <Checkbox
                      checked={kinds.includes(kind)}
                      onCheckedChange={(checked) =>
                        form.setValue(
                          'serviceKinds',
                          checked === true
                            ? [...kinds, kind]
                            : kinds.filter((value) => value !== kind),
                          { shouldDirty: true },
                        )
                      }
                    />
                    {SERVICE_KIND_LABELS[kind]}
                  </label>
                ))}
              </div>
            </fieldset>

            <FormField
              control={form.control}
              name="firstOrderOnly"
              render={({ field }) => (
                <FormItem>
                  <label className="flex cursor-pointer items-center gap-2.5 text-sm">
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={(checked) => field.onChange(checked === true)}
                    />
                    Nur für Erstaufträge
                  </label>
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Abbrechen
              </Button>
              <Button type="submit" loading={form.formState.isSubmitting}>
                <Save aria-hidden />
                Speichern
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
