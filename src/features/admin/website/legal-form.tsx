'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Save } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { LEGAL_LABELS, updateLegalSchema, type UpdateLegalInput } from '@/lib/validation/navigation';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/primitives';
import { Checkbox } from '@/components/ui/controls';
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

/**
 * Rechtstext bearbeiten.
 *
 * Ein Seitenpanel und kein Dialog: diese Texte sind lang, und ein Dialog, in
 * dem man auf zwölf Zeilen scrollt, macht das Redigieren zur Qual.
 *
 * Das Häkchen „neue Fassung" ist die einzige Stelle, an der ein Mensch
 * entscheiden muss und keine Automatik greifen darf: eine korrigierte
 * Kommasetzung ist keine neue Fassung, eine geänderte Aufbewahrungsfrist
 * schon. Die Fassungsnummer ist der Bezugspunkt, wenn jemand fragt, welchen
 * AGB er zugestimmt hat.
 */
export interface LegalRow {
  id: string | null;
  slug: string;
  title: string;
  body: string;
  version: number;
  effectiveFrom: string | null;
}

export function LegalForm({
  open,
  onOpenChange,
  document,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  document?: LegalRow;
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);

  const form = useForm<UpdateLegalInput>({
    resolver: zodResolver(updateLegalSchema),
    defaultValues: { title: '', body: '', effectiveFrom: '', newVersion: false },
  });

  React.useEffect(() => {
    if (!open || !document) return;
    form.reset({
      title: document.title,
      body: document.body,
      effectiveFrom: document.effectiveFrom
        ? new Date(document.effectiveFrom).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10),
      newVersion: false,
    });
    setError(null);
  }, [open, document, form]);

  const body = form.watch('body') ?? '';
  const newVersion = form.watch('newVersion');

  const onSubmit = async (values: UpdateLegalInput) => {
    if (!document) return;
    setError(null);
    try {
      await api.put(`/api/legal/${document.slug}`, values);
      toast.success(
        values.newVersion
          ? `Neue Fassung von „${LEGAL_LABELS[document.slug as keyof typeof LEGAL_LABELS]}" veröffentlicht.`
          : 'Text gespeichert.',
      );
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Speichern fehlgeschlagen.';
      setError(message);
      toast.error(message);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[min(52rem,96vw)]">
        <SheetHeader>
          <SheetTitle>
            {document
              ? (LEGAL_LABELS[document.slug as keyof typeof LEGAL_LABELS] ?? document.slug)
              : 'Rechtstext'}
          </SheetTitle>
          <SheetDescription>
            {document && document.version > 0
              ? `Aktuell Fassung ${document.version}. Ihr Text ersetzt die Seite vollständig.`
              : 'Noch nicht erfasst — die Website zeigt derzeit die eingebaute Auslieferungsfassung.'}
          </SheetDescription>
        </SheetHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="contents" noValidate>
            <SheetBody className="space-y-5 py-6">
              {error ? <Alert variant="destructive">{error}</Alert> : null}

              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Titel</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="body"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Text</FormLabel>
                    <FormControl>
                      <Textarea rows={22} className="font-mono text-sm leading-relaxed" {...field} />
                    </FormControl>
                    <FormDescription>
                      Markdown: <code>## Überschrift</code>, <code>- Aufzählung</code>,{' '}
                      <code>**fett**</code>, <code>[Text](/ziel)</code>. {body.length} Zeichen.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="effectiveFrom"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>In Kraft seit</FormLabel>
                    <FormControl>
                      <Input type="date" className="max-w-xs" {...field} />
                    </FormControl>
                    <FormDescription>
                      Steht unter dem Text auf der Website.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="newVersion"
                render={({ field }) => (
                  <FormItem>
                    <label
                      className={cnBorder(newVersion)}
                    >
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={(checked) => field.onChange(checked === true)}
                      />
                      <span className="space-y-1">
                        <span className="block font-medium">
                          Das ist eine neue Fassung
                          {document && document.version > 0
                            ? ` (dann Fassung ${document.version + 1})`
                            : ''}
                        </span>
                        <span className="block text-meta leading-relaxed text-muted-foreground">
                          Bei inhaltlichen Änderungen ankreuzen — geänderte Fristen, neue
                          Datenempfänger, andere Kündigungsregeln. Bei Tippfehlern und
                          Formulierungen nicht. Die Fassungsnummer ist der Bezugspunkt, wenn jemand
                          fragt, welcher Fassung er zugestimmt hat.
                        </span>
                      </span>
                    </label>
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
                {newVersion ? 'Neue Fassung veröffentlichen' : 'Speichern'}
              </Button>
            </SheetFooter>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  );
}

/** Der Rahmen färbt sich, sobald eine neue Fassung angekreuzt ist. */
function cnBorder(active: boolean): string {
  return [
    'flex cursor-pointer items-start gap-3 rounded-xl border p-4 text-sm transition-colors',
    active ? 'border-warning/40 bg-warning/5' : 'border-border',
  ].join(' ');
}
