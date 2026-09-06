'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';

import { formatCurrency, round2 } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import { createExpenseSchema, type CreateExpenseInput } from '@/lib/validation/finance';
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
  DialogTrigger,
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

/**
 * Ausgabe erfassen.
 *
 * Eingegeben wird der Nettobetrag; MWST und Brutto rechnet das Formular live
 * mit. Schweizer Belege weisen meist beides aus — die Vorschau zeigt sofort,
 * ob die Zahlen zum Beleg passen.
 */
const CATEGORIES = [
  { value: 'MATERIAL', label: 'Material' },
  { value: 'EQUIPMENT', label: 'Geräte' },
  { value: 'VEHICLE', label: 'Fahrzeuge' },
  { value: 'FUEL', label: 'Treibstoff' },
  { value: 'INSURANCE', label: 'Versicherungen' },
  { value: 'RENT', label: 'Miete' },
  { value: 'SALARY', label: 'Löhne' },
  { value: 'SOCIAL_SECURITY', label: 'Sozialversicherungen' },
  { value: 'MARKETING', label: 'Marketing' },
  { value: 'SOFTWARE', label: 'Software' },
  { value: 'TRAINING', label: 'Weiterbildung' },
  { value: 'TAXES', label: 'Steuern' },
  { value: 'OTHER', label: 'Übriges' },
] as const;

export function ExpenseDialog({ suppliers }: { suppliers: { id: string; name: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const form = useForm<CreateExpenseInput>({
    resolver: zodResolver(createExpenseSchema),
    defaultValues: {
      category: 'MATERIAL',
      description: '',
      reference: '',
      expenseDate: new Date().toISOString().slice(0, 10) as unknown as Date,
      netAmount: 0,
      vatRate: 8.1,
      paid: false,
      vatDeductible: true,
      notes: '',
      fileIds: [],
    } as never,
  });

  const netAmount = Number(form.watch('netAmount')) || 0;
  const vatRate = Number(form.watch('vatRate')) || 0;
  const vatAmount = round2(netAmount * (vatRate / 100));
  const grossAmount = round2(netAmount + vatAmount);

  const onSubmit = async (values: CreateExpenseInput) => {
    setError(null);
    try {
      await api.post('/api/expenses', values);
      toast.success('Ausgabe erfasst.');
      form.reset();
      setOpen(false);
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Die Ausgabe konnte nicht gespeichert werden.';
      setError(message);
      toast.error(message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus aria-hidden />
          Ausgabe erfassen
        </Button>
      </DialogTrigger>

      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Ausgabe erfassen</DialogTitle>
          <DialogDescription>
            Geben Sie den Nettobetrag ein — MWST und Bruttobetrag berechnen wir mit.
          </DialogDescription>
        </DialogHeader>

        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" noValidate>
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Beschreibung</FormLabel>
                  <FormControl>
                    <Input placeholder="z. B. Reinigungsmittel Grundsortiment" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Kategorie</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {CATEGORIES.map((category) => (
                          <SelectItem key={category.value} value={category.value}>
                            {category.label}
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
                name="expenseDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Belegdatum</FormLabel>
                    <FormControl>
                      <Input
                        type="date"
                        value={String(field.value ?? '').slice(0, 10)}
                        onChange={(event) => field.onChange(event.target.value)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="supplierId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Lieferant</FormLabel>
                    <Select
                      value={field.value ?? 'none'}
                      onValueChange={(value) => field.onChange(value === 'none' ? undefined : value)}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Optional" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="none">Kein Lieferant</SelectItem>
                        {suppliers.map((supplier) => (
                          <SelectItem key={supplier.id} value={supplier.id}>
                            {supplier.name}
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
                name="reference"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Belegnummer</FormLabel>
                    <FormControl>
                      <Input {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="netAmount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Betrag netto</FormLabel>
                    <FormControl>
                      <Input
                        inputMode="decimal"
                        suffix="CHF"
                        {...field}
                        onChange={(event) =>
                          field.onChange(Number(event.target.value.replace(',', '.')) || 0)
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="vatRate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>MWST-Satz</FormLabel>
                    <FormControl>
                      <Input
                        inputMode="decimal"
                        suffix="%"
                        {...field}
                        onChange={(event) =>
                          field.onChange(Number(event.target.value.replace(',', '.')) || 0)
                        }
                      />
                    </FormControl>
                    <FormDescription>Normalsatz 8.1 %, reduziert 2.6 %.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Live-Vorschau */}
            <dl className="protocol-list rounded-xl bg-muted/50 px-4">
              <div className="flex items-baseline justify-between gap-4 py-2.5">
                <dt className="text-sm text-muted-foreground">MWST</dt>
                <dd className="text-sm tabular-nums">{formatCurrency(vatAmount)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-2.5">
                <dt className="text-sm font-medium">Bruttobetrag</dt>
                <dd className="font-semibold tabular-nums">{formatCurrency(grossAmount)}</dd>
              </div>
            </dl>

            <div className="space-y-3">
              <FormField
                control={form.control}
                name="paid"
                render={({ field }) => (
                  <FormItem>
                    <label className="flex cursor-pointer items-center gap-2.5 text-sm">
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={(checked) => field.onChange(checked === true)}
                      />
                      Bereits bezahlt
                    </label>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="vatDeductible"
                render={({ field }) => (
                  <FormItem>
                    <label className="flex cursor-pointer items-center gap-2.5 text-sm">
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={(checked) => field.onChange(checked === true)}
                      />
                      Vorsteuer abziehbar
                    </label>
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notiz</FormLabel>
                  <FormControl>
                    <Textarea rows={2} {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Abbrechen
              </Button>
              <Button type="submit" loading={form.formState.isSubmitting}>
                Ausgabe speichern
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
