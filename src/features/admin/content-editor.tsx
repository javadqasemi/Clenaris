'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import type { ContentDefinition, ContentGroup } from '@/lib/cms/registry';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/form';

/**
 * Redaktionsmaske für die Website-Texte.
 *
 * Architekturentscheide:
 *
 *  • **Die Maske erzeugt sich aus dem Register.** Kein Feld ist hier von Hand
 *    ausprogrammiert; ein neuer Baustein in `lib/cms/registry.ts` erscheint
 *    hier automatisch mit passendem Eingabefeld, Beschriftung und Hilfetext.
 *
 *  • **Nur Geändertes wird gesendet.** Das hält das Prüfprotokoll lesbar — es
 *    zeigt, was jemand tatsächlich angefasst hat, nicht die ganze Seite.
 *
 *  • **Der Standardtext ist immer erreichbar.** Neben jedem geänderten Feld
 *    steht „Zurücksetzen"; ein geleertes Feld stellt den Auslieferungstext
 *    wieder her. Niemand muss den ursprünglichen Wortlaut irgendwo
 *    nachschlagen.
 *
 *  • **Die Zeichenzahl steht daneben, nicht als Sperre.** Wer 62 statt 60
 *    Zeichen braucht, soll das sehen — abgewiesen wird erst, was das Layout
 *    wirklich sprengt.
 */
type Values = Record<string, string | string[]>;

export function ContentEditor({
  groups,
  initial,
  defaults,
}: {
  groups: ContentGroup[];
  /** Aktueller Stand: gepflegte Werte, sonst Standardtext. */
  initial: Values;
  /** Auslieferungsfassung je Schlüssel — für „Zurücksetzen". */
  defaults: Values;
}) {
  const router = useRouter();
  const [values, setValues] = React.useState<Values>(initial);
  const [saving, setSaving] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});

  const same = (a: string | string[], b: string | string[]) =>
    JSON.stringify(a) === JSON.stringify(b);

  const changedKeys = React.useMemo(
    () => Object.keys(values).filter((key) => !same(values[key], initial[key])),
    [values, initial],
  );

  const setValue = (key: string, value: string | string[]) => {
    setValues((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const save = async () => {
    if (changedKeys.length === 0) return;
    setSaving(true);
    setFieldErrors({});

    try {
      const result = await api.patch<{ updated: number; reset: number }>('/api/content', {
        entries: changedKeys.map((key) => ({ key, value: values[key] })),
      });

      toast.success(
        result.reset > 0
          ? `${result.updated} gespeichert, ${result.reset} auf Standard zurückgesetzt.`
          : `${result.updated} Textbaustein${result.updated === 1 ? '' : 'e'} gespeichert.`,
      );
      router.refresh();
    } catch (error) {
      if (error instanceof ApiError && error.fieldErrors.length > 0) {
        setFieldErrors(
          Object.fromEntries(error.fieldErrors.map((f) => [f.field, f.message])),
        );
        toast.error('Bitte prüfen Sie die markierten Felder.');
      } else {
        toast.error(
          error instanceof ApiError ? error.message : 'Speichern fehlgeschlagen.',
        );
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-8 pb-24">
      {groups.map((group) => (
        <section
          key={group.id}
          className="space-y-6 rounded-2xl border border-border bg-card p-6 shadow-soft"
          aria-labelledby={`group-${group.id}`}
        >
          <header className="space-y-1.5">
            <h2
              id={`group-${group.id}`}
              className="font-display text-base font-semibold tracking-tight"
            >
              {group.label}
            </h2>
            <p className="prose-measure text-meta leading-relaxed text-muted-foreground">
              {group.description}
            </p>
          </header>

          <div className="space-y-6">
            {group.items.map((item) => (
              <Field
                key={item.key}
                definition={item}
                value={values[item.key]}
                defaultValue={defaults[item.key]}
                error={fieldErrors[item.key]}
                changed={!same(values[item.key], initial[item.key])}
                onChange={(value) => setValue(item.key, value)}
                onReset={() => setValue(item.key, defaults[item.key])}
              />
            ))}
          </div>
        </section>
      ))}

      {/*
        Schwebende Leiste statt Knopf am Seitenende: die Maske ist lang, und
        wer oben etwas ändert, soll nicht bis unten scrollen müssen, um zu
        speichern. Sie erscheint erst, wenn es etwas zu speichern gibt.
      */}
      {changedKeys.length > 0 ? (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 backdrop-blur">
          <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-6">
            <p className="text-sm">
              <strong className="tabular-nums">{changedKeys.length}</strong>{' '}
              {changedKeys.length === 1 ? 'Änderung' : 'Änderungen'} noch nicht gespeichert
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setValues(initial)} disabled={saving}>
                Verwerfen
              </Button>
              <Button onClick={save} loading={saving}>
                <Save aria-hidden />
                Speichern
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Field({
  definition,
  value,
  defaultValue,
  error,
  changed,
  onChange,
  onReset,
}: {
  definition: ContentDefinition;
  value: string | string[];
  defaultValue: string | string[];
  error?: string;
  changed: boolean;
  onChange: (value: string | string[]) => void;
  onReset: () => void;
}) {
  const id = `content-${definition.key.replace(/\./g, '-')}`;
  const helpId = definition.help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;

  const isDefault = JSON.stringify(value) === JSON.stringify(defaultValue);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Label htmlFor={id} className="flex items-center gap-2">
          {definition.label}
          {changed ? (
            <span className="rounded-full bg-warning/12 px-2 py-0.5 text-2xs font-medium text-warning">
              geändert
            </span>
          ) : null}
        </Label>

        {!isDefault ? (
          <Button type="button" variant="ghost" size="sm" onClick={onReset}>
            <RotateCcw aria-hidden />
            Auf Standard
          </Button>
        ) : null}
      </div>

      {definition.kind === 'list' ? (
        <ListField
          id={id}
          items={Array.isArray(value) ? value : []}
          maxItems={definition.maxItems}
          maxLength={definition.maxLength}
          describedBy={[helpId, errorId].filter(Boolean).join(' ') || undefined}
          invalid={Boolean(error)}
          onChange={onChange}
        />
      ) : definition.kind === 'line' ? (
        <Input
          id={id}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
          maxLength={definition.maxLength ? definition.maxLength + 40 : undefined}
          aria-describedby={[helpId, errorId].filter(Boolean).join(' ') || undefined}
          aria-invalid={error ? true : undefined}
        />
      ) : (
        <Textarea
          id={id}
          rows={definition.kind === 'richtext' ? 8 : 4}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
          aria-describedby={[helpId, errorId].filter(Boolean).join(' ') || undefined}
          aria-invalid={error ? true : undefined}
        />
      )}

      <div className="flex flex-wrap items-baseline justify-between gap-3">
        {definition.help ? (
          <p id={helpId} className="text-meta leading-relaxed text-muted-foreground">
            {definition.help}
          </p>
        ) : (
          <span />
        )}

        {definition.maxLength && definition.kind !== 'list' ? (
          <CharCount
            current={typeof value === 'string' ? value.length : 0}
            max={definition.maxLength}
          />
        ) : null}
      </div>

      {error ? (
        <p id={errorId} role="alert" className="text-meta font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Zeichenzahl — warnt ab 90 %, sperrt aber nicht. */
function CharCount({ current, max }: { current: number; max: number }) {
  const ratio = current / max;
  return (
    <span
      className={cn(
        'shrink-0 text-2xs tabular-nums',
        ratio > 1 ? 'font-medium text-destructive' : ratio > 0.9 ? 'text-warning' : 'text-muted-foreground',
      )}
    >
      {current} / {max}
    </span>
  );
}

function ListField({
  id,
  items,
  maxItems,
  maxLength,
  describedBy,
  invalid,
  onChange,
}: {
  id: string;
  items: string[];
  maxItems?: number;
  maxLength?: number;
  describedBy?: string;
  invalid: boolean;
  onChange: (items: string[]) => void;
}) {
  const update = (index: number, text: string) =>
    onChange(items.map((item, i) => (i === index ? text : item)));

  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {items.map((item, index) => (
          <li key={index} className="flex items-start gap-2">
            <Input
              id={index === 0 ? id : undefined}
              value={item}
              onChange={(event) => update(index, event.target.value)}
              aria-label={`Eintrag ${index + 1}`}
              aria-describedby={index === 0 ? describedBy : undefined}
              aria-invalid={invalid && index === 0 ? true : undefined}
              maxLength={maxLength ? maxLength + 20 : undefined}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Eintrag ${index + 1} entfernen`}
              disabled={items.length <= 1}
              onClick={() => onChange(items.filter((_, i) => i !== index))}
            >
              <Trash2 aria-hidden />
            </Button>
          </li>
        ))}
      </ul>

      {!maxItems || items.length < maxItems ? (
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...items, ''])}>
          <Plus aria-hidden />
          Eintrag hinzufügen
        </Button>
      ) : (
        <p className="text-2xs text-muted-foreground">
          Höchstzahl erreicht ({maxItems}). Weitere Einträge würden das Layout sprengen.
        </p>
      )}
    </div>
  );
}
