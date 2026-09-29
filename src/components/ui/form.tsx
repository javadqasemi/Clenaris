'use client';

import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { Slot } from '@radix-ui/react-slot';
import {
  Controller,
  FormProvider,
  useFormContext,
  type ControllerProps,
  type FieldPath,
  type FieldValues,
} from 'react-hook-form';
import { AlertCircle } from 'lucide-react';

import { cn } from '@/lib/utils';
// Deutsche Zod-Vorgaben auch für die Prüfung im Browser (`zodResolver`).
import '@/lib/validation/fehlerkarte';

/**
 * Formularbausteine für React Hook Form.
 *
 * Die Verbindung von Beschriftung, Feld, Hilfetext und Fehlermeldung läuft
 * über `aria-describedby` und `aria-invalid` — damit ist jedes Formular ohne
 * Zusatzarbeit für Screenreader nutzbar. Fehlermeldungen erscheinen in einer
 * Live-Region, damit sie beim Absenden vorgelesen werden.
 */

const Form = FormProvider;

interface FormFieldContextValue {
  name: string;
}

const FormFieldContext = React.createContext<FormFieldContextValue>({ name: '' });
const FormItemContext = React.createContext<{ id: string }>({ id: '' });

function FormField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>({ ...props }: ControllerProps<TFieldValues, TName>) {
  return (
    <FormFieldContext.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  );
}

function useFormField() {
  const fieldContext = React.useContext(FormFieldContext);
  const itemContext = React.useContext(FormItemContext);
  const { getFieldState, formState } = useFormContext();

  const fieldState = getFieldState(fieldContext.name, formState);
  const { id } = itemContext;

  return {
    id,
    name: fieldContext.name,
    formItemId: `${id}-field`,
    formDescriptionId: `${id}-description`,
    formMessageId: `${id}-message`,
    ...fieldState,
  };
}

const FormItem = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const id = React.useId();
    return (
      <FormItemContext.Provider value={{ id }}>
        <div ref={ref} className={cn('space-y-2', className)} {...props} />
      </FormItemContext.Provider>
    );
  },
);
FormItem.displayName = 'FormItem';

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> & { required?: boolean }
>(({ className, required, children, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(
      'text-sm font-medium leading-none text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
      className,
    )}
    {...props}
  >
    {children}
    {required ? (
      <span className="ml-0.5 text-destructive" aria-hidden>
        *
      </span>
    ) : null}
  </LabelPrimitive.Root>
));
Label.displayName = 'Label';

const FormLabel = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> & { required?: boolean }
>(({ className, ...props }, ref) => {
  const { error, formItemId } = useFormField();
  return (
    <Label
      ref={ref}
      htmlFor={formItemId}
      className={cn(error && 'text-destructive', className)}
      {...props}
    />
  );
});
FormLabel.displayName = 'FormLabel';

/** Feldarten, deren Wert als Text im Formularzustand steht und übernommen werden darf. */
const TEXTARTIGE_FELDER = new Set(['text', 'email', 'password', 'search', 'tel', 'url']);

/**
 * Was vor der Hydration im Feld stand, in den Formularzustand übernehmen.
 *
 * Gefunden am 2026-09-28 in WebKit, nachgestellt in Chromium mit verzögertem
 * JavaScript: Die Anmeldeseite wird auf dem Server gerendert, die Felder sind
 * über React Hook Form **gesteuert** (`value=""`). Tippt jemand — oder füllt
 * ein Passwortmanager — das Feld, bevor React hydriert hat, steht der Text im
 * DOM, aber nicht im Formularzustand. Das Wiedereinspielen solcher Eingaben,
 * das React 19 vorsieht (`trackHydrated` → `queueChangeEvent`), griff in
 * diesem Bau nicht: Beim nächsten Rendern nach der Hydration schrieb
 * `updateInput` den leeren gesteuerten Wert zurück ins Feld. Sichtbar wurde
 * das als leeres Feld und „E-Mail-Adresse ist erforderlich" — auf der Seite,
 * auf der Passwortmanager am häufigsten beim Laden ausfüllen.
 *
 * **Gelesen wird beim ersten Rendern, übernommen nach dem Einhängen.** Ein
 * Layout-Effekt, der das Element selbst liest, blieb im Versuch wirkungslos —
 * das Leeren geschieht in der Mutationsphase eines Commits (`updateInput`),
 * und die liegt vor den Layout-Effekten. Beim ersten Rendern der Hydration steht das
 * Server-Element dagegen unverändert im DOM, unter derselben Kennung, die
 * `useId` auf Server und Browser gleich vergibt. Das Lesen verändert nichts
 * und fliesst nicht in die Ausgabe — es gibt deshalb keine
 * Hydrationsabweichung. Beim Rendern ohne Hydration gibt es das Element noch
 * nicht, auf dem Server kein `document`; in beiden Fällen geschieht nichts.
 *
 * Übernommen wird nur in ein **leeres** Feld des Formularzustands und nur bei
 * Textfeldern — ein vorbelegter Wert oder ein Zahlenfeld (dessen Zustand eine
 * Zahl ist) bleibt unberührt.
 */
function useVorHydrationEingabe(elementId: string, name: string) {
  const { getValues, setValue } = useFormContext();
  const [vorHydration] = React.useState<string | null>(() => {
    if (typeof document === 'undefined') return null;
    const feld = document.getElementById(elementId);
    const textfeld =
      feld instanceof HTMLTextAreaElement || (feld instanceof HTMLInputElement && TEXTARTIGE_FELDER.has(feld.type));
    return textfeld ? (feld as HTMLInputElement | HTMLTextAreaElement).value || null : null;
  });
  React.useEffect(() => {
    if (!vorHydration || !name) return;
    /*
      Nicht direkt im Effekt: `Controller` meldet sich für Wertänderungen erst
      in seinem eigenen Effekt an, und der läuft *nach* den Effekten seiner
      Nachfahren — dieser hier ist einer. Ein `setValue` jetzt erreichte die
      Anzeige nicht (beobachtet im Layout-Effekt: der Wert war beim ersten
      Rendern gelesen, das Feld blieb trotzdem leer). Nach dem Einhängen sind
      alle Anmeldungen erfolgt.
    */
    const zeitgeber = window.setTimeout(() => {
      const imZustand: unknown = getValues(name);
      if (imZustand === '' || imZustand === undefined || imZustand === null) {
        setValue(name, vorHydration, { shouldDirty: true });
      }
    }, 0);
    return () => window.clearTimeout(zeitgeber);
    // Nur beim Einhängen — danach führt React das Feld.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

const FormControl = React.forwardRef<
  React.ElementRef<typeof Slot>,
  React.ComponentPropsWithoutRef<typeof Slot>
>(({ ...props }, ref) => {
  const { error, formItemId, formDescriptionId, formMessageId, name } = useFormField();
  useVorHydrationEingabe(formItemId, name);
  return (
    <Slot
      ref={ref}
      id={formItemId}
      aria-describedby={error ? `${formDescriptionId} ${formMessageId}` : formDescriptionId}
      aria-invalid={!!error}
      {...props}
    />
  );
});
FormControl.displayName = 'FormControl';

const FormDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => {
  const { formDescriptionId } = useFormField();
  return (
    <p
      ref={ref}
      id={formDescriptionId}
      className={cn('text-meta leading-relaxed text-muted-foreground', className)}
      {...props}
    />
  );
});
FormDescription.displayName = 'FormDescription';

const FormMessage = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, children, ...props }, ref) => {
  const { error, formMessageId } = useFormField();
  const body = error ? String(error?.message ?? '') : children;

  if (!body) return null;

  return (
    <p
      ref={ref}
      id={formMessageId}
      role="alert"
      className={cn('flex items-start gap-1.5 text-meta font-medium text-destructive', className)}
      {...props}
    >
      <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden />
      {body}
    </p>
  );
});
FormMessage.displayName = 'FormMessage';

export {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormDescription,
  FormMessage,
  Label,
  useFormField,
};
