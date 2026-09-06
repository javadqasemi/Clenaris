'use client';

import * as React from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { Download, FileText, Link2, Pencil, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { cn, formatDate } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/primitives';
import { Checkbox } from '@/components/ui/controls';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/overlays';
import { EmptyState } from '@/components/app/page-parts';

/**
 * Mediathek als Kachelraster.
 *
 * Gestaltungsentscheide:
 *
 *  • **Bilder als Bild, Dokumente als Zeile mit Symbol.** Ein Raster aus
 *    identischen PDF-Symbolen ist schwerer zu lesen als eine Liste; ein Raster
 *    aus Fotos leichter. Beide Formen im selben Raster zu mischen wäre der
 *    Kompromiss, der keine der beiden Aufgaben löst — deshalb entscheidet der
 *    Dateityp über die Darstellung der Kachel.
 *
 *  • **Verknüpfte Dateien tragen eine Marke.** Ein Bild, das an einer Rechnung
 *    hängt, sieht aus wie jedes andere. Die Marke ist die einzige Chance, das
 *    vor dem Klick auf „Löschen" zu bemerken.
 *
 *  • **Kein Papierkorb.** Die Datei liegt im Objektspeicher und kostet dort
 *    Geld; eine Zeile ohne Datei wäre kein Papierkorb, sondern ein toter
 *    Verweis. Dafür fragt der Löschdialog deutlicher.
 */

export interface MediaRow {
  id: string;
  filename: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  scope: string;
  scopeLabel: string;
  isPublic: boolean;
  createdAt: string;
  /** Woran die Datei hängt — leer heisst frei löschbar. */
  attachments: string[];
}

export function MediaLibrary({
  files,
  canUpload,
  canUpdate,
  canDelete,
}: {
  files: MediaRow[];
  canUpload: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}) {
  const [renaming, setRenaming] = React.useState<MediaRow | null>(null);
  const [deleting, setDeleting] = React.useState<MediaRow | null>(null);

  if (files.length === 0) {
    return (
      <EmptyState
        icon={<Upload aria-hidden />}
        title="Keine Dateien gefunden"
        description={
          canUpload
            ? 'Setzen Sie die Filter zurück. Dateien entstehen beim Hochladen im Einsatzrapport, in der Bewerbung oder direkt hier.'
            : 'Setzen Sie die Filter zurück.'
        }
      />
    );
  }

  return (
    <>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {files.map((file) => (
          <li
            key={file.id}
            className="group flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-soft"
          >
            <Preview file={file} />

            <div className="flex flex-1 flex-col gap-2 p-4">
              <p className="line-clamp-2 break-words text-sm font-medium" title={file.filename}>
                {file.filename}
              </p>

              <p className="text-meta text-muted-foreground">
                {formatBytes(file.sizeBytes)} · {formatDate(new Date(file.createdAt))}
              </p>

              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="neutral" size="sm">
                  {file.scopeLabel}
                </Badge>
                {file.attachments.length > 0 ? (
                  <Badge variant="info" size="sm">
                    <Link2 className="size-3" aria-hidden />
                    verknüpft
                  </Badge>
                ) : null}
              </div>

              <div className="mt-auto flex items-center gap-0.5 pt-2">
                <Button asChild variant="ghost" size="icon-sm">
                  <a
                    href={file.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${file.filename} öffnen`}
                  >
                    <Download aria-hidden />
                  </a>
                </Button>

                {canUpdate ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${file.filename} umbenennen`}
                    onClick={() => setRenaming(file)}
                  >
                    <Pencil aria-hidden />
                  </Button>
                ) : null}

                {canDelete ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${file.filename} löschen`}
                    className="ml-auto text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setDeleting(file)}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ul>

      <RenameDialog file={renaming} onClose={() => setRenaming(null)} />
      <DeleteDialog file={deleting} onClose={() => setDeleting(null)} />
    </>
  );
}

function Preview({ file }: { file: MediaRow }) {
  const isImage = file.mimeType.startsWith('image/');

  if (!isImage) {
    return (
      <div className="flex h-32 items-center justify-center border-b border-border bg-muted/40">
        <FileText className="size-8 text-muted-foreground" aria-hidden />
        <span className="sr-only">Dokument</span>
      </div>
    );
  }

  return (
    <div className="relative h-32 border-b border-border bg-muted/40">
      {/*
        `unoptimized`: die Adressen kommen aus dem Objektspeicher und sind
        nicht in `next.config` als erlaubte Domäne hinterlegt. Der Optimierer
        würde sie abweisen — und in einer Verwaltungsansicht bringt er ohnehin
        wenig.
      */}
      <Image
        src={file.url}
        alt=""
        fill
        unoptimized
        sizes="(max-width: 640px) 100vw, 25vw"
        className="object-cover"
      />
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function RenameDialog({ file, onClose }: { file: MediaRow | null; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (file) {
      setName(file.filename);
      setError(null);
    }
  }, [file]);

  const save = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/api/media/${file.id}`, { filename: name.trim() });
      toast.success('Dateiname gespeichert.');
      onClose();
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Speichern fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={file !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Datei umbenennen</DialogTitle>
          <DialogDescription>
            Der Anzeigename ändert sich. Die Adresse der Datei bleibt bestehen — bereits geteilte
            Links funktionieren weiter.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <label htmlFor="media-name" className="text-sm font-medium">
            Dateiname
          </label>
          <Input
            id="media-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
        </div>

        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button onClick={save} loading={busy} disabled={name.trim().length === 0}>
            Speichern
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ file, onClose }: { file: MediaRow | null; onClose: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [force, setForce] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (file) {
      setForce(false);
      setError(null);
    }
  }, [file]);

  const linked = (file?.attachments.length ?? 0) > 0;

  const confirm = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await api.delete(`/api/media/${file.id}${force ? '?trotzdem=1' : ''}`);
      toast.success(`„${file.filename}" gelöscht.`);
      onClose();
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Löschen fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={file !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Datei endgültig löschen?</DialogTitle>
          <DialogDescription>
            Die Datei wird aus dem Speicher entfernt. Es gibt keinen Papierkorb und keine
            Wiederherstellung.
          </DialogDescription>
        </DialogHeader>

        {file ? (
          <div className={cn('rounded-xl bg-muted/50 p-4 text-sm', linked && 'space-y-3')}>
            <p className="break-words font-medium">{file.filename}</p>
            {linked ? (
              <p className="text-meta leading-relaxed text-warning">
                Diese Datei hängt an {file.attachments.join(' und ')}. Nach dem Löschen bleibt dort
                eine Lücke.
              </p>
            ) : null}
          </div>
        ) : null}

        {linked ? (
          <label className="flex cursor-pointer items-start gap-2.5 text-sm">
            <Checkbox checked={force} onCheckedChange={(checked) => setForce(checked === true)} />
            Ich weiss, dass die Datei an einem Beleg hängt, und will sie trotzdem löschen.
          </label>
        ) : null}

        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            variant="destructive"
            onClick={confirm}
            loading={busy}
            disabled={linked && !force}
          >
            Endgültig löschen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
