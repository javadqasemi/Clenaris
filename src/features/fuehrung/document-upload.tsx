'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Upload } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { DOCUMENT_CATEGORY_LABELS, DOCUMENT_VISIBILITY_LABELS, optionsOf } from '@/lib/bi/labels';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/form';
import { Alert } from '@/components/ui/primitives';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/controls';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/overlays';

/**
 * Datei in die Ablage bringen — als neue Akte oder als neue Fassung.
 *
 * Derselbe Weg wie bei Einsatzfotos: signierte Adresse holen, direkt zum
 * Speicher, dann registrieren. Die Datei läuft nie durch die Anwendung. Das
 * Profil `document` erlaubt PDF, Office und Bilder bis 25 MB.
 */

interface Uploaded {
  path: string;
  url: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

async function uploadFile(file: File): Promise<Uploaded> {
  const target = await api.post<{ path: string; signedUrl: string; publicUrl: string }>('/api/files/upload-url', {
    profile: 'document',
    filename: file.name,
    mimeType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
  });
  const response = await fetch(target.signedUrl, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'true' }, body: file });
  if (!response.ok) throw new Error('Der Upload wurde vom Speicher abgelehnt.');
  return { path: target.path, url: target.publicUrl, filename: file.name, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size };
}

export function DocumentUploadDialog({
  mode,
  documentId,
  employees,
  suppliers,
}: {
  mode: 'create' | 'version';
  documentId?: string;
  employees?: { id: string; name: string }[];
  suppliers?: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [file, setFile] = React.useState<File | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [form, setForm] = React.useState({ title: '', category: 'OTHER', visibility: '', description: '', tags: '', subjectEmployeeId: '', supplierId: '', validFrom: '', expiresOn: '', reminderDaysBefore: '30', changeNote: '' });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (mode === 'version' && !file) {
      setError('Bitte eine Datei wählen.');
      return;
    }
    if (mode === 'create' && form.title.trim().length < 2) {
      setError('Bitte einen Titel angeben.');
      return;
    }
    setBusy(true);
    try {
      const uploaded = file ? await uploadFile(file) : undefined;
      if (mode === 'version') {
        await api.post(`/api/bi/documents/${documentId}/versions`, { file: uploaded, changeNote: form.changeNote || undefined });
        toast.success('Neue Fassung hochgeladen.');
      } else {
        const created = await api.post<{ id: string }>('/api/bi/documents', {
          title: form.title.trim(),
          category: form.category,
          visibility: form.visibility || undefined,
          description: form.description || undefined,
          tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
          subjectEmployeeId: form.subjectEmployeeId || undefined,
          supplierId: form.supplierId || undefined,
          validFrom: form.validFrom || undefined,
          expiresOn: form.expiresOn || undefined,
          reminderDaysBefore: Number(form.reminderDaysBefore) || 30,
          file: uploaded,
          changeNote: form.changeNote || undefined,
        });
        toast.success('Dokument abgelegt.');
        router.push(`/admin/fuehrung/dokumente/${created.id}`);
      }
      setOpen(false);
      setFile(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Upload fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={mode === 'version' ? 'outline' : 'default'} size={mode === 'version' ? 'sm' : undefined}>
          <Upload aria-hidden />
          {mode === 'version' ? 'Neue Fassung' : 'Dokument ablegen'}
        </Button>
      </DialogTrigger>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{mode === 'version' ? 'Neue Fassung hochladen' : 'Dokument ablegen'}</DialogTitle>
          <DialogDescription>
            {mode === 'version'
              ? 'Die neue Datei wird die geltende Fassung; ältere bleiben erhalten.'
              : 'Personaldokumente sind ohne andere Angabe nur für die betroffene Person und die Geschäftsleitung sichtbar.'}
          </DialogDescription>
        </DialogHeader>
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        <form onSubmit={submit} className="space-y-4" noValidate>
          {mode === 'create' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="doc-title" required>Titel</Label>
                <Input id="doc-title" value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="z. B. Haftpflichtversicherung 2026" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="doc-category">Kategorie</Label>
                <Select value={form.category} onValueChange={(v) => set('category', v)}>
                  <SelectTrigger id="doc-category"><SelectValue /></SelectTrigger>
                  <SelectContent>{optionsOf(DOCUMENT_CATEGORY_LABELS).map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="doc-visibility">Sichtbarkeit</Label>
                <Select value={form.visibility || '__auto__'} onValueChange={(v) => set('visibility', v === '__auto__' ? '' : v)}>
                  <SelectTrigger id="doc-visibility"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__auto__">Automatisch nach Kategorie</SelectItem>
                    {optionsOf(DOCUMENT_VISIBILITY_LABELS).map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {employees?.length ? (
                <div className="space-y-2">
                  <Label htmlFor="doc-employee">Betroffene Person</Label>
                  <Select value={form.subjectEmployeeId || '__none__'} onValueChange={(v) => set('subjectEmployeeId', v === '__none__' ? '' : v)}>
                    <SelectTrigger id="doc-employee"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Keine</SelectItem>
                      {employees.map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              {suppliers?.length ? (
                <div className="space-y-2">
                  <Label htmlFor="doc-supplier">Lieferant</Label>
                  <Select value={form.supplierId || '__none__'} onValueChange={(v) => set('supplierId', v === '__none__' ? '' : v)}>
                    <SelectTrigger id="doc-supplier"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Keiner</SelectItem>
                      {suppliers.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              <div className="space-y-2">
                <Label htmlFor="doc-valid">Gültig ab</Label>
                <Input id="doc-valid" type="date" value={form.validFrom} onChange={(e) => set('validFrom', e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="doc-expires">Läuft ab am</Label>
                <Input id="doc-expires" type="date" value={form.expiresOn} onChange={(e) => set('expiresOn', e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="doc-reminder">Erinnerung Tage vorher</Label>
                <Input id="doc-reminder" inputMode="numeric" value={form.reminderDaysBefore} onChange={(e) => set('reminderDaysBefore', e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="doc-tags">Schlagwörter</Label>
                <Input id="doc-tags" value={form.tags} onChange={(e) => set('tags', e.target.value)} placeholder="Mit Komma trennen" />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="doc-description">Beschreibung</Label>
                <Textarea id="doc-description" rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} />
              </div>
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="doc-file" required={mode === 'version'}>Datei {mode === 'create' ? '(optional)' : ''}</Label>
            <Input id="doc-file" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <p className="text-meta text-muted-foreground">PDF, Word, Excel, Text oder Bild, bis 25 MB.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="doc-note">Änderungsnotiz</Label>
            <Input id="doc-note" value={form.changeNote} onChange={(e) => set('changeNote', e.target.value)} placeholder="Was ist neu an dieser Fassung?" />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Abbrechen</Button>
            <Button type="submit" loading={busy}>{mode === 'version' ? 'Hochladen' : 'Ablegen'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
