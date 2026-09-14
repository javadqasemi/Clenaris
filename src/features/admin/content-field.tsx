'use client';

import * as React from 'react';
import { Plus, RotateCcw, Trash2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ContentDefinition } from '@/lib/cms/registry';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/form';
import { ImageField } from '@/features/admin/image-field';

/**
 * Ein einzelner Textbaustein als Eingabefeld.
 *
 * Seit die Texte direkt in der Vorschau getippt werden, ist das hier der Weg
 * für alles, was sich dort nicht tippen lässt: Listen, Texte mit Platzhalter,
 * Bausteine, die auf keiner Seite stehen. Die Maske entsteht aus dem Register
 * — kein Feld ist von Hand ausprogrammiert; ein neuer Baustein in
 * `lib/cms/registry.ts` bekommt automatisch das passende Eingabefeld,
 * Beschriftung und Hilfetext.
 *
 * **Der Standardtext ist immer erreichbar.** Neben einem geänderten Feld
 * steht „Auf Standard"; ein geleertes Feld stellt den Auslieferungstext
 * wieder her. Niemand muss den ursprünglichen Wortlaut irgendwo nachschlagen.
 *
 * **Die Zeichenzahl steht daneben, nicht als Sperre.** Wer 62 statt 60
 * Zeichen braucht, soll das sehen — abgewiesen wird erst, was das Layout
 * wirklich sprengt (auf dem Server, gegen dieselbe Grenze).
 */
export function ContentField({
  definition,
  value,
  defaultValue,
  error,
  autoFocus,
  onChange,
}: {
  definition: ContentDefinition;
  value: string | string[];
  /** Auslieferungsfassung — für „Auf Standard". */
  defaultValue: string | string[];
  error?: string;
  autoFocus?: boolean;
  onChange: (value: string | string[]) => void;
}) {
  const id = `content-${definition.key.replace(/\./g, '-')}`;
  const helpId = definition.help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(' ') || undefined;

  const isDefault = JSON.stringify(value) === JSON.stringify(defaultValue);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Label htmlFor={id}>{definition.label}</Label>

        {!isDefault ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(defaultValue)}>
            <RotateCcw aria-hidden />
            Auf Standard
          </Button>
        ) : null}
      </div>

      {definition.kind === 'image' ? (
        <ImageField
          id={id}
          value={typeof value === 'string' ? value : ''}
          onChange={onChange}
          describedBy={describedBy}
          invalid={Boolean(error)}
        />
      ) : definition.kind === 'list' ? (
        <ListField
          id={id}
          items={Array.isArray(value) ? value : []}
          maxItems={definition.maxItems}
          maxLength={definition.maxLength}
          describedBy={describedBy}
          invalid={Boolean(error)}
          autoFocus={autoFocus}
          onChange={onChange}
        />
      ) : definition.kind === 'line' ? (
        <Input
          id={id}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
          maxLength={definition.maxLength ? definition.maxLength + 40 : undefined}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          autoFocus={autoFocus}
        />
      ) : (
        <Textarea
          id={id}
          rows={definition.kind === 'richtext' ? 8 : 4}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          autoFocus={autoFocus}
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
export function CharCount({ current, max }: { current: number; max: number }) {
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
  autoFocus,
  onChange,
}: {
  id: string;
  items: string[];
  maxItems?: number;
  maxLength?: number;
  describedBy?: string;
  invalid: boolean;
  autoFocus?: boolean;
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
              autoFocus={autoFocus && index === 0}
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
