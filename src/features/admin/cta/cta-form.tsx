'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Save } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import {
  createCtaSchema,
  CTA_SLOTS,
  CTA_SLOT_HINTS,
  CTA_SLOT_LABELS,
  CTA_STYLE_LABELS,
  CTA_STYLES,
  type CreateCtaInput,
} from '@/lib/validation/cta';
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
import { CTA_ICON_NAMES, CtaButton, type CtaData } from '@/components/marketing/cta-button';

/**
 * Handlungsaufruf anlegen und bearbeiten.
 *
 * Gestaltungsentscheide:
 *
 *  • **Die Vorschau zeigt die echte Schaltfläche, nicht eine Nachbildung.**
 *    Sie rendert dasselbe Bauteil, das die Website rendert — dieselben
 *    Varianten, dasselbe Symbol, dieselben eigenen Farben. Eine nachgebaute
 *    Vorschau würde irgendwann von der Wirklichkeit abweichen, und niemand
 *    würde es merken, bis es jemand auf der Website sieht.
 *
 *  • **Der Platz erklärt sich in einem Satz.** „Kopfbereich, Hauptschaltfläche"
 *    sagt nichts darüber, dass es davon höchstens eine geben sollte. Der
 *    Hinweistext darunter schon.
 *
 *  • **Die Seitenliste ist ein Textfeld mit Mustern, keine Mehrfachauswahl.**
 *    Eine Auswahlliste müsste jede existierende Seite kennen und wäre bei
 *    einer neuen Leistungsseite sofort unvollständig. `/leistungen/*` bleibt
 *    richtig, auch wenn morgen eine Leistung dazukommt.
 */
export interface CtaRow {
  id: string;
  key: string;
  label: string;
  note: string | null;
  href: string;
  newTab: boolean;
  icon: string | null;
  slot: string;
  style: string;
  bgColor: string | null;
  fgColor: string | null;
  pages: string[];
  active: boolean;
  position: number;
  publishFrom: string | null;
  publishUntil: string | null;
  deletedAt: string | null;
}

const EMPTY: CreateCtaInput = {
  key: '',
  label: '',
  note: undefined,
  href: '/offerte',
  newTab: false,
  icon: undefined,
  slot: 'SECTION_BANNER',
  style: 'PRIMARY',
  bgColor: undefined,
  fgColor: undefined,
  pages: [],
  active: false,
  position: 0,
  publishFrom: undefined,
  publishUntil: undefined,
};

/** ISO-Zeitstempel in den Wert eines `datetime-local`-Feldes übersetzen. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toFormValues(cta: CtaRow): CreateCtaInput {
  return {
    key: cta.key,
    label: cta.label,
    note: cta.note ?? undefined,
    href: cta.href,
    newTab: cta.newTab,
    icon: cta.icon ?? undefined,
    slot: cta.slot as CreateCtaInput['slot'],
    style: cta.style as CreateCtaInput['style'],
    bgColor: cta.bgColor ?? undefined,
    fgColor: cta.fgColor ?? undefined,
    pages: cta.pages,
    active: cta.active,
    position: cta.position,
    publishFrom: toLocalInput(cta.publishFrom) || undefined,
    publishUntil: toLocalInput(cta.publishUntil) || undefined,
  };
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function CtaForm({
  open,
  onOpenChange,
  cta,
  canPublish,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cta?: CtaRow;
  canPublish: boolean;
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [keyTouched, setKeyTouched] = React.useState(false);

  const form = useForm<CreateCtaInput>({
    resolver: zodResolver(createCtaSchema),
    defaultValues: EMPTY,
  });

  React.useEffect(() => {
    if (!open) return;
    form.reset(cta ? toFormValues(cta) : EMPTY);
    setKeyTouched(Boolean(cta));
    setError(null);
  }, [open, cta, form]);

  const label = form.watch('label');
  React.useEffect(() => {
    if (keyTouched || cta) return;
    form.setValue('key', slugify(label ?? ''), { shouldValidate: false });
  }, [label, keyTouched, cta, form]);

  const values = form.watch();

  const preview: CtaData = {
    id: 'vorschau',
    key: values.key || 'vorschau',
    label: values.label || 'Beschriftung',
    href: values.href || '/',
    newTab: values.newTab ?? false,
    icon: values.icon ?? null,
    slot: values.slot ?? 'SECTION_BANNER',
    style: values.style ?? 'PRIMARY',
    bgColor: values.bgColor ?? null,
    fgColor: values.fgColor ?? null,
  };

  const onSubmit = async (input: CreateCtaInput) => {
    setError(null);
    try {
      if (cta) {
        await api.patch(`/api/cta/${cta.id}`, input);
        toast.success(`„${input.label}" gespeichert.`);
      } else {
        await api.post('/api/cta', input);
        toast.success(`„${input.label}" angelegt.`);
      }
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Der Handlungsaufruf konnte nicht gespeichert werden.';
      setError(message);
      toast.error(message);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[min(40rem,96vw)]">
        <SheetHeader>
          <SheetTitle>{cta ? cta.label : 'Neuer Handlungsaufruf'}</SheetTitle>
          <SheetDescription>
            Text, Farbe, Symbol, Ziel und Laufzeit — alles ohne Auslieferung änderbar.
          </SheetDescription>
        </SheetHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="contents" noValidate>
            <SheetBody className="space-y-6 py-6">
              {error ? <Alert variant="destructive">{error}</Alert> : null}

              {/* --- Vorschau ------------------------------------------------ */}
              <section
                className="space-y-3 rounded-2xl border border-border bg-muted/40 p-5"
                aria-label="Vorschau"
              >
                <p className="text-meta font-medium">So sieht sie aus</p>
                <div className="flex flex-wrap items-center gap-3">
                  <CtaButton cta={preview} />
                  <CtaButton cta={preview} size="sm" />
                </div>
                <p className="text-2xs leading-relaxed text-muted-foreground">
                  Dieselbe Schaltfläche wie auf der Website — dasselbe Bauteil, dieselben Farben.
                </p>
              </section>

              {/* --- Text und Ziel ------------------------------------------- */}
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="label"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel required>Beschriftung</FormLabel>
                      <FormControl>
                        <Input placeholder="Offerte anfordern" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="key"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel required>Kurzname</FormLabel>
                      <FormControl>
                        <Input
                          className="font-mono"
                          {...field}
                          onChange={(event) => {
                            setKeyTouched(true);
                            field.onChange(event);
                          }}
                        />
                      </FormControl>
                      <FormDescription>
                        Erscheint nicht öffentlich. Dient dem Wiederfinden und der Auswertung.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="href"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Ziel</FormLabel>
                    <FormControl>
                      <Input className="font-mono" placeholder="/offerte" {...field} />
                    </FormControl>
                    <FormDescription>
                      Interner Pfad (<code>/offerte</code>), <code>https://…</code>,{' '}
                      <code>tel:+41311234567</code> oder <code>mailto:info@…</code>.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

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
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* --- Aussehen ------------------------------------------------ */}
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="style"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Erscheinungsbild</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {CTA_STYLES.map((style) => (
                            <SelectItem key={style} value={style}>
                              {CTA_STYLE_LABELS[style]}
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

              {values.style === 'CUSTOM' ? (
                <div className="grid gap-4 rounded-xl border border-border p-4 sm:grid-cols-2">
                  <ColorField control={form.control} name="bgColor" label="Hintergrund" />
                  <ColorField control={form.control} name="fgColor" label="Schriftfarbe" />
                  <p className="text-meta leading-relaxed text-muted-foreground sm:col-span-2">
                    Achten Sie auf ausreichenden Kontrast — helle Schrift auf hellem Grund ist auf
                    einem Telefon im Sonnenlicht unlesbar.
                  </p>
                </div>
              ) : null}

              {/* --- Platzierung --------------------------------------------- */}
              <FormField
                control={form.control}
                name="slot"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Platz</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {CTA_SLOTS.map((slot) => (
                          <SelectItem key={slot} value={slot}>
                            {CTA_SLOT_LABELS[slot]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      {CTA_SLOT_HINTS[field.value as (typeof CTA_SLOTS)[number]]}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="pages"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Auf welchen Seiten</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={3}
                        className="font-mono text-sm"
                        placeholder={'/\n/leistungen/*\n/preise'}
                        value={(field.value ?? []).join('\n')}
                        onChange={(event) =>
                          field.onChange(
                            event.target.value
                              .split('\n')
                              .map((line) => line.trim())
                              .filter(Boolean),
                          )
                        }
                      />
                    </FormControl>
                    <FormDescription>
                      Eine Zeile je Seite. <code>/leistungen/*</code> deckt alle Leistungsseiten ab.{' '}
                      <strong>Leer = auf allen Seiten.</strong>
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* --- Laufzeit ------------------------------------------------ */}
              <div className="grid gap-4 rounded-xl border border-border p-4 sm:grid-cols-2">
                <p className="text-sm font-medium sm:col-span-2">Laufzeit</p>
                <FormField
                  control={form.control}
                  name="publishFrom"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Ab</FormLabel>
                      <FormControl>
                        <Input type="datetime-local" {...field} value={field.value ?? ''} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="publishUntil"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Bis</FormLabel>
                      <FormControl>
                        <Input type="datetime-local" {...field} value={field.value ?? ''} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <p className="text-meta leading-relaxed text-muted-foreground sm:col-span-2">
                  Beide leer = sofort und unbefristet. Ausserhalb des Fensters erscheint die
                  Schaltfläche nicht, bleibt aber gespeichert. Zeiten in Schweizer Ortszeit.
                </p>
              </div>

              <FormField
                control={form.control}
                name="note"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Interne Notiz</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Frühlingsaktion, läuft mit dem Flyer"
                        {...field}
                        value={field.value ?? ''}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="active"
                render={({ field }) => (
                  <FormItem>
                    <label
                      className={cn(
                        'flex items-start gap-3 rounded-xl border p-4 text-sm',
                        canPublish
                          ? 'cursor-pointer border-border'
                          : 'border-dashed border-border opacity-60',
                      )}
                    >
                      <Checkbox
                        checked={field.value}
                        disabled={!canPublish}
                        onCheckedChange={(checked) => field.onChange(checked === true)}
                      />
                      <span className="space-y-1">
                        <span className="block font-medium">Auf der Website anzeigen</span>
                        <span className="block text-meta leading-relaxed text-muted-foreground">
                          {canPublish
                            ? 'Wirkt sofort — die betroffenen Seiten werden neu erzeugt.'
                            : 'Ihnen fehlt die Berechtigung zum Veröffentlichen. Speichern können Sie trotzdem.'}
                        </span>
                      </span>
                    </label>
                    <FormMessage />
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
                {cta ? 'Speichern' : 'Anlegen'}
              </Button>
            </SheetFooter>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Farbwähler und Hexfeld nebeneinander — beide schreiben denselben Wert. */
function ColorField({ control, name, label }: { control: any; name: any; label: string }) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }: any) => (
        <FormItem>
          <FormLabel required>{label}</FormLabel>
          <div className="flex items-center gap-2">
            <input
              type="color"
              aria-label={`${label} wählen`}
              value={field.value || '#0B7285'}
              onChange={(event) => field.onChange(event.target.value.toUpperCase())}
              className="size-10 shrink-0 cursor-pointer rounded-lg border border-input bg-card p-1"
            />
            <FormControl>
              <Input
                className="font-mono"
                placeholder="#0B7285"
                value={field.value ?? ''}
                onChange={(event) => field.onChange(event.target.value.toUpperCase())}
              />
            </FormControl>
          </div>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/* eslint-enable @typescript-eslint/no-explicit-any */
