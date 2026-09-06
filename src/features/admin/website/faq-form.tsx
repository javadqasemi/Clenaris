'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Save } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { createFaqSchema, type CreateFaqInput } from '@/lib/validation/website';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
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
 * Häufige Frage anlegen und bearbeiten.
 *
 * Die Kategorie ist ein Freitextfeld mit Vorschlägen und keine feste Liste:
 * welche Gruppen sinnvoll sind, hängt vom Betrieb ab und ändert sich mit dem
 * Leistungsangebot. Eine Auswahlliste wäre am Tag der zweiten Leistung falsch.
 */
export interface FaqRow {
  id: string;
  question: string;
  answer: string;
  category: string;
  locale: string;
  position: number;
  active: boolean;
}

const EMPTY: CreateFaqInput = {
  question: '',
  answer: '',
  category: 'Allgemein',
  locale: 'DE',
  position: 0,
  active: true,
};

const SUGGESTED_CATEGORIES = [
  'Allgemein',
  'Preise',
  'Termine',
  'Umzugsreinigung',
  'Abo und Kündigung',
  'Zahlung',
];

export function FaqForm({
  open,
  onOpenChange,
  faq,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  faq?: FaqRow;
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const listId = React.useId();

  const form = useForm<CreateFaqInput>({
    resolver: zodResolver(createFaqSchema),
    defaultValues: EMPTY,
  });

  React.useEffect(() => {
    if (!open) return;
    form.reset(
      faq
        ? {
            question: faq.question,
            answer: faq.answer,
            category: faq.category,
            locale: faq.locale as CreateFaqInput['locale'],
            position: faq.position,
            active: faq.active,
          }
        : EMPTY,
    );
    setError(null);
  }, [open, faq, form]);

  const onSubmit = async (values: CreateFaqInput) => {
    setError(null);
    try {
      if (faq) await api.patch(`/api/faq/${faq.id}`, values);
      else await api.post('/api/faq', values);
      toast.success('Frage gespeichert.');
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
          <DialogTitle>{faq ? 'Frage bearbeiten' : 'Neue Frage'}</DialogTitle>
          <DialogDescription>
            Erscheint auf <code>/faq</code> und in Auszügen auf der Startseite.
          </DialogDescription>
        </DialogHeader>

        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" noValidate>
            <FormField
              control={form.control}
              name="question"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Frage</FormLabel>
                  <FormControl>
                    <Input placeholder="Wie lange dauert eine Umzugsreinigung?" {...field} />
                  </FormControl>
                  <FormDescription>
                    So formuliert, wie sie am Telefon gestellt wird — danach wird auch gesucht.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="answer"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Antwort</FormLabel>
                  <FormControl>
                    <Textarea rows={6} {...field} />
                  </FormControl>
                  <FormDescription>
                    Konkret antworten. „Kommt darauf an&ldquo; beantwortet nichts und erzeugt einen
                    Anruf.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="category"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Kategorie</FormLabel>
                  <FormControl>
                    <Input list={listId} {...field} />
                  </FormControl>
                  <datalist id={listId}>
                    {SUGGESTED_CATEGORIES.map((category) => (
                      <option key={category} value={category} />
                    ))}
                  </datalist>
                  <FormDescription>Gruppiert die Fragen auf der Seite.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="active"
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
