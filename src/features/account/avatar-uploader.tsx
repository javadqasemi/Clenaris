'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Camera, Loader2, Trash2, Upload, ZoomIn } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/form';
import { Alert, PersonAvatar } from '@/components/ui/primitives';
import { Slider } from '@/components/ui/controls';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/overlays';

/**
 * Profilbild hochladen, zuschneiden und entfernen.
 *
 * Architekturentscheide:
 *
 *  • **Zuschnitt und Verkleinerung passieren im Browser, nicht auf dem
 *    Server.** Ein Foto aus einer Telefonkamera hat vier bis zwölf Megabyte;
 *    als Profilbild wird es auf 512 Pixel dargestellt. Es unbearbeitet
 *    hochzuladen kostet die Person unterwegs ihr Datenvolumen, den Speicher
 *    dauerhaft Platz und jede Seite, die das Bild zeigt, Ladezeit. Nach dem
 *    Zuschnitt sind es rund 40 Kilobyte.
 *
 *  • **Quadratisch, weil es überall quadratisch dargestellt wird.** Das
 *    Seitenverhältnis erst im CSS zu erzwingen heisst, dass jede Ansicht selbst
 *    entscheidet, welcher Teil des Bildes wegfällt — meist der mit dem Gesicht.
 *    Wer zuschneidet, sieht vorher, was bleibt.
 *
 *  • **Das Bild geht direkt zum Speicher.** Denselben Weg nehmen die
 *    Einsatzfotos: signierte Adresse vom Server, Upload am Server vorbei.
 *
 *  • **Die Prüfung von Typ und Grösse steht doppelt** — hier für eine
 *    verständliche Meldung, im Server für die Verbindlichkeit.
 */

/**
 * Sitzungstoken neu ausstellen lassen.
 *
 * Das Profilbild steckt als Anspruch im Zugangstoken — die Kopfzeile liest es
 * dort, damit sie nicht bei jedem Seitenaufruf die Datenbank fragen muss. Der
 * Token wird beim Anmelden ausgestellt und lebt fünfzehn Minuten. Ohne diesen
 * Schritt hätte man also ein neues Bild hochgeladen, es in der Karte gesehen —
 * und oben rechts weiterhin seine Initialen, bis zu einer Viertelstunde lang.
 * Das sieht nach einem verschluckten Upload aus.
 *
 * Ein Fehlschlag bleibt folgenlos: Das Bild *ist* gespeichert, nur die
 * Kopfzeile hinkt dann bis zur nächsten Erneuerung hinterher. Deswegen die
 * Anmeldung abzubrechen wäre die schlechtere Antwort.
 */
async function refreshSession(): Promise<void> {
  try {
    await api.post('/api/auth/refresh');
  } catch {
    // Bewusst still — siehe oben.
  }
}

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const OUTPUT_SIZE = 512;
const OUTPUT_QUALITY = 0.85;

export function AvatarUploader({
  firstName,
  lastName,
  avatarUrl,
}: {
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
}) {
  const router = useRouter();
  const [dragging, setDragging] = React.useState(false);
  const [source, setSource] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const accept = (file: File | undefined) => {
    setError(null);
    if (!file) return;

    if (!ACCEPTED.includes(file.type)) {
      setError('Bitte ein Bild im Format JPEG, PNG oder WebP wählen.');
      return;
    }
    if (file.size > MAX_INPUT_BYTES) {
      setError(
        `Das Bild ist ${(file.size / 1024 / 1024).toFixed(1)} MB gross — höchstens 10 MB sind möglich.`,
      );
      return;
    }

    const reader = new FileReader();
    reader.onload = () => setSource(String(reader.result));
    reader.onerror = () => setError('Das Bild konnte nicht gelesen werden.');
    reader.readAsDataURL(file);
  };

  const save = async (blob: Blob) => {
    setBusy(true);
    setError(null);
    try {
      const target = await api.post<{ signedUrl: string; publicUrl: string }>(
        '/api/files/upload-url',
        {
          profile: 'avatar',
          filename: 'profilbild.webp',
          mimeType: blob.type,
          sizeBytes: blob.size,
        },
      );

      const response = await fetch(target.signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': blob.type, 'x-upsert': 'true' },
        body: blob,
      });
      if (!response.ok) throw new Error('Der Upload wurde vom Speicher abgelehnt.');

      await api.patch('/api/account/profile', {
        firstName,
        lastName,
        avatarUrl: target.publicUrl,
      });

      await refreshSession();
      toast.success('Profilbild gespeichert.');
      setSource(null);
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Das Profilbild konnte nicht gespeichert werden.';
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setRemoving(true);
    setError(null);
    try {
      // Leerer String statt `null`: Das Schema unterscheidet „nicht
      // mitgeschickt" (unverändert) von „ausdrücklich geleert".
      await api.patch('/api/account/profile', { firstName, lastName, avatarUrl: '' });
      await refreshSession();
      toast.success('Profilbild entfernt.');
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Das Profilbild konnte nicht entfernt werden.';
      setError(message);
      toast.error(message);
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="space-y-4 py-4">
      {error ? <Alert variant="destructive">{error}</Alert> : null}

      <div className="flex flex-wrap items-center gap-5">
        <PersonAvatar firstName={firstName} lastName={lastName} src={avatarUrl} size="xl" />

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
              accept(event.dataTransfer.files[0]);
            }}
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed p-5 text-center transition-colors',
              dragging ? 'border-primary bg-primary/[0.06]' : 'border-border hover:bg-muted/40',
            )}
          >
            <Upload className="size-4 text-muted-foreground" aria-hidden />
            <span className="text-sm font-medium">
              Bild hierher ziehen oder klicken zum Auswählen
            </span>
            <span className="text-xs text-muted-foreground">
              JPEG, PNG oder WebP · bis 10 MB · wird auf {OUTPUT_SIZE}&nbsp;×&nbsp;{OUTPUT_SIZE}{' '}
              Pixel verkleinert
            </span>
            <input
              type="file"
              accept={ACCEPTED.join(',')}
              className="sr-only"
              onChange={(event) => {
                accept(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </label>

          {avatarUrl ? (
            <Button variant="ghost" size="sm" onClick={() => void remove()} loading={removing}>
              <Trash2 aria-hidden />
              Bild entfernen
            </Button>
          ) : null}
        </div>
      </div>

      <CropDialog
        source={source}
        busy={busy}
        onCancel={() => setSource(null)}
        onConfirm={save}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Zuschnitt
// ---------------------------------------------------------------------------

/**
 * Quadratischer Zuschnitt mit Verschieben und Zoomen.
 *
 * Der Ausschnitt wird als Bildschirmgeometrie geführt (Zoom-Faktor und
 * Verschiebung in Anzeigepixeln) und erst beim Bestätigen in Bildkoordinaten
 * umgerechnet. Das ist der einzige Weg, bei dem das Ergebnis garantiert dem
 * entspricht, was die Vorschau zeigt — rechnet man laufend um, driften Vorschau
 * und Ergebnis bei jeder Rundung ein Stück auseinander.
 */
const VIEWPORT = 260;

function CropDialog({
  source,
  busy,
  onCancel,
  onConfirm,
}: {
  source: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (blob: Blob) => void;
}) {
  const [image, setImage] = React.useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = React.useState(1);
  const [offset, setOffset] = React.useState({ x: 0, y: 0 });
  const drag = React.useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  // Bild laden und den Ausschnitt zurücksetzen, sobald eine neue Quelle kommt.
  React.useEffect(() => {
    if (!source) {
      setImage(null);
      return;
    }
    const element = new Image();
    element.onload = () => {
      setImage(element);
      setZoom(1);
      setOffset({ x: 0, y: 0 });
    };
    element.src = source;
  }, [source]);

  /**
   * Grundmassstab: Das Bild füllt das quadratische Fenster gerade aus
   * („cover"). Bei Zoom 1 ist also nichts leer — der Zoom vergrössert von dort
   * aus weiter.
   */
  const baseScale = image ? Math.max(VIEWPORT / image.width, VIEWPORT / image.height) : 1;
  const scale = baseScale * zoom;
  const displayWidth = image ? image.width * scale : 0;
  const displayHeight = image ? image.height * scale : 0;

  /** Verschiebung so begrenzen, dass nie ein leerer Rand entsteht. */
  const clampOffset = React.useCallback(
    (next: { x: number; y: number }) => {
      const maxX = Math.max(0, (displayWidth - VIEWPORT) / 2);
      const maxY = Math.max(0, (displayHeight - VIEWPORT) / 2);
      return {
        x: Math.min(Math.max(next.x, -maxX), maxX),
        y: Math.min(Math.max(next.y, -maxY), maxY),
      };
    },
    [displayWidth, displayHeight],
  );

  React.useEffect(() => {
    setOffset((current) => clampOffset(current));
  }, [clampOffset]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setOffset(
      clampOffset({
        x: drag.current.ox + (event.clientX - drag.current.x),
        y: drag.current.oy + (event.clientY - drag.current.y),
      }),
    );
  };

  const onPointerUp = () => {
    drag.current = null;
  };

  const confirm = () => {
    if (!image) return;

    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const context = canvas.getContext('2d');
    if (!context) return;

    /**
     * Vom Fenster zurück ins Bild rechnen: Der sichtbare Ausschnitt beginnt
     * dort, wo die Mitte des Fensters abzüglich der halben Fensterbreite auf
     * dem verschobenen, skalierten Bild liegt.
     */
    const sourceSize = VIEWPORT / scale;
    const centerX = image.width / 2 - offset.x / scale;
    const centerY = image.height / 2 - offset.y / scale;

    context.imageSmoothingQuality = 'high';
    context.drawImage(
      image,
      centerX - sourceSize / 2,
      centerY - sourceSize / 2,
      sourceSize,
      sourceSize,
      0,
      0,
      OUTPUT_SIZE,
      OUTPUT_SIZE,
    );

    canvas.toBlob(
      (blob) => {
        if (blob) onConfirm(blob);
      },
      // WebP spart gegenüber JPEG rund ein Drittel bei gleicher Wahrnehmung
      // und wird von allen Browsern unterstützt, die diese Anwendung bedient.
      'image/webp',
      OUTPUT_QUALITY,
    );
  };

  return (
    <Dialog open={Boolean(source)} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Bildausschnitt wählen</DialogTitle>
          <DialogDescription>
            Ziehen Sie das Bild und stellen Sie den Zoom ein. Der Kreis zeigt, was später
            erscheint.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div
            className="relative mx-auto cursor-grab touch-none select-none overflow-hidden rounded-2xl bg-muted active:cursor-grabbing"
            style={{ width: VIEWPORT, height: VIEWPORT }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            role="application"
            aria-label="Bildausschnitt verschieben"
          >
            {image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={image.src}
                alt=""
                draggable={false}
                className="pointer-events-none absolute left-1/2 top-1/2"
                style={{
                  width: displayWidth,
                  height: displayHeight,
                  transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
                  maxWidth: 'none',
                }}
              />
            ) : (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
              </div>
            )}

            {/* Der Kreis liegt über dem Bild und fängt keine Zeigerereignisse ab. */}
            <div
              className="pointer-events-none absolute inset-0 rounded-2xl ring-[3rem] ring-background/70"
              style={{ borderRadius: '50%' }}
              aria-hidden
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="avatar-zoom" className="flex items-center gap-2">
              <ZoomIn className="size-4" aria-hidden />
              Zoom
            </Label>
            <Slider
              id="avatar-zoom"
              min={1}
              max={4}
              step={0.05}
              value={[zoom]}
              onValueChange={([value]) => setZoom(value ?? 1)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Abbrechen
          </Button>
          <Button onClick={confirm} loading={busy} disabled={!image}>
            <Camera aria-hidden />
            Übernehmen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
