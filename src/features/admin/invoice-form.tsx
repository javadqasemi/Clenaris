'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { formatCurrency, round2 } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import { createInvoiceSchema, type CreateInvoiceInput } from '@/lib/validation/finance';
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
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { DetailSection } from '@/components/app/page-parts';

/**
 * Rechnung erstellen.
 *
 * Architekturentscheide:
 *  • Die Summen laufen live mit, damit man die Wirkung einer Änderung sofort
 *    sieht. Verbindlich ist trotzdem die Berechnung auf dem Server — der
 *    Browser ist keine Quelle für Beträge.
 *  • „Direkt ausstellen" ist standardmässig aus. Mit dem Ausstellen wird die
 *    Rechnungsnummer vergeben, und eine vergebene Nummer, die man nachher
 *    doch nicht braucht, reisst eine Lücke in die Folge — lückenlose
 *    Nummerierung verlangt Art. 957a OR.
 */
interface InvoiceFormCustomer {
  id: string;
  label: string;
  paymentTermDays: number;
}

interface UninvoicedJob {
  id: string;
  label: string;
  customerId: string;
  amount: number;
}

export function InvoiceForm({
  customers,
  jobs,
  defaultCustomerId,
}: {
  customers: InvoiceFormCustomer[];
  jobs: UninvoicedJob[];
  defaultCustomerId?: string;
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);

  const today = new Date().toISOString().slice(0, 10);

  const form = useForm<CreateInvoiceInput>({
    resolver: zodResolver(createInvoiceSchema),
    defaultValues: {
      customerId: defaultCustomerId ?? '',
      issueDate: today as unknown as Date,
      dueDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10) as unknown as Date,
      discountAmount: 0,
      issueImmediately: false,
      outroText: 'Vielen Dank für Ihr Vertrauen. Zahlbar innert der angegebenen Frist.',
      items: [
        { name: '', quantity: 1, unit: 'Std.', unitPrice: 0, discount: 0, vatRate: 8.1 },
      ],
    } as never,
  });

  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'items' });
  const items = form.watch('items');
  const customerId = form.watch('customerId');
  const discountAmount = Number(form.watch('discountAmount')) || 0;

  // Zahlungsfrist der Kundschaft übernehmen, sobald sie gewählt ist.
  React.useEffect(() => {
    const customer = customers.find((entry) => entry.id === customerId);
    if (!customer) return;
    const due = new Date(Date.now() + customer.paymentTermDays * 86_400_000);
    form.setValue('dueDate', due.toISOString().slice(0, 10) as unknown as Date);
  }, [customerId, customers, form]);

  const totals = React.useMemo(() => {
    const lines = (items ?? []).map((item) => {
      const net = round2(
        (Number(item?.quantity) || 0) *
          (Number(item?.unitPrice) || 0) *
          (1 - (Number(item?.discount) || 0) / 100),
      );
      return { net, vat: round2(net * ((Number(item?.vatRate) || 0) / 100)) };
    });

    const subtotal = round2(lines.reduce((sum, line) => sum + line.net, 0));
    const netTotal = round2(subtotal - discountAmount);
    // Der Rabatt mindert die MWST anteilig — sonst stimmt die Abrechnung nicht.
    const factor = subtotal > 0 ? netTotal / subtotal : 1;
    const vatAmount = round2(lines.reduce((sum, line) => sum + line.vat, 0) * factor);

    return { subtotal, netTotal, vatAmount, grossTotal: round2(netTotal + vatAmount) };
  }, [items, discountAmount]);

  const relevantJobs = jobs.filter((job) => !customerId || job.customerId === customerId);

  const addJob = (job: UninvoicedJob) => {
    append({
      jobId: job.id,
      name: job.label,
      quantity: 1,
      unit: 'Pauschal',
      unitPrice: job.amount,
      discount: 0,
      vatRate: 8.1,
    } as never);
  };

  const onSubmit = async (values: CreateInvoiceInput) => {
    setError(null);
    try {
      const result = await api.post<{ id: string; number: string }>('/api/invoices', values);
      toast.success(
        values.issueImmediately
          ? `Rechnung ${result.number} ausgestellt.`
          : 'Entwurf gespeichert.',
      );
      router.push(`/admin/rechnungen/${result.id}`);
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Die Rechnung konnte nicht erstellt werden.';
      setError(message);
      toast.error(message);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8" noValidate>
        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="space-y-6">
            <DetailSection title="Empfänger" body="form">

              <FormField
                control={form.control}
                name="customerId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Kundschaft</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Kundschaft wählen" />
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
                    <FormDescription>
                      Rechnungsadresse und Zahlungsfrist stammen aus der Kundenakte.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="issueDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Rechnungsdatum</FormLabel>
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
                  name="dueDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Fällig am</FormLabel>
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
              </div>
            </DetailSection>

            <DetailSection
              title="Positionen"
              body="form"
              action={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    append({
                      name: '',
                      quantity: 1,
                      unit: 'Std.',
                      unitPrice: 0,
                      discount: 0,
                      vatRate: 8.1,
                    } as never)
                  }
                >
                  <Plus aria-hidden />
                  Position
                </Button>
              }
            >

              <ol className="space-y-4">
                {fields.map((entry, index) => (
                  <li key={entry.id} className="space-y-3 rounded-xl border border-border p-4">
                    <div className="flex items-start gap-3">
                      <FormField
                        control={form.control}
                        name={`items.${index}.name`}
                        render={({ field }) => (
                          <FormItem className="flex-1">
                            <FormLabel required className="sr-only">
                              Bezeichnung
                            </FormLabel>
                            <FormControl>
                              <Input placeholder="Leistung" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Position ${index + 1} entfernen`}
                        disabled={fields.length === 1}
                        onClick={() => remove(index)}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-4">
                      <FormField
                        control={form.control}
                        name={`items.${index}.quantity`}
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Menge</FormLabel>
                            <FormControl>
                              <Input
                                type="number"
                                min={0.01}
                                step={0.25}
                                {...field}
                                onChange={(event) => field.onChange(Number(event.target.value))}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name={`items.${index}.unit`}
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Einheit</FormLabel>
                            <FormControl>
                              <Input {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name={`items.${index}.unitPrice`}
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Ansatz</FormLabel>
                            <FormControl>
                              <Input
                                type="number"
                                min={0}
                                step={0.05}
                                {...field}
                                onChange={(event) => field.onChange(Number(event.target.value))}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name={`items.${index}.vatRate`}
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>MWST %</FormLabel>
                            <Select
                              value={String(field.value)}
                              onValueChange={(value) => field.onChange(Number(value))}
                            >
                              <FormControl>
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="8.1">8.1 — Normalsatz</SelectItem>
                                <SelectItem value="2.6">2.6 — reduziert</SelectItem>
                                <SelectItem value="3.8">3.8 — Beherbergung</SelectItem>
                                <SelectItem value="0">0 — befreit</SelectItem>
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  </li>
                ))}
              </ol>

              {relevantJobs.length > 0 ? (
                <div className="space-y-2 border-t border-border pt-4">
                  <p className="text-sm font-medium">Nicht verrechnete Einsätze</p>
                  <ul className="flex flex-wrap gap-2">
                    {relevantJobs.map((job) => (
                      <li key={job.id}>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => addJob(job)}
                        >
                          <Plus aria-hidden />
                          {job.label} · {formatCurrency(job.amount)}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </DetailSection>

            <DetailSection title="Texte" body="form">

              <FormField
                control={form.control}
                name="introText"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Einleitung</FormLabel>
                    <FormControl>
                      <Textarea rows={2} {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="outroText"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Schlusstext</FormLabel>
                    <FormControl>
                      <Textarea rows={2} {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </DetailSection>
          </div>

          {/* Summenspalte */}
          <aside className="lg:sticky lg:top-24 lg:self-start">
            <div className="space-y-4 rounded-2xl border border-border bg-card p-5 shadow-soft">
              <h2 className="font-display text-base font-semibold tracking-tight">Total</h2>

              <FormField
                control={form.control}
                name="discountAmount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Rabatt (CHF)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        step={5}
                        {...field}
                        onChange={(event) => field.onChange(Number(event.target.value))}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <dl className="protocol-list text-sm">
                <div className="flex items-baseline justify-between gap-4 py-2">
                  <dt className="text-muted-foreground">Zwischentotal</dt>
                  <dd className="tabular-nums">{formatCurrency(totals.subtotal)}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-4 py-2">
                  <dt className="text-muted-foreground">Netto</dt>
                  <dd className="tabular-nums">{formatCurrency(totals.netTotal)}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-4 py-2">
                  <dt className="text-muted-foreground">MWST</dt>
                  <dd className="tabular-nums">{formatCurrency(totals.vatAmount)}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-4 py-2">
                  <dt className="font-medium">Total</dt>
                  <dd className="font-display text-lg font-bold tabular-nums">
                    {formatCurrency(totals.grossTotal)}
                  </dd>
                </div>
              </dl>

              <FormField
                control={form.control}
                name="issueImmediately"
                render={({ field }) => (
                  <FormItem className="flex items-start gap-3 space-y-0 border-t border-border pt-4">
                    <FormControl>
                      <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                    <div className="space-y-1">
                      <FormLabel className="font-normal">Direkt ausstellen</FormLabel>
                      <FormDescription>
                        Vergibt die Rechnungsnummer. Danach nur noch per Gutschrift korrigierbar.
                      </FormDescription>
                    </div>
                  </FormItem>
                )}
              />

              <Button type="submit" width="full" loading={form.formState.isSubmitting}>
                <Save aria-hidden />
                Rechnung speichern
              </Button>
            </div>
          </aside>
        </div>
      </form>
    </Form>
  );
}
