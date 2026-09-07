'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Home, MapPin, Pencil, Plus, Receipt, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { createAddressSchema, type CreateAddressInput } from '@/lib/validation/crm';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/primitives';
import { EmptyState } from '@/components/app/page-parts';
import { Checkbox } from '@/components/ui/controls';
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

/**
 * Adressen anlegen, ändern und entfernen — dieselbe Maske im Büro und im
 * Kundenkonto.
 *
 * Eine Komponente für beide Seiten, weil es dieselbe Sache ist. Was sich
 * unterscheidet, ist der Ton: Das Büro liest „Kundschaft", die Kundschaft
 * liest „Sie". Das steckt in `audience` und sonst nirgends.
 *
 * Gestaltungsentscheide:
 *
 *  • **Die Standardadresse trägt ein Abzeichen, kein abwählbares Häkchen.**
 *    Es gibt immer genau eine; man kann sie weitergeben, nicht abschaffen.
 *    Ein Häkchen zum Entfernen würde etwas anbieten, das der Server zu Recht
 *    ablehnt.
 *
 *  • **Wo Einsätze hängen, fehlt der Löschknopf.** Nicht ausgegraut — er ist
 *    gar nicht da, und daneben steht, warum. Die Adresse belegt, wohin damals
 *    gefahren wurde.
 *
 *  • **Die Fehlermeldung des Servers steht im Dialog, nicht als flüchtige
 *    Einblendung.** „An dieser Adresse hängen noch zwei Einsätze" ist die
 *    Information, die weiterhilft, und sie soll stehen bleiben, bis man sie
 *    gelesen hat.
 */

export interface AddressRow {
  id: string;
  label: string | null;
  street: string;
  streetNo: string | null;
  addition: string | null;
  postalCode: string;
  city: string;
  canton: string;
  country: string;
  accessNote: string | null;
  isDefault: boolean;
  isBilling: boolean;
  usage: number;
}

interface Props {
  customerId: string;
  addresses: AddressRow[];
  /** Steuert nur die Anrede in den Texten. */
  audience: 'staff' | 'self';
  canEdit: boolean;
}

const EMPTY: CreateAddressInput = {
  label: '',
  street: '',
  streetNo: '',
  addition: '',
  postalCode: '',
  city: '',
  canton: 'BE',
  country: 'CH',
  accessNote: '',
  isBilling: false,
  isDefault: false,
};

export function AddressManager({ customerId, addresses, audience, canEdit }: Props) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<AddressRow | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [removing, setRemoving] = React.useState<AddressRow | null>(null);

  const self = audience === 'self';

  return (
    <div className="space-y-4">
      {addresses.length === 0 ? (
        <EmptyState
          icon={<MapPin aria-hidden />}
          title="Noch keine Adresse hinterlegt"
          description={
            self
              ? 'Ohne Adresse können wir keinen Termin planen. Tragen Sie sie einmal ein — danach genügen zwei Klicks für jede Buchung.'
              : 'Ohne Adresse lässt sich für diese Kundschaft kein Termin planen.'
          }
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {addresses.map((address) => (
            <li
              key={address.id}
              className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-soft"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/8 text-primary">
                    <Home className="size-4" aria-hidden />
                  </span>
                  <div className="min-w-0 text-sm">
                    {address.label ? (
                      <p className="truncate font-medium">{address.label}</p>
                    ) : null}
                    <p className={address.label ? 'text-muted-foreground' : 'font-medium'}>
                      {address.street} {address.streetNo}
                    </p>
                    {address.addition ? (
                      <p className="text-muted-foreground">{address.addition}</p>
                    ) : null}
                    <p className="text-muted-foreground">
                      {address.postalCode} {address.city}
                      {address.country !== 'CH' ? ` · ${address.country}` : ''}
                    </p>
                  </div>
                </div>

                {canEdit ? (
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Adresse ${address.street} bearbeiten`}
                      onClick={() => setEditing(address)}
                    >
                      <Pencil aria-hidden />
                    </Button>
                    {address.usage === 0 && addresses.length > 1 ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Adresse ${address.street} entfernen`}
                        className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => setRemoving(address)}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {address.isDefault ? (
                  <Badge variant="default" size="sm">
                    Standard
                  </Badge>
                ) : null}
                {address.isBilling ? (
                  <Badge variant="neutral" size="sm">
                    <Receipt className="size-3" aria-hidden />
                    Rechnungen
                  </Badge>
                ) : null}
                {address.usage > 0 ? (
                  <span className="text-2xs text-muted-foreground">
                    {address.usage} {address.usage === 1 ? 'Eintrag' : 'Einträge'} verweisen
                    darauf — bleibt erhalten
                  </span>
                ) : null}
              </div>

              {address.accessNote ? (
                <p className="rounded-lg bg-muted/50 px-3 py-2 text-2xs leading-relaxed text-muted-foreground">
                  {address.accessNote}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canEdit ? (
        <Button variant="outline" onClick={() => setCreating(true)}>
          <Plus aria-hidden />
          Adresse hinzufügen
        </Button>
      ) : null}

      <AddressDialog
        customerId={customerId}
        address={editing}
        open={creating || editing !== null}
        isOnly={addresses.length <= 1}
        audience={audience}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={() => router.refresh()}
      />

      <RemoveDialog
        customerId={customerId}
        address={removing}
        onClose={() => setRemoving(null)}
        onRemoved={() => router.refresh()}
      />
    </div>
  );
}

function AddressDialog({
  customerId,
  address,
  open,
  isOnly,
  audience,
  onClose,
  onSaved,
}: {
  customerId: string;
  address: AddressRow | null;
  open: boolean;
  isOnly: boolean;
  audience: 'staff' | 'self';
  onClose: () => void;
  onSaved: () => void;
}) {
  const [error, setError] = React.useState<string | null>(null);

  const form = useForm<CreateAddressInput>({
    resolver: zodResolver(createAddressSchema),
    defaultValues: EMPTY,
  });

  React.useEffect(() => {
    if (!open) return;
    form.reset(
      address
        ? {
            label: address.label ?? '',
            street: address.street,
            streetNo: address.streetNo ?? '',
            addition: address.addition ?? '',
            postalCode: address.postalCode,
            city: address.city,
            canton: address.canton,
            country: address.country,
            accessNote: address.accessNote ?? '',
            isBilling: address.isBilling,
            isDefault: address.isDefault,
          }
        : EMPTY,
    );
    setError(null);
  }, [open, address, form]);

  const onSubmit = async (values: CreateAddressInput) => {
    setError(null);
    try {
      if (address) {
        await api.patch(`/api/customers/${customerId}/addresses/${address.id}`, values);
      } else {
        await api.post(`/api/customers/${customerId}/addresses`, values);
      }
      toast.success('Adresse gespeichert.');
      onClose();
      onSaved();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Speichern fehlgeschlagen.';
      setError(message);
    }
  };

  // Die Standardmarkierung der einzigen Adresse lässt sich nicht abwählen —
  // der Server lehnt es ab, und ein Häkchen dafür wäre ein leeres Versprechen.
  const defaultLocked = Boolean(address?.isDefault);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{address ? 'Adresse bearbeiten' : 'Neue Adresse'}</DialogTitle>
          <DialogDescription>
            {audience === 'self'
              ? 'Die Adresse erscheint auf Ihren Rechnungen und führt das Team zum Einsatz.'
              : 'Die Adresse erscheint auf Rechnungen und führt das Team zum Einsatz.'}
          </DialogDescription>
        </DialogHeader>

        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" noValidate>
            <FormField
              control={form.control}
              name="label"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Bezeichnung</FormLabel>
                  <FormControl>
                    <Input placeholder="Zuhause, Büro Bern …" {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormDescription>
                    Hilft beim Auseinanderhalten, wenn mehrere Adressen hinterlegt sind.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <FormField
                control={form.control}
                name="street"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Strasse</FormLabel>
                    <FormControl>
                      <Input autoComplete="address-line1" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="streetNo"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nummer</FormLabel>
                    <FormControl>
                      <Input {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="addition"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Zusatz</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="c/o, Stockwerk, Eingang B"
                      autoComplete="address-line2"
                      {...field}
                      value={field.value ?? ''}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)]">
              <FormField
                control={form.control}
                name="postalCode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>PLZ</FormLabel>
                    <FormControl>
                      <Input inputMode="numeric" autoComplete="postal-code" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="city"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Ort</FormLabel>
                    <FormControl>
                      <Input autoComplete="address-level2" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="canton"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Kanton</FormLabel>
                    <FormControl>
                      <Input maxLength={2} className="uppercase" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="accessNote"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Zugang</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={2}
                      placeholder="Schlüsseldepot beim Briefkasten, Parkplatz im Hof …"
                      {...field}
                      value={field.value ?? ''}
                    />
                  </FormControl>
                  <FormDescription>
                    Steht auf dem Einsatzrapport. Was das Team wissen muss, um hineinzukommen.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="space-y-3 rounded-xl border border-border p-4">
              <FormField
                control={form.control}
                name="isDefault"
                render={({ field }) => (
                  <FormItem className="flex items-start gap-3 space-y-0">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        disabled={defaultLocked || isOnly}
                      />
                    </FormControl>
                    <div className="space-y-1">
                      <FormLabel>Standardadresse</FormLabel>
                      <FormDescription>
                        {defaultLocked
                          ? 'Das ist bereits die Standardadresse. Sie wandert weiter, sobald eine andere sie übernimmt.'
                          : 'Wird bei einer neuen Buchung vorgeschlagen. Es gibt immer genau eine.'}
                      </FormDescription>
                    </div>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="isBilling"
                render={({ field }) => (
                  <FormItem className="flex items-start gap-3 space-y-0">
                    <FormControl>
                      <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                    <div className="space-y-1">
                      <FormLabel>Rechnungsanschrift</FormLabel>
                      <FormDescription>
                        Erscheint auf Rechnungen und Offerten — etwa die Adresse der Treuhand.
                      </FormDescription>
                    </div>
                  </FormItem>
                )}
              />
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                Abbrechen
              </Button>
              <Button type="submit" loading={form.formState.isSubmitting}>
                Speichern
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function RemoveDialog({
  customerId,
  address,
  onClose,
  onRemoved,
}: {
  customerId: string;
  address: AddressRow | null;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (address) setError(null);
  }, [address]);

  const confirm = async () => {
    if (!address) return;
    setBusy(true);
    setError(null);
    try {
      await api.delete(`/api/customers/${customerId}/addresses/${address.id}`);
      toast.success('Adresse entfernt.');
      onClose();
      onRemoved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Entfernen fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={address !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Adresse entfernen?</DialogTitle>
          <DialogDescription>
            {address ? `${address.street} ${address.streetNo ?? ''}, ${address.postalCode} ${address.city}` : ''}
            {' — '}
            das lässt sich nicht rückgängig machen. Adressen kennen keinen Papierkorb.
          </DialogDescription>
        </DialogHeader>

        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="destructive" onClick={confirm} loading={busy}>
            Entfernen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
