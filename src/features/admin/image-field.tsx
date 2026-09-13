'use client';

import * as React from 'react';
import { ImageOff, Loader2, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, Skeleton } from '@/components/ui/primitives';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/overlays';

/**
 * Bildfeld für die Redaktion.
 *
 * **Warum es das braucht.** Das Register kannte die Art `image` von Anfang an,
 * die Maske aber nicht: Ein Bildbaustein wäre in den Textbereich gefallen und
 * hätte die Redaktion eine URL von Hand eintippen lassen. Das ist keine
 * Bildpflege, das ist eine Zumutung mit Fehlerpotenzial — eine falsch
 * abgetippte Adresse zeigt sich erst auf der fertigen Seite als leeres
 * Rechteck.
 *
 * Drei Wege zum Bild, weil im Alltag alle drei vorkommen:
 *
 *  • **Hochladen** — der häufigste Fall. Läuft über denselben Weg wie
 *    Profilbild und Einsatzfotos.
 *  • **Aus der Mediathek wählen** — für Bilder, die schon im Haus sind.
 *  • **Adresse eintragen** — für Bilder auf einem fremden Server. Selten, aber
 *    ohne diesen Weg müsste man sie erst herunter- und wieder hochladen.
 */

interface MediaItem {
  id: string;
  url: string;
  filename: string;
  mimeType: string;
}

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];

export function ImageField({
  id,
  value,
  onChange,
  describedBy,
  invalid,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  describedBy?: string;
  invalid?: boolean;
}) {
  const [busy, setBusy] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError(null);

    if (!ACCEPTED.includes(file.type)) {
      setError('Bitte ein Bild im Format JPEG, PNG, WebP oder AVIF wählen.');
      return;
    }

    setBusy(true);
    try {
      const target = await api.post<{ signedUrl: string; publicUrl: string }>(
        '/api/files/upload-url',
        {
          profile: 'gallery',
          filename: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
        },
      );

      const response = await fetch(target.signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type, 'x-upsert': 'true' },
        body: file,
      });
      if (!response.ok) throw new Error('Der Upload wurde vom Speicher abgelehnt.');

      onChange(target.publicUrl);
      toast.success('Bild hochgeladen.');
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Das Bild konnte nicht hochgeladen werden.';
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {error ? <Alert variant="destructive">{error}</Alert> : null}

      <div className="flex flex-wrap items-start gap-4">
        {/* Vorschau */}
        <div className="flex size-28 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted">
          {value ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value} alt="" className="size-full object-cover" />
          ) : (
            <ImageOff className="size-6 text-muted-foreground/60" aria-hidden />
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-3">
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
              'flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed p-4 text-center transition-colors',
              dragging ? 'border-primary bg-primary/[0.06]' : 'border-border hover:bg-muted/40',
              busy && 'pointer-events-none opacity-60',
            )}
          >
            {busy ? (
              <>
                <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
                <span className="text-sm font-medium">Wird hochgeladen …</span>
              </>
            ) : (
              <>
                <Upload className="size-4 text-muted-foreground" aria-hidden />
                <span className="text-sm font-medium">Bild hierher ziehen oder wählen</span>
              </>
            )}
            <input
              type="file"
              accept={ACCEPTED.join(',')}
              className="sr-only"
              onChange={(event) => {
                void upload(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
              Aus Mediathek
            </Button>
            {value ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onChange('')}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 aria-hidden />
                Entfernen
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {/*
        Die Adresse bleibt sichtbar und änderbar. Sie ist der Wert, der
        tatsächlich gespeichert wird — ihn zu verstecken hiesse, die Redaktion
        im Zweifelsfall raten zu lassen, was hinterlegt ist.
      */}
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="https://… oder /api/files/blob/…"
        aria-describedby={describedBy}
        aria-invalid={invalid ? true : undefined}
        className="font-mono text-xs"
      />

      <MediaPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(url) => {
          onChange(url);
          setPickerOpen(false);
        }}
      />
    </div>
  );
}

/** Bildauswahl aus der Mediathek. */
function MediaPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (url: string) => void;
}) {
  const [items, setItems] = React.useState<MediaItem[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [query, setQuery] = React.useState('');

  React.useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setLoading(true);

    api
      .get<MediaItem[]>('/api/media', { nurBilder: '1', pageSize: 60, q: query || undefined })
      .then((result) => {
        if (!cancelled) setItems(result);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, query]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Bild aus der Mediathek</DialogTitle>
          <DialogDescription>
            Alle hochgeladenen Bilder. Neue Dateien landen hier automatisch, sobald sie irgendwo
            im System hochgeladen werden.
          </DialogDescription>
        </DialogHeader>

        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Nach Dateiname suchen …"
        />

        {loading ? (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <Skeleton key={index} className="aspect-square rounded-xl" />
            ))}
          </div>
        ) : items && items.length === 0 ? (
          <Alert variant="info" title="Noch keine Bilder">
            Laden Sie oben ein Bild hoch — es steht danach auch hier zur Auswahl.
          </Alert>
        ) : (
          <ul className="grid max-h-96 grid-cols-3 gap-3 overflow-y-auto sm:grid-cols-4">
            {items?.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onPick(item.url)}
                  className="block w-full overflow-hidden rounded-xl border border-border transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  title={item.filename}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={item.url}
                    alt={item.filename}
                    className="aspect-square w-full object-cover"
                    loading="lazy"
                  />
                </button>
              </li>
            ))}
          </ul>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
