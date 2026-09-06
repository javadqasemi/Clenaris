'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Camera, Check, Loader2, PenLine, Plus, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';

import { cn, formatCurrency } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/form';
import { Alert, Progress } from '@/components/ui/primitives';
import { Checkbox } from '@/components/ui/controls';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/overlays';
import { SignaturePad } from '@/features/portal/signature-pad';

/**
 * Arbeitsfläche für den Einsatz vor Ort.
 *
 * Architekturentscheide:
 *  • Checklistenpunkte werden *optimistisch* abgehakt. Auf einer Baustelle mit
 *    schlechtem Empfang darf ein Häkchen nicht eine Sekunde hängen; schlägt der
 *    Request fehl, springt der Punkt zurück und es erscheint ein Hinweis.
 *  • Fotos laden direkt zu Supabase Storage — der Umweg über die Applikation
 *    würde bei Baustellenfotos (oft 5–10 MB) am Body-Limit scheitern.
 *  • Der Abschluss verlangt alle Pflichtpunkte. Das ist keine Schikane: die
 *    Checkliste ist der Nachweis gegenüber der Kundschaft.
 */

export interface ChecklistItemDto {
  id: string;
  label: string;
  room: string | null;
  required: boolean;
  done: boolean;
  note: string | null;
}

export interface JobPhotoDto {
  id: string;
  type: string;
  url: string;
  thumbnailUrl: string | null;
  caption: string | null;
  room: string | null;
}

export function JobWorkspace({
  jobId,
  checklist: initialChecklist,
  photos: initialPhotos,
  status,
  canComplete,
}: {
  jobId: string;
  checklist: ChecklistItemDto[];
  photos: JobPhotoDto[];
  status: string;
  canComplete: boolean;
}) {
  const router = useRouter();
  const [checklist, setChecklist] = React.useState(initialChecklist);
  const [photos, setPhotos] = React.useState(initialPhotos);
  const [uploading, setUploading] = React.useState<string | null>(null);
  const [completeOpen, setCompleteOpen] = React.useState(false);

  const done = checklist.filter((item) => item.done).length;
  const openRequired = checklist.filter((item) => item.required && !item.done);
  const isClosed = ['COMPLETED', 'VERIFIED', 'CANCELLED'].includes(status);

  const toggle = async (item: ChecklistItemDto, next: boolean) => {
    // Optimistisch umschalten.
    setChecklist((current) =>
      current.map((entry) => (entry.id === item.id ? { ...entry, done: next } : entry)),
    );

    try {
      await api.post(`/api/jobs/checklist/${item.id}`, { done: next });
    } catch (error) {
      setChecklist((current) =>
        current.map((entry) => (entry.id === item.id ? { ...entry, done: !next } : entry)),
      );
      toast.error(
        error instanceof ApiError
          ? error.message
          : 'Der Punkt konnte nicht gespeichert werden. Bitte erneut versuchen.',
      );
    }
  };

  const uploadPhoto = async (file: File, type: 'BEFORE' | 'AFTER') => {
    setUploading(type);
    try {
      // 1) Signierte Upload-Adresse vom Server holen.
      const target = await api.post<{ path: string; signedUrl: string; publicUrl: string; token: string }>(
        '/api/files/upload-url',
        {
          profile: 'jobPhoto',
          filename: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          scopeId: jobId,
        },
      );

      // 2) Direkt zu Supabase hochladen.
      const upload = await fetch(target.signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type, 'x-upsert': 'true' },
        body: file,
      });
      if (!upload.ok) throw new Error('Upload fehlgeschlagen');

      // 3) Foto am Einsatz registrieren.
      const photo = await api.post<JobPhotoDto>(`/api/jobs/${jobId}/photos`, {
        type,
        url: target.publicUrl,
      });

      setPhotos((current) => [photo, ...current]);
      toast.success(`${type === 'BEFORE' ? 'Vorher' : 'Nachher'}-Foto hochgeladen.`);
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : 'Das Foto konnte nicht hochgeladen werden. Prüfe die Verbindung.',
      );
    } finally {
      setUploading(null);
    }
  };

  return (
    <div className="space-y-8">
      {/* Checkliste */}
      <section className="space-y-4" aria-label="Checkliste">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="font-display text-lg font-semibold tracking-tight">Checkliste</h2>
          <span className="text-sm tabular-nums text-muted-foreground">
            {done} von {checklist.length}
          </span>
        </div>

        {checklist.length > 0 ? (
          <Progress
            value={(done / checklist.length) * 100}
            aria-label={`${done} von ${checklist.length} Punkten erledigt`}
          />
        ) : null}

        <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
          {checklist.map((item) => (
            <li key={item.id}>
              <label
                className={cn(
                  'flex cursor-pointer items-start gap-4 p-4 transition-colors',
                  isClosed ? 'cursor-default' : 'hover:bg-muted/40',
                )}
              >
                <Checkbox
                  checked={item.done}
                  disabled={isClosed}
                  onCheckedChange={(checked) => toggle(item, checked === true)}
                  className="mt-0.5 size-6"
                />
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      'block leading-snug',
                      item.done && 'text-muted-foreground line-through',
                    )}
                  >
                    {item.room ? <span className="font-medium">{item.room}: </span> : null}
                    {item.label}
                  </span>
                  {!item.required ? (
                    <span className="mt-0.5 block text-xs text-muted-foreground">optional</span>
                  ) : null}
                  {item.note ? (
                    <span className="mt-0.5 block text-xs text-muted-foreground">{item.note}</span>
                  ) : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </section>

      {/* Fotos */}
      <section className="space-y-4" aria-label="Fotos">
        <h2 className="font-display text-lg font-semibold tracking-tight">Fotos</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Vorher- und Nachher-Fotos dokumentieren deine Arbeit. Die Kundschaft erhält sie mit dem
          Einsatzbericht.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          {(['BEFORE', 'AFTER'] as const).map((type) => {
            const group = photos.filter((photo) => photo.type === type);
            return (
              <div key={type} className="space-y-3 rounded-2xl border border-border bg-card p-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-medium">{type === 'BEFORE' ? 'Vorher' : 'Nachher'}</h3>
                  <span className="text-sm tabular-nums text-muted-foreground">{group.length}</span>
                </div>

                {group.length > 0 ? (
                  <ul className="grid grid-cols-3 gap-2">
                    {group.slice(0, 6).map((photo) => (
                      <li key={photo.id}>
                        <a href={photo.url} target="_blank" rel="noreferrer">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={photo.thumbnailUrl ?? photo.url}
                            alt={photo.caption ?? `${type === 'BEFORE' ? 'Vorher' : 'Nachher'}-Aufnahme`}
                            className="aspect-square w-full rounded-lg object-cover"
                            loading="lazy"
                          />
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {!isClosed ? (
                  <label
                    className={cn(
                      'flex cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border p-4 text-sm font-medium transition-colors',
                      'hover:border-primary/50 hover:bg-muted/40',
                      uploading === type && 'pointer-events-none opacity-60',
                    )}
                  >
                    {uploading === type ? (
                      <>
                        <Loader2 className="size-4 animate-spin" aria-hidden />
                        Wird hochgeladen …
                      </>
                    ) : (
                      <>
                        <Camera className="size-4" aria-hidden />
                        Foto aufnehmen
                      </>
                    )}
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="sr-only"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void uploadPhoto(file, type);
                        event.target.value = '';
                      }}
                    />
                  </label>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      {/* Abschluss */}
      {!isClosed && canComplete ? (
        <section className="space-y-3">
          {openRequired.length > 0 ? (
            <Alert variant="warning" title={`Noch ${openRequired.length} Pflichtpunkte offen`}>
              {openRequired
                .slice(0, 3)
                .map((item) => item.label)
                .join(' · ')}
              {openRequired.length > 3 ? ' …' : ''}
            </Alert>
          ) : null}

          <Button
            size="xl"
            width="full"
            disabled={openRequired.length > 0}
            onClick={() => setCompleteOpen(true)}
          >
            <Check aria-hidden />
            Einsatz abschliessen
          </Button>
        </section>
      ) : null}

      <CompleteDialog
        jobId={jobId}
        open={completeOpen}
        onOpenChange={setCompleteOpen}
        onDone={() => router.refresh()}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Abschlussdialog
// ---------------------------------------------------------------------------

interface MaterialRow {
  name: string;
  quantity: string;
  unit: string;
  unitCost: string;
  billable: boolean;
}

function CompleteDialog({
  jobId,
  open,
  onOpenChange,
  onDone,
}: {
  jobId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [note, setNote] = React.useState('');
  const [signatureName, setSignatureName] = React.useState('');
  const [signature, setSignature] = React.useState<string | null>(null);
  const [materials, setMaterials] = React.useState<MaterialRow[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.post(`/api/jobs/${jobId}/complete`, {
        completionNote: note || undefined,
        signatureDataUrl: signature ?? undefined,
        signatureName: signatureName || undefined,
        materials: materials
          .filter((row) => row.name.trim() && Number(row.quantity) > 0)
          .map((row) => ({
            name: row.name.trim(),
            quantity: Number(row.quantity),
            unit: row.unit || 'Stk.',
            unitCost: Number(row.unitCost) || 0,
            billable: row.billable,
          })),
      });

      toast.success('Einsatz abgeschlossen. Danke!');
      onOpenChange(false);
      onDone();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Der Abschluss konnte nicht gespeichert werden.';
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const materialTotal = materials.reduce(
    (sum, row) => sum + (Number(row.quantity) || 0) * (Number(row.unitCost) || 0),
    0,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Einsatz abschliessen</DialogTitle>
          <DialogDescription>
            Halte fest, was erledigt wurde. Ist jemand vor Ort, lass die Arbeit direkt hier
            unterschreiben — das erspart später Diskussionen.
          </DialogDescription>
        </DialogHeader>

        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <div className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="completion-note">Bemerkungen</Label>
            <Textarea
              id="completion-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              placeholder="z. B. Backofen war stark verschmutzt, zusätzliche 30 Minuten benötigt."
            />
          </div>

          {/* Material */}
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <Label>Verwendetes Material</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setMaterials((current) => [
                    ...current,
                    { name: '', quantity: '1', unit: 'Stk.', unitCost: '0', billable: false },
                  ])
                }
              >
                <Plus aria-hidden />
                Position
              </Button>
            </div>

            {materials.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Kein Material erfasst. Nur nötig, wenn etwas verrechnet oder nachbestellt werden soll.
              </p>
            ) : (
              <ul className="space-y-2">
                {materials.map((row, index) => (
                  <li key={index} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_5rem_4rem_6rem_auto]">
                    <Input
                      value={row.name}
                      onChange={(event) =>
                        setMaterials((current) =>
                          current.map((item, i) =>
                            i === index ? { ...item, name: event.target.value } : item,
                          ),
                        )
                      }
                      placeholder="Bezeichnung"
                      aria-label={`Material ${index + 1}: Bezeichnung`}
                    />
                    <Input
                      inputMode="decimal"
                      value={row.quantity}
                      onChange={(event) =>
                        setMaterials((current) =>
                          current.map((item, i) =>
                            i === index ? { ...item, quantity: event.target.value } : item,
                          ),
                        )
                      }
                      aria-label={`Material ${index + 1}: Menge`}
                    />
                    <Input
                      value={row.unit}
                      onChange={(event) =>
                        setMaterials((current) =>
                          current.map((item, i) =>
                            i === index ? { ...item, unit: event.target.value } : item,
                          ),
                        )
                      }
                      aria-label={`Material ${index + 1}: Einheit`}
                    />
                    <Input
                      inputMode="decimal"
                      value={row.unitCost}
                      onChange={(event) =>
                        setMaterials((current) =>
                          current.map((item, i) =>
                            i === index ? { ...item, unitCost: event.target.value } : item,
                          ),
                        )
                      }
                      suffix="CHF"
                      aria-label={`Material ${index + 1}: Preis`}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() =>
                        setMaterials((current) => current.filter((_, i) => i !== index))
                      }
                      aria-label={`Material ${index + 1} entfernen`}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            {materialTotal > 0 ? (
              <p className="text-right text-sm tabular-nums text-muted-foreground">
                Materialkosten: {formatCurrency(materialTotal)}
              </p>
            ) : null}
          </div>

          {/* Unterschrift */}
          <div className="space-y-3">
            <Label>Abnahme durch die Kundschaft (optional)</Label>
            <Input
              value={signatureName}
              onChange={(event) => setSignatureName(event.target.value)}
              placeholder="Name der unterschreibenden Person"
              aria-label="Name der unterschreibenden Person"
            />
            <SignaturePad value={signature} onChange={setSignature} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button onClick={submit} loading={saving}>
            <Upload aria-hidden />
            Abschliessen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { PenLine };
