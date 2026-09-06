'use client';

import * as React from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Save } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { SERVICE_KINDS } from '@/lib/validation/catalog';
import { createGalleryItemSchema, type CreateGalleryItemInput } from '@/lib/validation/website';
import { SERVICE_KIND_LABELS } from '@/features/admin/catalog/shared';
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
 * Die Vorschau zeigt beide Bilder nebeneinander, sobald zwei Adressen
 * dastehen. Das ist die einzige Kontrolle, die zählt: ob es dasselbe Bild ist,
 * ob eines nicht lädt, ob sie vertauscht sind. Alles drei kommt beim Kopieren
 * von Adressen regelmässig vor.
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
            {/* Vorschau */}
            {beforeUrl || afterUrl ? (
              <div className="space-y-2 rounded-xl bg-muted/40 p-4">
                <p className="text-meta font-medium">Vorschau</p>
                <div className="grid grid-cols-2 gap-3">
                  <PreviewImage url={beforeUrl} label="Vorher" />
                  <PreviewImage url={afterUrl} label="Nachher" />
                </div>
                {same ? (
                  <p className="text-meta text-destructive">
                    Beide Adressen zeigen dasselbe Bild — der Schieberegler auf der Website bliebe
                    leer.
                  </p>
                ) : null}
              </div>
            ) : null}

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
                    Vollständige Adresse über https. Bilder laden Sie in der Mediathek hoch und
                    kopieren die Adresse von dort.
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

function PreviewImage({ url, label }: { url: string; label: string }) {
  const valid = /^https:\/\/\S+$/i.test(url);
  return (
    <figure className="space-y-1">
      <div className="relative h-28 overflow-hidden rounded-lg border border-border bg-muted">
        {valid ? (
          // `unoptimized`: die Adresse ist frei eingegeben und steht nicht in
          // der Domänenliste von next.config — der Optimierer würde sie
          // abweisen.
          <Image src={url} alt="" fill unoptimized sizes="50vw" className="object-cover" />
        ) : (
          <span className="flex h-full items-center justify-center text-2xs text-muted-foreground">
            keine gültige Adresse
          </span>
        )}
      </div>
      <figcaption className="text-2xs text-muted-foreground">{label}</figcaption>
    </figure>
  );
}
