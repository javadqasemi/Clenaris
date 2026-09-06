'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Save } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import {
  createNavItemSchema,
  NAV_LOCATIONS,
  NAV_LOCATION_LABELS,
  type CreateNavItemInput,
} from '@/lib/validation/navigation';
import { CTA_ICON_NAMES } from '@/components/marketing/cta-button';
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
 * Menüpunkt anlegen und bearbeiten.
 *
 * Der übergeordnete Eintrag erscheint nur, wenn der Ort „Aufklappbereich"
 * gewählt ist — und dann ist er Pflicht. Ohne diese Kopplung entstünde ein
 * Punkt, der gespeichert wird und nirgends auftaucht: der häufigste Fehler
 * bei verschachtelten Menüs.
 */
export interface NavRow {
  id: string;
  location: string;
  label: string;
  href: string;
  description: string | null;
  icon: string | null;
  newTab: boolean;
  parentId: string | null;
  position: number;
  active: boolean;
}

const EMPTY: CreateNavItemInput = {
  location: 'HEADER',
  label: '',
  href: '/',
  description: undefined,
  icon: undefined,
  newTab: false,
  parentId: null,
  position: 0,
  active: true,
};

export function NavItemForm({
  open,
  onOpenChange,
  item,
  headerItems,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item?: NavRow;
  /** Kandidaten für den übergeordneten Eintrag. */
  headerItems: NavRow[];
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);

  const form = useForm<CreateNavItemInput>({
    resolver: zodResolver(createNavItemSchema),
    defaultValues: EMPTY,
  });

  React.useEffect(() => {
    if (!open) return;
    form.reset(
      item
        ? {
            location: item.location as CreateNavItemInput['location'],
            label: item.label,
            href: item.href,
            description: item.description ?? undefined,
            icon: item.icon ?? undefined,
            newTab: item.newTab,
            parentId: item.parentId,
            position: item.position,
            active: item.active,
          }
        : EMPTY,
    );
    setError(null);
  }, [open, item, form]);

  const location = form.watch('location');
  const isPanel = location === 'HEADER_PANEL';

  // Beim Wechsel weg vom Aufklappbereich den übergeordneten Eintrag lösen —
  // sonst bliebe ein Verweis stehen, den das Schema ablehnt.
  React.useEffect(() => {
    if (!isPanel) form.setValue('parentId', null);
  }, [isPanel, form]);

  const onSubmit = async (values: CreateNavItemInput) => {
    setError(null);
    try {
      if (item) await api.patch(`/api/navigation/${item.id}`, values);
      else await api.post('/api/navigation', values);
      toast.success('Menüpunkt gespeichert.');
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Speichern fehlgeschlagen.';
      setError(message);
      toast.error(message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{item ? 'Menüpunkt bearbeiten' : 'Neuer Menüpunkt'}</DialogTitle>
          <DialogDescription>
            Erscheint sofort im Menü — auf jeder Seite der Website.
          </DialogDescription>
        </DialogHeader>

        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" noValidate>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="label"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Beschriftung</FormLabel>
                    <FormControl>
                      <Input placeholder="Leistungen" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="location"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Ort</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {NAV_LOCATIONS.map((value) => (
                          <SelectItem key={value} value={value}>
                            {NAV_LOCATION_LABELS[value]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {isPanel ? (
              <FormField
                control={form.control}
                name="parentId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Unter welchem Eintrag</FormLabel>
                    <Select
                      value={field.value ?? ''}
                      onValueChange={(value) => field.onChange(value || null)}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Eintrag der Kopfzeile wählen" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {headerItems.map((candidate) => (
                          <SelectItem key={candidate.id} value={candidate.id}>
                            {candidate.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      Nur Einträge der obersten Kopfzeilenebene können einen Aufklappbereich
                      tragen.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : null}

            <FormField
              control={form.control}
              name="href"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Ziel</FormLabel>
                  <FormControl>
                    <Input className="font-mono" placeholder="/leistungen" {...field} />
                  </FormControl>
                  <FormDescription>
                    Interner Pfad, <code>https://…</code>, <code>tel:</code> oder{' '}
                    <code>mailto:</code>.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {isPanel ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Erläuterung</FormLabel>
                      <FormControl>
                        <Input {...field} value={field.value ?? ''} />
                      </FormControl>
                      <FormDescription>Zweite Zeile im Aufklappbereich.</FormDescription>
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
                      <Select
                        value={field.value ?? 'none'}
                        onValueChange={(value) => field.onChange(value === 'none' ? undefined : value)}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Ohne Symbol" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="none">Ohne Symbol</SelectItem>
                          {CTA_ICON_NAMES.map((name) => (
                            <SelectItem key={name} value={name}>
                              {name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            ) : null}

            <div className="space-y-3">
              <FormField
                control={form.control}
                name="newTab"
                render={({ field }) => (
                  <FormItem>
                    <label className="flex cursor-pointer items-center gap-2.5 text-sm">
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={(checked) => field.onChange(checked === true)}
                      />
                      In neuem Tab öffnen
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
                      Im Menü anzeigen
                    </label>
                  </FormItem>
                )}
              />
            </div>

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
