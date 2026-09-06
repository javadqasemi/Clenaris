'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2, FileUp, Loader2, Send } from 'lucide-react';
import { toast } from 'sonner';

import { cn, formatBytes } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import { jobApplicationSchema, type JobApplicationInput } from '@/lib/validation/crm';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/primitives';
import { Checkbox } from '@/components/ui/controls';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Label,
} from '@/components/ui/form';

/**
 * Bewerbungsformular.
 *
 * Bewusst kurz: Name, Kontakt, ein paar Sätze, Lebenslauf. Wer in der
 * Reinigungsbranche arbeitet, füllt kein zwanzigfeldriges Bewerbungsportal auf
 * dem Mobiltelefon aus — und wir brauchen für ein erstes Gespräch auch nicht
 * mehr.
 *
 * Der Lebenslauf geht per signierter URL direkt zu Supabase Storage.
 */
export function ApplicationForm({
  postingId,
  postingTitle,
}: {
  postingId: string;
  postingTitle: string;
}) {
  const [sent, setSent] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [file, setFile] = React.useState<{ name: string; size: number; url: string } | null>(null);

  const form = useForm<JobApplicationInput>({
    resolver: zodResolver(jobApplicationSchema),
    defaultValues: {
      postingId,
      firstName: '',
      lastName: '',
      email: '',
      phone: '',
      message: '',
      acceptPrivacy: false as unknown as true,
      website: '',
    },
  });

  const uploadCv = async (selected: File) => {
    setUploading(true);
    try {
      const target = await api.post<{ signedUrl: string; publicUrl: string }>(
        '/api/files/upload-url',
        {
          profile: 'cv',
          filename: selected.name,
          mimeType: selected.type,
          sizeBytes: selected.size,
          scopeId: postingId,
        },
      );

      const upload = await fetch(target.signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': selected.type, 'x-upsert': 'true' },
        body: selected,
      });
      if (!upload.ok) throw new Error('Upload fehlgeschlagen');

      setFile({ name: selected.name, size: selected.size, url: target.publicUrl });
      toast.success('Lebenslauf hochgeladen.');
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Die Datei konnte nicht hochgeladen werden.',
      );
    } finally {
      setUploading(false);
    }
  };

  const onSubmit = async (values: JobApplicationInput) => {
    setError(null);
    try {
      await api.post('/api/public/applications', { ...values, cvUrl: file?.url });
      setSent(true);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : 'Die Bewerbung konnte nicht gesendet werden. Bitte rufen Sie uns an.';
      setError(message);
      toast.error(message);
    }
  };

  if (sent) {
    return (
      <div className="space-y-4 rounded-2xl border border-success/25 bg-success/8 p-6 text-center">
        <CheckCircle2 className="mx-auto size-9 text-success" aria-hidden />
        <div className="space-y-1.5">
          <h2 className="font-display text-lg font-bold">Bewerbung angekommen</h2>
          <p className="text-sm leading-relaxed text-success/90">
            Wir sichten Ihre Unterlagen und melden uns innerhalb von fünf Arbeitstagen — auch wenn
            es diesmal nicht passt.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 rounded-2xl border border-border bg-card p-6 shadow-card">
      <div className="space-y-1">
        <h2 className="font-display text-lg font-semibold tracking-tight">Jetzt bewerben</h2>
        <p className="text-sm text-muted-foreground">Für: {postingTitle}</p>
      </div>

      {error ? <Alert variant="destructive">{error}</Alert> : null}

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="firstName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Vorname</FormLabel>
                  <FormControl>
                    <Input autoComplete="given-name" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="lastName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Nachname</FormLabel>
                  <FormControl>
                    <Input autoComplete="family-name" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>E-Mail</FormLabel>
                <FormControl>
                  <Input type="email" autoComplete="email" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="phone"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>Telefon</FormLabel>
                <FormControl>
                  <Input type="tel" autoComplete="tel" placeholder="079 123 45 67" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="message"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Ein paar Worte zu Ihnen</FormLabel>
                <FormControl>
                  <Textarea
                    rows={4}
                    placeholder="Was haben Sie bisher gemacht? Wann könnten Sie starten?"
                    {...field}
                    value={field.value ?? ''}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Lebenslauf */}
          <div className="space-y-2">
            <Label htmlFor="cv">Lebenslauf (optional)</Label>
            {file ? (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/40 p-3">
                <span className="min-w-0 truncate text-sm">
                  {file.name}{' '}
                  <span className="text-muted-foreground">({formatBytes(file.size)})</span>
                </span>
                <Button type="button" variant="ghost" size="sm" onClick={() => setFile(null)}>
                  Entfernen
                </Button>
              </div>
            ) : (
              <label
                htmlFor="cv"
                className={cn(
                  'flex cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border p-4 text-sm font-medium transition-colors',
                  'hover:border-primary/50 hover:bg-muted/40',
                  uploading && 'pointer-events-none opacity-60',
                )}
              >
                {uploading ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    Wird hochgeladen …
                  </>
                ) : (
                  <>
                    <FileUp className="size-4" aria-hidden />
                    PDF oder Word auswählen
                  </>
                )}
                <input
                  id="cv"
                  type="file"
                  accept=".pdf,.doc,.docx"
                  className="sr-only"
                  onChange={(event) => {
                    const selected = event.target.files?.[0];
                    if (selected) void uploadCv(selected);
                    event.target.value = '';
                  }}
                />
              </label>
            )}
            <FormDescription>Maximal 15 MB. Ohne Lebenslauf melden wir uns trotzdem.</FormDescription>
          </div>

          {/* Honigfalle */}
          <div aria-hidden className="absolute h-0 w-0 overflow-hidden">
            <input tabIndex={-1} autoComplete="off" {...form.register('website')} />
          </div>

          <FormField
            control={form.control}
            name="acceptPrivacy"
            render={({ field }) => (
              <FormItem>
                <label className="flex cursor-pointer items-start gap-2.5 text-sm leading-relaxed">
                  <Checkbox
                    checked={field.value}
                    onCheckedChange={(checked) => field.onChange(checked === true)}
                    className="mt-0.5"
                  />
                  <span className="text-muted-foreground">
                    Ich bin einverstanden, dass meine Unterlagen zur Prüfung gespeichert werden.{' '}
                    <a
                      href="/legal/datenschutz"
                      target="_blank"
                      className="underline underline-offset-2"
                    >
                      Datenschutz
                    </a>
                  </span>
                </label>
                <FormMessage />
              </FormItem>
            )}
          />

          <Button type="submit" width="full" size="lg" loading={form.formState.isSubmitting}>
            <Send aria-hidden />
            Bewerbung senden
          </Button>
        </form>
      </Form>
    </div>
  );
}
