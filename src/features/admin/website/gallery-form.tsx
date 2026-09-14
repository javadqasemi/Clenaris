'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { FolderOpen, ImagePlus, Loader2, Save, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import { SERVICE_KINDS } from '@/lib/validation/catalog';
import { createGalleryItemSchema, type CreateGalleryItemInput } from '@/lib/validation/website';
import { SERVICE_KIND_LABELS } from '@/features/admin/catalog/shared';
import { ACCEPTED_IMAGE_TYPES, MediaPicker, uploadImage } from '@/features/admin/image-field';
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

/**
 * Galerieeintrag anlegen und bearbeiten.
 *
 * Die Vorschau zeigt beide Bilder nebeneinander — immer, auch leer. Das ist
 * die einzige Kontrolle, die zählt: ob es dasselbe Bild ist, ob eines nicht
 * lädt, ob sie vertauscht sind. Alles drei kommt regelmässig vor.
 *
 * **Warum die Kachel selbst hochlädt.** Der frühere Weg — Bild in der
 * Mediathek hochladen, Adresse kopieren, hier einfügen — hatte drei
 * Handgriffe und zwei Fehlerquellen (falsche Adresse, vertauschte Seiten).
 * Wer die Vorher-Kachel anklickt oder ein Bild darauf zieht, kann die Seiten
 * nicht mehr verwechseln, und die Adresse tippt niemand ab. Die Adressfelder
 * bleiben darunter sichtbar, weil sie der tatsächlich gespeicherte Wert sind
 * und der Weg für Bilder auf fremden Servern.
 */
export interface GalleryRow {
  id: string;
  title: string;
  description: string | null;
  serviceKind: string | null;
  beforeUrl: string;
  afterUrl: string;
  location: string | null;
  featured: boolean;
  position: number;
  published: boolean;
}

const EMPTY: CreateGalleryItemInput = {
  title: '',
  description: undefined,
  serviceKind: null,
  beforeUrl: '',
  afterUrl: '',
  location: undefined,
  featured: false,
  position: 0,
  published: true,
};

export function GalleryForm({
  open,
  onOpenChange,
  item,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item?: GalleryRow;
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);

  const form = useForm<CreateGalleryItemInput>({
    resolver: zodResolver(createGalleryItemSchema),
    defaultValues: EMPTY,
  });

  React.useEffect(() => {
    if (!open) return;
    form.reset(
      item
        ? {
            title: item.title,
            description: item.description ?? undefined,
            serviceKind: item.serviceKind as CreateGalleryItemInput['serviceKind'],
            beforeUrl: item.beforeUrl,
            afterUrl: item.afterUrl,
            location: item.location ?? undefined,
            featured: item.featured,
            position: item.position,
            published: item.published,
          }
        : EMPTY,
    );
    setError(null);
  }, [open, item, form]);

  const beforeUrl = form.watch('beforeUrl');
  const afterUrl = form.watch('afterUrl');
  const same = beforeUrl !== '' && beforeUrl === afterUrl;

  const onSubmit = async (values: CreateGalleryItemInput) => {
    setError(null);
    try {
      if (item) await api.patch(`/api/gallery/${item.id}`, values);
      else await api.post('/api/gallery', values);
      toast.success('Galerieeintrag gespeichert.');
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
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{item ? 'Galerieeintrag bearbeiten' : 'Neuer Galerieeintrag'}</DialogTitle>
          <DialogDescription>
            Zwei Bilder desselben Objekts, vor und nach der Reinigung.
          </DialogDescription>
        </DialogHeader>

        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" noValidate>
            {/* Vorschau mit Upload direkt auf der Kachel */}
            <div className="space-y-2 rounded-xl bg-muted/40 p-4">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-meta font-medium">Vorschau</p>
                <p className="text-2xs text-muted-foreground">
                  Bild auf die Kachel ziehen oder Kachel anklicken zum Hochladen.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <ImageTile
                  label="Vorher"
                  url={beforeUrl}
                  onChange={(url) =>
                    form.setValue('beforeUrl', url, { shouldValidate: true, shouldDirty: true })
                  }
                />
                <ImageTile
                  label="Nachher"
                  url={afterUrl}
                  onChange={(url) =>
                    form.setValue('afterUrl', url, { shouldValidate: true, shouldDirty: true })
                  }
                />
              </div>
              {same ? (
                <p className="text-meta text-destructive">
                  Beide Adressen zeigen dasselbe Bild — der Schieberegler auf der Website bliebe
                  leer.
                </p>
              ) : null}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Titel</FormLabel>
                    <FormControl>
                      <Input placeholder="3.5-Zimmer-Wohnung, Umzugsreinigung" {...field} />
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
                    <FormLabel>Ort</FormLabel>
                    <FormControl>
                      <Input placeholder="Bern Bümpliz" {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormDescription>Erscheint als Bildunterschrift.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="beforeUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Bild vorher</FormLabel>
                  <FormControl>
                    <Input type="url" className="font-mono text-sm" placeholder="https://…" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="afterUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Bild nachher</FormLabel>
                  <FormControl>
                    <Input type="url" className="font-mono text-sm" placeholder="https://…" {...field} />
                  </FormControl>
                  <FormDescription>
                    Wird beim Hochladen über die Kachel automatisch ausgefüllt. Für Bilder auf
                    fremden Servern die vollständige Adresse über https eintragen.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="serviceKind"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Leistungsart</FormLabel>
                  <Select
                    value={field.value ?? 'none'}
                    onValueChange={(value) => field.onChange(value === 'none' ? null : value)}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Ohne Zuordnung" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="none">Ohne Zuordnung</SelectItem>
                      {SERVICE_KINDS.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {SERVICE_KIND_LABELS[kind]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>Filtert die Galerie nach Art der Reinigung.</FormDescription>
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
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="space-y-3">
              <FormField
                control={form.control}
                name="featured"
                render={({ field }) => (
                  <FormItem>
                    <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={(checked) => field.onChange(checked === true)}
                      />
                      <span className="space-y-1">
                        <span className="block font-medium">Im Kopfbereich der Startseite</span>
                        <span className="block text-meta text-muted-foreground">
                          Der erste hervorgehobene Eintrag wird dort gezeigt.
                        </span>
                      </span>
                    </label>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="published"
                render={({ field }) => (
                  <FormItem>
                    <label className="flex cursor-pointer items-center gap-2.5 text-sm">
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={(checked) => field.onChange(checked === true)}
                      />
                      Auf der Website anzeigen
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

/**
 * Eine Seite des Vergleichs: Vorschau, Ablagefläche und Dateiauswahl in einem.
 *
 * Die ganze Kachel ist ein `<label>` um ein verstecktes Dateifeld — so öffnet
 * ein Klick den Dateidialog, ohne dass ein eigener Knopf Platz wegnimmt, und
 * die Tastatur erreicht das Feld weiterhin. Liegt ein Bild da, erscheint der
 * Hinweis «Bild ersetzen» erst beim Überfahren, damit die Vorschau selbst
 * nicht verdeckt ist. Mediathek und Entfernen stehen daneben als eigene
 * Knöpfe, weil sie den Dateidialog nicht auslösen dürfen.
 *
 * Gerendert wird mit `<img>`, nicht `next/image`: Die Adresse ist entweder
 * frei eingegeben (nicht in der Domänenliste) oder relativ zum lokalen
 * Blob-Treiber — beides würde der Optimierer abweisen.
 */
function ImageTile({
  label,
  url,
  onChange,
}: {
  label: string;
  url: string;
  onChange: (url: string) => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [broken, setBroken] = React.useState(false);

  // Bei einer neuen Adresse den Ladefehler zurücksetzen, sonst bliebe ein
  // einmal gescheitertes Bild für immer als «lädt nicht» markiert.
  React.useEffect(() => setBroken(false), [url]);

  const renderable = url.startsWith('/') || /^https?:\/\/\S+$/i.test(url);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      onChange(await uploadImage(file));
      toast.success(`Bild «${label}» hochgeladen.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Das Bild konnte nicht hochgeladen werden.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <figure className="space-y-1.5">
      <label
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void upload(event.dataTransfer.files[0]);
        }}
        className={cn(
          'group relative block aspect-[4/3] cursor-pointer overflow-hidden rounded-lg border bg-muted transition-colors focus-within:ring-2 focus-within:ring-ring',
          dragging
            ? 'border-primary bg-primary/[0.06]'
            : url
              ? 'border-border'
              : 'border-dashed border-border hover:border-primary/60 hover:bg-muted/70',
          busy && 'pointer-events-none',
        )}
      >
        {url && renderable && !broken ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt=""
            className="size-full object-cover"
            onError={() => setBroken(true)}
          />
        ) : (
          <span className="flex size-full flex-col items-center justify-center gap-1.5 px-3 text-center text-2xs text-muted-foreground">
            <ImagePlus className="size-5" aria-hidden />
            {url ? (
              <span>{renderable ? 'Bild lädt nicht' : 'keine gültige Adresse'}</span>
            ) : (
              <span>
                Bild hierher ziehen
                <br />
                oder klicken
              </span>
            )}
          </span>
        )}

        {/* Hinweis beim Überfahren, nur wenn schon ein Bild liegt */}
        {url && !busy ? (
          <span className="absolute inset-0 flex items-center justify-center gap-1.5 bg-foreground/55 text-xs font-medium text-background opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <Upload className="size-3.5" aria-hidden />
            Bild ersetzen
          </span>
        ) : null}

        {busy ? (
          <span className="absolute inset-0 flex items-center justify-center gap-1.5 bg-background/80 text-xs font-medium">
            <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
            Wird hochgeladen …
          </span>
        ) : null}

        <input
          type="file"
          accept={ACCEPTED_IMAGE_TYPES.join(',')}
          className="sr-only"
          aria-label={`Bild ${label} hochladen`}
          disabled={busy}
          onChange={(event) => {
            void upload(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
      </label>

      <figcaption className="flex items-center justify-between gap-2">
        <span className="text-2xs font-medium">{label}</span>
        <span className="flex items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-2xs text-muted-foreground"
            onClick={() => setPickerOpen(true)}
            disabled={busy}
          >
            <FolderOpen className="size-3" aria-hidden />
            Mediathek
          </Button>
          {url ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-2xs text-muted-foreground hover:text-destructive"
              onClick={() => onChange('')}
              disabled={busy}
              aria-label={`Bild ${label} entfernen`}
            >
              <Trash2 className="size-3" aria-hidden />
            </Button>
          ) : null}
        </span>
      </figcaption>

      <MediaPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(picked) => {
          onChange(picked);
          setPickerOpen(false);
        }}
      />
    </figure>
  );
}
