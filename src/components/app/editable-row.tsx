'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, Lock, PenLine, X } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/controls';

/**
 * Eine Angabe, die sich an Ort und Stelle ändern lässt.
 *
 * Gestaltungsentscheide:
 *
 *  • **Bearbeiten ist ein Zustand der Zeile, kein eigener Ort.** Die
 *    Alternative wäre ein Dialog oder eine getrennte Bearbeitungsseite. Beide
 *    reissen den Blick aus dem Zusammenhang: Wer die Telefonnummer korrigiert,
 *    hat die Adresse darüber gerade gelesen und will sie im Blick behalten.
 *
 *  • **Der Stift erscheint erst beim Überfahren — ist aber immer im
 *    Dokument.** Dreissig Stifte gleichzeitig sichtbar machen aus einer
 *    Übersicht eine Werkzeugleiste. Ausgeblendet werden sie nur optisch: Für
 *    Tastatur und Screenreader sind sie durchgehend erreichbar, und sobald
 *    einer den Fokus hat, wird er sichtbar.
 *
 *  • **Gespeichert wird ein Feld, nicht das Formular.** Jede Zeile schickt nur
 *    ihren eigenen Wert. Das hält die Änderungsspur lesbar und verhindert,
 *    dass ein unbeteiligtes Feld mitgeschrieben wird, nur weil es im selben
 *    Formular stand.
 *
 *  • **Enter speichert, Escape verwirft.** Bei mehrzeiligen Feldern nicht —
 *    dort ist Enter ein Absatz, und ein Zeilenumbruch, der speichert, ist eine
 *    Falle.
 */

export type EditableFieldType = 'text' | 'email' | 'tel' | 'number' | 'date' | 'textarea' | 'select';

export interface EditableRowProps {
  label: string;
  /** Feldname im Anfragekörper. */
  name: string;
  /** Der gespeicherte Rohwert. */
  value: string | number | null;
  /** Darstellung im Lesezustand; ohne Angabe der Rohwert. */
  display?: React.ReactNode;
  endpoint: string;
  method?: 'PATCH' | 'PUT';
  type?: EditableFieldType;
  options?: { value: string; label: string }[];
  placeholder?: string;
  /** Kurzer Hinweis unter dem Feld — nur im Bearbeitungszustand. */
  hint?: string;
  /** Weitere Felder, die der Endpunkt zwingend verlangt. */
  extraPayload?: Record<string, unknown>;
  /** Ohne Recht bleibt die Zeile lesbar, aber ohne Stift. */
  canEdit?: boolean;
  /** Warum nicht bearbeitbar — erscheint statt des Stifts als Hinweis. */
  lockedReason?: string;
  required?: boolean;
}

export function EditableRow({
  label,
  name,
  value,
  display,
  endpoint,
  method = 'PATCH',
  type = 'text',
  options,
  placeholder,
  hint,
  extraPayload,
  canEdit = true,
  lockedReason,
  required,
}: EditableRowProps) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(String(value ?? ''));
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  const fieldId = `feld-${name.replace(/[^a-zA-Z0-9]/g, '-')}`;

  const open = () => {
    setDraft(String(value ?? ''));
    setError(null);
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    setError(null);
  };

  React.useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const save = async () => {
    const trimmed = draft.trim();

    if (required && trimmed === '') {
      setError('Dieses Feld darf nicht leer sein.');
      return;
    }

    // Nichts geändert: schliessen, ohne den Server zu behelligen und ohne
    // einen Eintrag in der Änderungsspur zu erzeugen.
    if (trimmed === String(value ?? '').trim()) {
      setEditing(false);
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const payload: Record<string, unknown> = { ...extraPayload };
      payload[name] =
        type === 'number' ? (trimmed === '' ? null : Number(trimmed)) : trimmed;

      await (method === 'PUT' ? api.put : api.patch)(endpoint, payload);

      toast.success(`${label} gespeichert.`);
      setEditing(false);
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Die Änderung konnte nicht gespeichert werden.';
      setError(message);
      // Kein `toast.error` zusätzlich: Der Fehler steht bereits am Feld, und
      // zwei Meldungen für einen Fehlschlag sind eine zu viel.
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
      return;
    }
    if (event.key === 'Enter' && type !== 'textarea') {
      event.preventDefault();
      void save();
    }
  };

  // `group/row` sitzt an der Zeile selbst, nicht an der Liste: Sonst
  // erschienen beim Überfahren einer Zeile die Stifte *aller* Zeilen.
  return (
    <div className={cn('protocol-row group/row', editing && 'protocol-row--editing')}>
      <div className="protocol-row-head">
        <dt className="protocol-label">
          <label htmlFor={editing ? fieldId : undefined}>{label}</label>
        </dt>

        {editing ? null : canEdit ? (
          <button
            type="button"
            onClick={open}
            aria-label={`${label} bearbeiten`}
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium',
              'text-muted-foreground opacity-0 transition-opacity',
              'hover:bg-muted hover:text-foreground focus-visible:opacity-100',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'group-hover/row:opacity-100',
            )}
          >
            <PenLine className="size-3" aria-hidden />
            Ändern
          </button>
        ) : lockedReason ? (
          <span
            className="inline-flex items-center gap-1 text-2xs text-muted-foreground"
            title={lockedReason}
          >
            <Lock className="size-3" aria-hidden />
            <span className="sr-only">{lockedReason}</span>
          </span>
        ) : null}
      </div>

      {editing ? (
        <dd className="space-y-2">
          {type === 'select' ? (
            <Select value={draft} onValueChange={setDraft}>
              <SelectTrigger id={fieldId} aria-invalid={error ? true : undefined}>
                <SelectValue placeholder={placeholder} />
              </SelectTrigger>
              <SelectContent>
                {options?.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : type === 'textarea' ? (
            <Textarea
              id={fieldId}
              ref={inputRef as React.Ref<HTMLTextAreaElement>}
              value={draft}
              rows={3}
              placeholder={placeholder}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              aria-invalid={error ? true : undefined}
            />
          ) : (
            <Input
              id={fieldId}
              ref={inputRef as React.Ref<HTMLInputElement>}
              type={type === 'number' ? 'text' : type}
              inputMode={type === 'number' ? 'decimal' : undefined}
              value={draft}
              placeholder={placeholder}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              aria-invalid={error ? true : undefined}
            />
          )}

          {error ? (
            <p role="alert" className="text-meta font-medium text-destructive">
              {error}
            </p>
          ) : hint ? (
            <p className="text-2xs leading-relaxed text-muted-foreground">{hint}</p>
          ) : null}

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={save} loading={saving}>
              <Check aria-hidden />
              Speichern
            </Button>
            <Button size="sm" variant="ghost" onClick={cancel} disabled={saving}>
              <X aria-hidden />
              Abbrechen
            </Button>
            {type !== 'textarea' && type !== 'select' ? (
              <span className="ml-auto hidden text-2xs text-muted-foreground sm:inline">
                Enter speichert · Esc bricht ab
              </span>
            ) : null}
          </div>
        </dd>
      ) : (
        <dd className="protocol-value">
          {display ?? (value === null || value === '' ? <Empty /> : String(value))}
        </dd>
      )}
    </div>
  );
}

/**
 * Der leere Wert.
 *
 * Ein Gedankenstrich statt einer leeren Zeile: Sonst sähe die Zeile aus, als
 * fehle etwas an der Darstellung, statt dass schlicht nichts hinterlegt ist.
 */
function Empty() {
  return <span className="font-normal text-muted-foreground">— nicht hinterlegt</span>;
}

/**
 * Umschlag für eine Liste von Angaben — bearbeitbar oder nicht.
 *
 * Nur eine Bequemlichkeit gegenüber `<dl className="protocol-list">`; die
 * Gruppe für den Stift sitzt an der Zeile, nicht hier.
 */
export function EditableList({
  children,
  tight,
  className,
}: {
  children: React.ReactNode;
  tight?: boolean;
  className?: string;
}) {
  return (
    <dl className={cn('protocol-list', tight && 'protocol-list--tight', className)}>
      {children}
    </dl>
  );
}
