'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Download, ImageOff, Loader2, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/form';
import { Alert } from '@/components/ui/primitives';
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
} from '@/components/ui/overlays';

/**
 * Fotos eines Einsatzes verwalten.
 *
 * Gestaltungsentscheide:
 *
 *  • **Ziehen und Ablegen mit Dateiauswahl als gleichwertigem Weg.** Das Büro
 *    zieht Bilder aus dem Ordner, das Team wählt sie auf dem Telefon aus. Wer
 *    nur eine der beiden Gesten anbietet, sperrt jeweils die andere Hälfte aus.
 *
 *  • **Ersetzen heisst hochladen und löschen, nicht überschreiben.** Ein Bild
 *    unter derselben Adresse auszutauschen würde jede bereits verschickte
 *    Kopie des Rapports still verändern — im Nachweisfall ein Problem.
 *
 *  • **Löschen fragt nach, weil es endgültig ist.** Anders als bei
 *    Geschäftsdaten gibt es hier keinen Papierkorb: Ein Foto wird oft genau
 *    deshalb entfernt, weil es etwas zeigt, das nicht aufbewahrt werden darf.
 */

export interface JobPhoto {
  id: string;
  type: string;
  url: string;
  thumbnailUrl: string | null;
  caption: string | null;
  room: string | null;
}

const TYPES = [
  { value: 'BEFORE', label: 'Vorher' },
  { value: 'AFTER', label: 'Nachher' },
  { value: 'DAMAGE', label: 'Schaden' },
  { value: 'DOCUMENT', label: 'Dokument' },
  { value: 'OTHER', label: 'Weitere' },
] as const;

const MAX_BYTES = 15 * 1024 * 1024;

export function JobPhotos({
  jobId,
  photos: initial,
  readOnly = false,
}: {
  jobId: string;
  photos: JobPhoto[];
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [photos, setPhotos] = React.useState(initial);
  const [uploadType, setUploadType] = React.useState<string>('BEFORE');
  const [busy, setBusy] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const [editing, setEditing] = React.useState<JobPhoto | null>(null);
  const [deleting, setDeleting] = React.useState<JobPhoto | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const grouped = TYPES.map((type) => ({
    ...type,
    photos: photos.filter((photo) => photo.type === type.value),
  })).filter((group) => group.photos.length > 0);

  const upload = async (files: FileList | File[]) => {
    const list = Array.from(files).filter((file) => file.type.startsWith('image/'));
    if (list.length === 0) {
      setError('Bitte Bilddateien wählen (JPEG, PNG, WebP).');
      return;
    }

    const tooBig = list.find((file) => file.size > MAX_BYTES);
    if (tooBig) {
      setError(`„${tooBig.name}" ist grösser als 15 MB und wurde nicht hochgeladen.`);
      return;
    }

    setBusy(true);
    setError(null);

    try {
      for (const file of list) {
        // 1) Signierte Adresse holen — der Server bestimmt Pfad und Grenzen.
        const target = await api.post<{ signedUrl: string; publicUrl: string }>(
          '/api/files/upload-url',
          {
            profile: 'jobPhoto',
            filename: file.name,
            mimeType: file.type,
            sizeBytes: file.size,
            scopeId: jobId,
          },
        );

        // 2) Direkt zum Speicher — nicht durch die Applikation, sonst scheitern
        //    Baustellenfotos am Body-Limit.
        const response = await fetch(target.signedUrl, {
          method: 'PUT',
          headers: { 'Content-Type': file.type, 'x-upsert': 'true' },
          body: file,
        });
        if (!response.ok) throw new Error('Der Upload wurde vom Speicher abgelehnt.');

        // 3) Am Einsatz registrieren.
        const photo = await api.post<JobPhoto>(`/api/jobs/${jobId}/photos`, {
          type: uploadType,
          url: target.publicUrl,
        });

        setPhotos((current) => [photo, ...current]);
      }

      toast.success(list.length === 1 ? 'Foto hochgeladen.' : `${list.length} Fotos hochgeladen.`);
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Das Foto konnte nicht hochgeladen werden.';
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  const saveDetails = async (photo: JobPhoto, patch: Partial<JobPhoto>) => {
    setBusy(true);
    try {
      const updated = await api.patch<JobPhoto>(`/api/jobs/${jobId}/photos/${photo.id}`, {
        type: patch.type,
        caption: patch.caption ?? null,
        room: patch.room ?? null,
      });
      setPhotos((current) => current.map((entry) => (entry.id === photo.id ? updated : entry)));
      setEditing(null);
      toast.success('Foto aktualisiert.');
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Die Änderung wurde nicht gespeichert.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (photo: JobPhoto) => {
    setBusy(true);
    try {
      await api.delete(`/api/jobs/${jobId}/photos/${photo.id}`);
      setPhotos((current) => current.filter((entry) => entry.id !== photo.id));
      setDeleting(null);
      toast.success('Foto gelöscht.');
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Das Foto konnte nicht gelöscht werden.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5 py-4">
      {error ? <Alert variant="destructive">{error}</Alert> : null}

      {photos.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <ImageOff className="size-4" aria-hidden />
          Noch keine Fotos. Vorher-/Nachher-Aufnahmen sind der beste Beleg gegenüber der Kundschaft.
        </p>
      ) : (
        grouped.map((group) => (
          <section key={group.value} className="space-y-2">
            <h3 className="text-sm font-medium text-muted-foreground">
              {group.label} ({group.photos.length})
            </h3>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
              {group.photos.map((photo) => (
                <li key={photo.id} className="group relative">
                  <a
                    href={photo.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block overflow-hidden rounded-xl border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={photo.thumbnailUrl ?? photo.url}
                      alt={photo.caption ?? `${group.label}${photo.room ? `: ${photo.room}` : ''}`}
                      className="aspect-square w-full object-cover transition-opacity group-hover:opacity-85"
                      loading="lazy"
                    />
                  </a>

                  {/*
                    Die Werkzeuge erscheinen beim Überfahren, sind aber immer im
                    DOM und per Tastatur erreichbar — ein Werkzeug, das nur die
                    Maus findet, gibt es für einen Teil der Nutzenden nicht.
                  */}
                  <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                    <a
                      href={photo.url}
                      download
                      className="flex size-7 items-center justify-center rounded-lg bg-card/90 text-foreground shadow-soft backdrop-blur transition-colors hover:bg-card"
                      aria-label="Foto herunterladen"
                    >
                      <Download className="size-3.5" aria-hidden />
                    </a>
                    {!readOnly ? (
                      <>
                        <button
                          type="button"
                          onClick={() => setEditing(photo)}
                          className="flex size-7 items-center justify-center rounded-lg bg-card/90 text-foreground shadow-soft backdrop-blur transition-colors hover:bg-card"
                          aria-label="Foto einordnen"
                        >
                          <span aria-hidden className="text-xs font-semibold">
                            i
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleting(photo)}
                          className="flex size-7 items-center justify-center rounded-lg bg-card/90 text-destructive shadow-soft backdrop-blur transition-colors hover:bg-destructive hover:text-destructive-foreground"
                          aria-label="Foto löschen"
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                        </button>
                      </>
                    ) : null}
                  </div>

                  {photo.room || photo.caption ? (
                    <p className="mt-1.5 truncate text-xs text-muted-foreground">
                      {photo.room ?? photo.caption}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      {!readOnly ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="photo-upload-type">Neue Fotos einordnen als</Label>
              <Select value={uploadType} onValueChange={setUploadType}>
                <SelectTrigger id="photo-upload-type" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPES.map((type) => (
                    <SelectItem key={type.value} value={type.value}>
                      {type.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <label
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              if (event.dataTransfer.files.length > 0) void upload(event.dataTransfer.files);
            }}
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed p-8 text-center transition-colors',
              dragging ? 'border-primary bg-primary/[0.06]' : 'border-border hover:bg-muted/40',
              busy && 'pointer-events-none opacity-60',
            )}
          >
            {busy ? (
              <>
                <Loader2 className="size-5 animate-spin text-primary" aria-hidden />
                <span className="text-sm font-medium">Wird hochgeladen …</span>
              </>
            ) : (
              <>
                <Upload className="size-5 text-muted-foreground" aria-hidden />
                <span className="text-sm font-medium">
                  Fotos hierher ziehen oder klicken zum Auswählen
                </span>
                <span className="text-xs text-muted-foreground">
                  JPEG, PNG oder WebP · bis 15 MB je Bild · mehrere gleichzeitig möglich
                </span>
              </>
            )}
            <input
              type="file"
              accept="image/*"
              multiple
              className="sr-only"
              onChange={(event) => {
                if (event.target.files?.length) void upload(event.target.files);
                event.target.value = '';
              }}
            />
          </label>
        </div>
      ) : null}

      {/* Einordnen */}
      <Dialog open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent size="sm">
          {editing ? <PhotoDetailsForm photo={editing} busy={busy} onSave={saveDetails} onCancel={() => setEditing(null)} /> : null}
        </DialogContent>
      </Dialog>

      {/* Löschen */}
      <Dialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Foto löschen?</DialogTitle>
            <DialogDescription>
              Das Bild wird endgültig entfernt — es gibt dafür keinen Papierkorb. Bereits
              versendete Berichte behalten ihre Kopie.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Abbrechen
            </Button>
            <Button
              variant="destructive"
              loading={busy}
              onClick={() => deleting && void remove(deleting)}
            >
              <Trash2 aria-hidden />
              Endgültig löschen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PhotoDetailsForm({
  photo,
  busy,
  onSave,
  onCancel,
}: {
  photo: JobPhoto;
  busy: boolean;
  onSave: (photo: JobPhoto, patch: Partial<JobPhoto>) => void;
  onCancel: () => void;
}) {
  const [type, setType] = React.useState(photo.type);
  const [room, setRoom] = React.useState(photo.room ?? '');
  const [caption, setCaption] = React.useState(photo.caption ?? '');

  return (
    <>
      <DialogHeader>
        <DialogTitle>Foto einordnen</DialogTitle>
        <DialogDescription>
          Art, Raum und Bildlegende erscheinen im Einsatzbericht an die Kundschaft.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={photo.thumbnailUrl ?? photo.url}
          alt=""
          className="max-h-48 w-full rounded-xl object-cover"
        />

        <div className="space-y-1.5">
          <Label htmlFor="photo-type">Art</Label>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger id="photo-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPES.map((entry) => (
                <SelectItem key={entry.value} value={entry.value}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="photo-room">Raum</Label>
          <Input
            id="photo-room"
            value={room}
            onChange={(event) => setRoom(event.target.value)}
            placeholder="z. B. Küche"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="photo-caption">Bildlegende</Label>
          <Input
            id="photo-caption"
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            placeholder="Was zeigt das Bild?"
          />
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          Abbrechen
        </Button>
        <Button loading={busy} onClick={() => onSave(photo, { type, room, caption })}>
          Speichern
        </Button>
      </DialogFooter>
    </>
  );
}
