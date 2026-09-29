'use client';

import * as React from 'react';
import { Check, Loader2, RefreshCw, Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import {
  TEXT_ASSIST_AKTION_LABEL,
  TEXT_ASSIST_AKTIONEN_JE_KONTEXT,
  type TextAssistAktion,
  type TextAssistKontext,
} from '@/lib/validation/ai';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import { useFormField } from '@/components/ui/form';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Hint,
} from '@/components/ui/overlays';

/**
 * KI-Textassistent am Eingabefeld (2026-09-28).
 *
 * ---------------------------------------------------------------------------
 *  Was dieser Baustein verspricht — und was nicht
 * ---------------------------------------------------------------------------
 *
 * **Er speichert nie.** „Übernehmen" ersetzt nur den Text im Feld (über
 * `onChange`, genau wie Tippen); gespeichert wird, wenn die Person das
 * Formular speichert — mit dessen Prüfung, dessen Recht und dessen
 * Protokoll. Ein zweiter Schreibweg aus dem Assistenten hätte einen Text auf
 * die Website gebracht, den niemand bewusst gespeichert hat.
 *
 * **Er fragt nicht nach, ob die KI eingerichtet ist.** Ob ein Anbieter
 * konfiguriert ist und ob die Rolle `ai:use` hat, entscheidet der Server beim
 * Rendern des Rahmens und reicht es über `TextAssistProvider` herunter. Ein
 * Probeaufruf je Feld beim Laden hätte das Rate-Limit belastet und die
 * Antwort doch nur geraten. Ohne Anbieter erscheint der Knopf gesperrt, mit
 * Begründung; ohne Recht (oder ohne Provider, etwa im Portal) gar nicht.
 *
 * **Er arbeitet auf der Markierung, wenn es eine gibt.** Wer einen Absatz
 * markiert, meint diesen Absatz — der Rest des Feldes bleibt, wie er ist,
 * und geht auch nicht an die KI. Die Markierung wird beim Öffnen gelesen und
 * eingefroren; das Feld verliert den Fokus, behält aber `selectionStart`.
 *
 * **Der Fokus kehrt ins Feld zurück**, nicht auf den Knopf: Nach dem
 * Übernehmen will man weiterschreiben oder prüfen, nicht noch einmal den
 * Assistenten öffnen.
 */

// ---------------------------------------------------------------------------
//  Verfügbarkeit — vom Server entschieden
// ---------------------------------------------------------------------------

interface TextAssistVerfuegbarkeit {
  /** Die Rolle hat `ai:use`. Ohne das gibt es keinen Knopf. */
  erlaubt: boolean;
  /** Ein KI-Anbieter ist konfiguriert. Ohne das ist der Knopf gesperrt und sagt warum. */
  verfuegbar: boolean;
}

const TextAssistContext = React.createContext<TextAssistVerfuegbarkeit>({ erlaubt: false, verfuegbar: false });

export function TextAssistProvider({
  erlaubt,
  verfuegbar,
  children,
}: TextAssistVerfuegbarkeit & { children: React.ReactNode }) {
  const wert = React.useMemo(() => ({ erlaubt, verfuegbar }), [erlaubt, verfuegbar]);
  return <TextAssistContext.Provider value={wert}>{children}</TextAssistContext.Provider>;
}

// ---------------------------------------------------------------------------
//  Baustein
// ---------------------------------------------------------------------------

interface Antwort {
  format: 'text' | 'vorschlaege';
  text?: string;
  vorschlaege?: string[];
  geschuetzt: number;
}

export interface TextAssistProps {
  /** Welche Art Feld — eine feste Liste, siehe `TEXT_ASSIST_KONTEXTE`. */
  kontext: TextAssistKontext;
  /** `id` des Eingabefelds: für Markierung und Fokusrückgabe. */
  feldId: string;
  /** Aktueller Wert des Felds. */
  value: string;
  /** Neuer Wert nach „Übernehmen" — wie eine Eingabe, nicht wie ein Speichern. */
  onChange: (value: string) => void;
  /** Beschriftung des Felds, für den zugänglichen Namen des Knopfs. */
  feldLabel?: string;
  className?: string;
}

type Bereich = { start: number; end: number } | null;

export function TextAssist({ kontext, feldId, value, onChange, feldLabel, className }: TextAssistProps) {
  const { erlaubt, verfuegbar } = React.useContext(TextAssistContext);
  const [offen, setOffen] = React.useState(false);
  const [bereich, setBereich] = React.useState<Bereich>(null);
  const [aktion, setAktion] = React.useState<TextAssistAktion | null>(null);
  const [laedt, setLaedt] = React.useState(false);
  const [fehler, setFehler] = React.useState<string | null>(null);
  const [antwort, setAntwort] = React.useState<Antwort | null>(null);
  const [auswahl, setAuswahl] = React.useState(0);
  const hinweisId = React.useId();
  // Eine spätere Antwort darf eine neuere nicht überschreiben (zweimal schnell „Erneut generieren").
  const anfrageNr = React.useRef(0);

  if (!erlaubt) return null;

  const name = feldLabel ? `KI-Textassistent für „${feldLabel}"` : 'KI-Textassistent';

  if (!verfuegbar) {
    return (
      <>
        <Hint label="KI-Textassistent nicht eingerichtet — es ist kein KI-Anbieter konfiguriert.">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-disabled="true"
            aria-describedby={hinweisId}
            className={cn('h-8 cursor-not-allowed px-2 opacity-60', className)}
            onClick={(e) => e.preventDefault()}
          >
            <Sparkles aria-hidden />
            <span className="sr-only">{name}</span>
          </Button>
        </Hint>
        <span id={hinweisId} className="sr-only">
          Nicht verfügbar: Es ist kein KI-Anbieter konfiguriert.
        </span>
      </>
    );
  }

  const quelle = bereich ? value.slice(bereich.start, bereich.end) : value;
  const erlaubteAktionen = TEXT_ASSIST_AKTIONEN_JE_KONTEXT[kontext];

  const oeffnen = () => {
    const feld = document.getElementById(feldId);
    let neu: Bereich = null;
    if (feld instanceof HTMLTextAreaElement || feld instanceof HTMLInputElement) {
      const start = feld.selectionStart ?? 0;
      const end = feld.selectionEnd ?? 0;
      // Nur eine echte Markierung, die zum aktuellen Wert passt.
      if (end > start && end <= value.length && value.slice(start, end).trim()) neu = { start, end };
    }
    setBereich(neu);
    setAktion(null);
    setAntwort(null);
    setFehler(null);
    setAuswahl(0);
  };

  const erzeugen = async (gewaehlt: TextAssistAktion) => {
    const nr = ++anfrageNr.current;
    setAktion(gewaehlt);
    setAntwort(null);
    setFehler(null);
    setAuswahl(0);
    setLaedt(true);
    try {
      const ergebnis = await api.post<Antwort>('/api/ai/text-assist', { aktion: gewaehlt, kontext, text: quelle });
      if (nr === anfrageNr.current) setAntwort(ergebnis);
    } catch (err) {
      if (nr !== anfrageNr.current) return;
      if (err instanceof ApiError) {
        setFehler(
          err.status === 429
            ? 'Das Stundenkontingent für KI-Anfragen ist aufgebraucht. Bitte versuchen Sie es später erneut.'
            : (err.fieldErrors[0]?.message ?? err.message),
        );
      } else {
        setFehler('Die KI ist momentan nicht erreichbar. Der Text bleibt unverändert.');
      }
    } finally {
      if (nr === anfrageNr.current) setLaedt(false);
    }
  };

  const vorschlag = antwort?.format === 'vorschlaege' ? (antwort.vorschlaege?.[auswahl] ?? '') : (antwort?.text ?? '');

  const uebernehmen = () => {
    if (!vorschlag) return;
    const neu = bereich ? `${value.slice(0, bereich.start)}${vorschlag}${value.slice(bereich.end)}` : vorschlag;
    onChange(neu);
    setOffen(false);
    toast.success('Vorschlag übernommen. Gespeichert wird erst mit dem Formular.');
  };

  return (
    <Dialog
      open={offen}
      onOpenChange={(naechst) => {
        if (naechst) oeffnen();
        setOffen(naechst);
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn('h-8 px-2 text-muted-foreground hover:text-foreground', className)}
          aria-label={name}
          title="KI-Textassistent: korrigieren oder umformulieren"
        >
          <Sparkles aria-hidden />
          <span className="hidden sm:inline">KI</span>
        </Button>
      </DialogTrigger>
      <DialogContent
        size="xl"
        // Fokus zurück ins Feld statt auf den Knopf — siehe Kopfkommentar.
        onCloseAutoFocus={(event) => {
          const feld = document.getElementById(feldId);
          if (feld) {
            event.preventDefault();
            feld.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>KI-Textassistent</DialogTitle>
          <DialogDescription>
            {bereich ? 'Bearbeitet wird nur der markierte Abschnitt.' : 'Bearbeitet wird der ganze Text des Felds.'}{' '}
            Der Vorschlag ersetzt nichts, bevor Sie ihn übernehmen — gespeichert wird erst mit dem Formular.
          </DialogDescription>
        </DialogHeader>

        {!quelle.trim() ? (
          <Alert variant="info">Das Feld ist leer. Schreiben Sie zuerst einen Text, den die KI bearbeiten kann.</Alert>
        ) : (
          <>
            <div role="group" aria-label="Was soll geschehen?" className="flex flex-wrap gap-2">
              {erlaubteAktionen.map((a) => (
                <Button
                  key={a}
                  type="button"
                  size="sm"
                  variant={aktion === a ? 'default' : 'outline'}
                  aria-pressed={aktion === a}
                  disabled={laedt}
                  onClick={() => void erzeugen(a)}
                >
                  {TEXT_ASSIST_AKTION_LABEL[a]}
                </Button>
              ))}
            </div>

            <p aria-live="polite" className="sr-only">
              {laedt ? 'Vorschlag wird erstellt.' : antwort ? 'Vorschlag bereit.' : ''}
            </p>

            {fehler ? <Alert variant="destructive">{fehler}</Alert> : null}

            {aktion ? (
              <div className="grid gap-4 md:grid-cols-2">
                <section aria-labelledby={`${hinweisId}-original`} className="min-w-0 space-y-2">
                  <h3 id={`${hinweisId}-original`} className="text-meta font-medium text-muted-foreground">
                    Original
                  </h3>
                  <div className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-muted/40 p-3 text-sm">
                    {quelle}
                  </div>
                </section>
                <section aria-labelledby={`${hinweisId}-vorschlag`} className="min-w-0 space-y-2">
                  <h3 id={`${hinweisId}-vorschlag`} className="text-meta font-medium text-muted-foreground">
                    Vorschlag
                  </h3>
                  {laedt ? (
                    <div className="flex min-h-24 items-center gap-2 rounded-xl border border-dashed border-border p-3 text-sm text-muted-foreground">
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                      Vorschlag wird erstellt …
                    </div>
                  ) : antwort?.format === 'vorschlaege' ? (
                    <fieldset className="space-y-2">
                      <legend className="sr-only">Vorschlag wählen</legend>
                      {antwort.vorschlaege?.map((v, i) => (
                        <label
                          key={i}
                          className={cn(
                            'flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm transition-colors',
                            auswahl === i ? 'border-primary bg-primary/6' : 'border-border hover:bg-muted/50',
                          )}
                        >
                          <input
                            type="radio"
                            name={`${hinweisId}-vorschlag`}
                            className="mt-1 accent-primary"
                            checked={auswahl === i}
                            onChange={() => setAuswahl(i)}
                          />
                          <span className="min-w-0 break-words">
                            {v}
                            <span className="ml-2 text-2xs tabular-nums text-muted-foreground">{v.length} Zeichen</span>
                          </span>
                        </label>
                      ))}
                    </fieldset>
                  ) : antwort?.text ? (
                    <div className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm">
                      {antwort.text}
                    </div>
                  ) : (
                    <div className="min-h-24 rounded-xl border border-dashed border-border p-3 text-sm text-muted-foreground">
                      Kein Vorschlag.
                    </div>
                  )}
                  {antwort && antwort.geschuetzt > 0 ? (
                    <p className="text-meta text-muted-foreground">
                      {antwort.geschuetzt === 1 ? 'Eine Stelle' : `${antwort.geschuetzt} Stellen`} (etwa Kontaktangaben
                      oder Namen) {antwort.geschuetzt === 1 ? 'ging' : 'gingen'} nicht an die KI und{' '}
                      {antwort.geschuetzt === 1 ? 'bleibt' : 'bleiben'} unverändert.
                    </p>
                  ) : null}
                </section>
              </div>
            ) : null}
          </>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOffen(false)}>
            <X aria-hidden />
            Verwerfen
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!aktion || laedt}
            onClick={() => aktion && void erzeugen(aktion)}
          >
            <RefreshCw aria-hidden />
            Erneut generieren
          </Button>
          <Button type="button" disabled={!vorschlag || laedt} onClick={uebernehmen}>
            <Check aria-hidden />
            Übernehmen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Dieselbe Schaltfläche für Felder in `react-hook-form` (`FormItem`): Die
 * `id` des Felds vergibt `FormControl`, und eine eigene `id` am Feld
 * überschriebe sie — die Beschriftung zeigte dann ins Leere. Deshalb liest
 * dieser Baustein die `id` aus dem umgebenden `FormItem`. Nur innerhalb
 * eines `FormItem` verwenden.
 */
export function FormTextAssist(props: Omit<TextAssistProps, 'feldId'>) {
  const { formItemId } = useFormField();
  return <TextAssist {...props} feldId={formItemId} />;
}
