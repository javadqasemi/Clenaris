'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import { Button, type ButtonProps } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/form';
import { Alert } from '@/components/ui/primitives';
import type { TextAssistKontext } from '@/lib/validation/ai';
import { TextAssist } from '@/components/app/text-assist';
import {
  Checkbox,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/controls';
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
 * Formular aus einer Feldbeschreibung.
 *
 * **Warum eine Beschreibung statt vierzig handgeschriebener Formulare.** Die
 * Anwendung hat Dutzende Datensatzarten mit je fünf bis zwanzig Feldern.
 * Vierzig Formulare von Hand hiesse vierzig Mal dieselbe Fehlerbehandlung,
 * dieselbe Umwandlung von leeren Strings in `undefined` und dieselbe
 * Zahlenprüfung — und jede Abweichung wäre ein Fehler, der nur in einer Maske
 * auftritt. Die Beschreibung hält die Felder; das Formular hält die Regeln
 * genau einmal.
 *
 * Die Prüfung der Werte bleibt beim Server: Das Zod-Schema in
 * `lib/validation/` ist die Wahrheit, Feldfehler kommen von dort zurück und
 * werden am Feld angezeigt. Das Formular prüft nur, was ohne Rundreise
 * offensichtlich ist (Pflichtfelder). Das ist keine Nachlässigkeit, sondern
 * die Regel: Wer sich auf eine Prüfung im Browser verliesse, hätte zwei
 * Wahrheiten, und die schwächere davon wäre die, die ein Angreifer sieht.
 *
 * Ursprünglich im Bereich Unternehmensführung entstanden; die dortige Datei
 * exportiert diese Bausteine weiter, damit bestehende Importe stehen bleiben.
 */

export type FieldSpec = {
  name: string;
  label: string;
  type?:
    | 'text'
    | 'textarea'
    | 'number'
    | 'date'
    | 'datetime'
    | 'select'
    | 'checkbox'
    | 'tags'
    | 'email'
    | 'url'
    | 'tel'
    | 'time';
  options?: { value: string; label: string }[];
  placeholder?: string;
  hint?: string;
  required?: boolean;
  /** Halbe Breite im Raster. */
  half?: boolean;
  suffix?: string;
  /** Leerer Wert erlaubt — wird als `null` gesendet (für das Leeren beim Bearbeiten). */
  nullable?: boolean;
  /**
   * Leerer Wert wird als leere Zeichenkette gesendet statt weggelassen.
   * Für Endpunkte, die `''` als „Feld leeren" verstehen (`.or(z.literal(''))`).
   */
  emptyAsString?: boolean;
  min?: number;
  max?: number;
  step?: number;
  rows?: number;
  /**
   * KI-Textassistent am Feld (nur `text` und `textarea`), mit der Feldart
   * aus der Erlaubnisliste. **Opt-in, nie Vorgabe:** Ein Assistent an jedem
   * Textfeld hätte ihn auch an Lohn-, Bank- und Notizfeldern angeboten, deren
   * Inhalt das Haus nicht verlassen soll. Wer ihn setzt, entscheidet das für
   * genau dieses Feld (`docs/KI_GOVERNANCE.md`, Textassistent).
   */
  textAssist?: TextAssistKontext;
};

export type FieldValues = Record<string, unknown>;

function initial(fields: FieldSpec[], values?: FieldValues): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const f of fields) {
    const v = values?.[f.name];
    if (f.type === 'checkbox') out[f.name] = Boolean(v);
    else if (f.type === 'tags') out[f.name] = Array.isArray(v) ? v.join(', ') : '';
    else if (f.type === 'date') out[f.name] = v ? String(v).slice(0, 10) : '';
    else if (f.type === 'datetime') out[f.name] = v ? toLocalInput(new Date(String(v))) : '';
    else out[f.name] = v === null || v === undefined ? '' : String(v);
  }
  return out;
}

function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Aus den Feldwerten den Anfragekörper bauen — Zahlen als Zahlen, Leeres weg. */
export function buildPayload(
  fields: FieldSpec[],
  state: Record<string, string | boolean>,
  editing: boolean,
): FieldValues {
  const payload: FieldValues = {};
  for (const f of fields) {
    const raw = state[f.name];
    if (f.type === 'checkbox') {
      payload[f.name] = Boolean(raw);
      continue;
    }
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text === '') {
      if (editing && f.nullable) payload[f.name] = null;
      else if (f.emptyAsString) payload[f.name] = '';
      else if (f.type === 'tags' && editing) payload[f.name] = [];
      continue;
    }
    switch (f.type) {
      case 'number':
        payload[f.name] = Number(text.replace(',', '.'));
        break;
      case 'tags':
        payload[f.name] = text
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
        break;
      case 'datetime':
        payload[f.name] = new Date(text).toISOString();
        break;
      default:
        payload[f.name] = text;
    }
  }
  return payload;
}

export interface ResourceFormProps {
  fields: FieldSpec[];
  /** Vorbelegung — beim Bearbeiten die gespeicherten Werte. */
  values?: FieldValues;
  /** Feste Werte, die immer mitgesendet werden (z. B. `customerId`). */
  extra?: FieldValues;
  endpoint: string;
  method?: 'POST' | 'PATCH' | 'PUT';
  submitLabel?: string;
  onCancel?: () => void;
  /** Nach Erfolg: Adresse (mit `{id}` aus der Antwort) oder nur neu laden. */
  redirectTo?: string;
  successMessage?: string;
  onSuccess?: (data: unknown) => void;
  className?: string;
  /**
   * Letzter Umbau vor dem Senden — für Endpunkte, die eine verschachtelte
   * Form verlangen (etwa `actions: [{ type, config }]`), die ein flaches
   * Formular nicht direkt liefert. Läuft *nach* `buildPayload` und `extra`.
   */
  transform?: (payload: FieldValues) => FieldValues;
  /**
   * Wird bei jeder Eingabe mit Feldname und neuem Wert gerufen — für Felder,
   * deren Auswahl von einem anderen abhängt (Objekte der gewählten
   * Kundschaft).
   *
   * Nicht `transform` dafür missbrauchen: `transform` läuft erst beim Senden.
   * Die Vertragsmaske tat genau das, und die Objektliste blieb leer, bis
   * jemand einmal auf „Vertrag anlegen" geklickt hatte (gefunden von der
   * Browserreihe am 2026-09-23).
   */
  onFieldChange?: (name: string, value: string | boolean) => void;
}

export function ResourceForm({
  fields,
  values,
  extra,
  endpoint,
  method = 'POST',
  submitLabel = 'Speichern',
  onCancel,
  redirectTo,
  successMessage = 'Gespeichert.',
  onSuccess,
  className,
  transform,
  onFieldChange,
}: ResourceFormProps) {
  const router = useRouter();
  const editing = method !== 'POST';
  const [state, setState] = React.useState(() => initial(fields, values));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const id = React.useId();

  const set = (name: string, value: string | boolean) => {
    setState((s) => ({ ...s, [name]: value }));
    onFieldChange?.(name, value);
  };

  /*
    Nach einem abgewiesenen Senden steht der Fokus im ersten fehlerhaften
    Feld (2026-09-27). Vorher blieb er auf dem Knopf: Wer mit der Tastatur
    oder einem Screenreader arbeitet, hörte „Pflichtfeld" irgendwo weiter oben
    und musste das Feld selbst suchen.
  */
  const fehlerFokus = React.useRef(false);
  React.useEffect(() => {
    if (!fehlerFokus.current) return;
    fehlerFokus.current = false;
    const erstes = fields.find((f) => errors[f.name]);
    if (erstes) document.getElementById(`${id}-${erstes.name}`)?.focus();
  }, [errors, fields, id]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setErrors({});
    const missing = fields.filter(
      (f) => f.required && f.type !== 'checkbox' && !String(state[f.name] ?? '').trim(),
    );
    if (missing.length > 0) {
      fehlerFokus.current = true;
      setErrors(Object.fromEntries(missing.map((f) => [f.name, 'Pflichtfeld'])));
      return;
    }
    setSaving(true);
    try {
      const raw = { ...buildPayload(fields, state, editing), ...extra };
      const payload = transform ? transform(raw) : raw;
      const data =
        method === 'POST'
          ? await api.post<{ id?: string }>(endpoint, payload)
          : method === 'PATCH'
            ? await api.patch<{ id?: string }>(endpoint, payload)
            : await api.put<{ id?: string }>(endpoint, payload);
      toast.success(successMessage);
      onSuccess?.(data);
      if (redirectTo) {
        router.push(redirectTo.replace('{id}', String((data as { id?: string })?.id ?? '')));
      }
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        if (err.fieldErrors.length) {
          fehlerFokus.current = true;
          setErrors(Object.fromEntries(err.fieldErrors.map((e) => [e.field, e.message])));
        }
      } else {
        setError('Speichern fehlgeschlagen. Bitte erneut versuchen.');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className={cn('space-y-5', className)} noValidate>
      {error ? <Alert variant="destructive">{error}</Alert> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map((f) => {
          const fieldId = `${id}-${f.name}`;
          const value = state[f.name];
          const message = errors[f.name];
          // Fehler oder Hinweis gehören zum Feld, nicht nur optisch darunter:
          // Der Screenreader liest sie mit, wenn das Feld den Fokus bekommt.
          const hinweisId = message || f.hint ? `${fieldId}-hinweis` : undefined;
          return (
            <div key={f.name} className={cn('space-y-2', !f.half && 'sm:col-span-2')}>
              {f.type === 'checkbox' ? (
                <label className="flex cursor-pointer items-center gap-2.5 pt-2 text-sm">
                  <Checkbox
                    id={fieldId}
                    checked={Boolean(value)}
                    onCheckedChange={(c) => set(f.name, c === true)}
                    aria-describedby={hinweisId}
                  />
                  {f.label}
                </label>
              ) : (
                <>
                  {f.textAssist && (f.type === undefined || f.type === 'text' || f.type === 'textarea') ? (
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor={fieldId} required={f.required}>
                        {f.label}
                      </Label>
                      <TextAssist
                        kontext={f.textAssist}
                        feldId={fieldId}
                        feldLabel={f.label}
                        value={String(value ?? '')}
                        onChange={(neu) => set(f.name, neu)}
                        className="-my-1.5"
                      />
                    </div>
                  ) : (
                    <Label htmlFor={fieldId} required={f.required}>
                      {f.label}
                    </Label>
                  )}
                  {f.type === 'textarea' ? (
                    <Textarea
                      id={fieldId}
                      rows={f.rows ?? 4}
                      value={String(value ?? '')}
                      placeholder={f.placeholder}
                      onChange={(e) => set(f.name, e.target.value)}
                      invalid={Boolean(message)}
                      aria-describedby={hinweisId}
                    />
                  ) : f.type === 'select' ? (
                    <Select
                      value={String(value ?? '') || '__none__'}
                      onValueChange={(v) => set(f.name, v === '__none__' ? '' : v)}
                    >
                      <SelectTrigger id={fieldId} aria-invalid={Boolean(message) || undefined} aria-describedby={hinweisId}>
                        <SelectValue placeholder={f.placeholder ?? 'Bitte wählen'} />
                      </SelectTrigger>
                      <SelectContent>
                        {!f.required ? (
                          <SelectItem value="__none__">{f.placeholder ?? 'Keine Angabe'}</SelectItem>
                        ) : null}
                        {f.options?.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      id={fieldId}
                      type={
                        f.type === 'number'
                          ? 'text'
                          : f.type === 'datetime'
                            ? 'datetime-local'
                            : f.type === 'tags'
                              ? 'text'
                              : (f.type ?? 'text')
                      }
                      inputMode={f.type === 'number' ? 'decimal' : undefined}
                      value={String(value ?? '')}
                      placeholder={
                        f.type === 'tags' ? (f.placeholder ?? 'Mit Komma trennen') : f.placeholder
                      }
                      suffix={f.suffix}
                      min={f.min}
                      max={f.max}
                      step={f.step}
                      onChange={(e) => set(f.name, e.target.value)}
                      invalid={Boolean(message)}
                      aria-describedby={hinweisId}
                    />
                  )}
                </>
              )}
              {message ? (
                <p id={hinweisId} className="text-meta font-medium text-destructive" role="alert">
                  {message}
                </p>
              ) : f.hint ? (
                <p id={hinweisId} className="text-meta text-muted-foreground">{f.hint}</p>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Abbrechen
          </Button>
        ) : null}
        <Button type="submit" loading={saving}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

export interface FormDialogProps extends Omit<ResourceFormProps, 'onCancel'> {
  title: string;
  description?: string;
  triggerLabel: string;
  triggerVariant?: ButtonProps['variant'];
  triggerSize?: ButtonProps['size'];
  /** Ohne Plus-Symbol — für „Bearbeiten". */
  plainTrigger?: boolean;
  /** Eigenes Symbol im Auslöser (bei `triggerSize="icon"` das Einzige, was man sieht). */
  triggerIcon?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

/** Dasselbe Formular im Dialog — für Anlegen und Bearbeiten aus einer Liste heraus. */
export function FormDialog({
  title,
  description,
  triggerLabel,
  triggerVariant,
  triggerSize,
  plainTrigger,
  triggerIcon,
  size = 'lg',
  ...form
}: FormDialogProps) {
  const [open, setOpen] = React.useState(false);
  const iconOnly = triggerSize === 'icon';
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant={triggerVariant}
          size={triggerSize}
          aria-label={iconOnly ? triggerLabel : undefined}
          title={iconOnly ? triggerLabel : undefined}
        >
          {triggerIcon ?? (plainTrigger ? null : <Plus aria-hidden />)}
          {iconOnly ? null : triggerLabel}
        </Button>
      </DialogTrigger>
      {/*
        Ohne Beschreibung ausdrücklich keine: `aria-describedby={undefined}`
        sagt Radix, dass das Absicht ist, statt dass der Dialog auf ein
        fehlendes Element verweist (2026-09-27).
      */}
      <DialogContent size={size} {...(description ? {} : { 'aria-describedby': undefined })}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {open ? (
          <ResourceForm
            {...form}
            onCancel={() => setOpen(false)}
            onSuccess={(data) => {
              form.onSuccess?.(data);
              setOpen(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export { DialogFooter };
