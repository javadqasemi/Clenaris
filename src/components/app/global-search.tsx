'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { AlertCircle, Loader2, Search } from 'lucide-react';

import { cn } from '@/lib/utils';
import { api } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/overlays';

/**
 * Globale Live-Suche in der Kopfzeile (Produktsprint 2026-09-26).
 *
 * ---------------------------------------------------------------------------
 *  Was hier *nicht* passiert
 * ---------------------------------------------------------------------------
 *
 * Keine zweite Suchmaschine. Die Komponente fragt denselben Endpunkt wie die
 * Suchseite (`GET /api/search`, Wave 17), und der Dienst dahinter entscheidet
 * je Bereich mit derselben `can()`-Prüfung und derselben
 * `organizationId`-Bedingung wie jede Liste, was die Person finden darf. Der
 * Browser filtert nichts weg — was er nicht zeigen soll, bekommt er nicht.
 *
 * ---------------------------------------------------------------------------
 *  Die drei Regeln der Live-Suche
 * ---------------------------------------------------------------------------
 *
 *  1. **Entprellt, 250 ms.** Jede Taste eine Anfrage wäre bei „müller" sechs
 *     Anfragen für ein Ergebnis und liefe gegen das `apiRead`-Limit. 250 ms
 *     liegen unter der Schwelle, ab der eine Pause als Warten empfunden wird,
 *     und über dem Abstand zweier Anschläge beim zügigen Tippen.
 *  2. **Die alte Anfrage wird abgebrochen, nicht bloss ignoriert.** Jede neue
 *     Eingabe räumt den Effekt der vorigen ab: Zeitgeber gelöscht, laufende
 *     Anfrage per `AbortController` beendet. Eine Antwort, die trotzdem noch
 *     eintrifft, prüft vor dem Schreiben ihr eigenes Signal. So kann eine
 *     langsame Antwort auf „mü" nie die schnellere auf „müller" überschreiben
 *     — der Wettlauf ist strukturell ausgeschlossen, nicht bloss unwahrscheinlich.
 *  3. **Unter zwei Zeichen wird nicht gefragt.** Der Endpunkt würde mit 422
 *     antworten (`globalSearchQuerySchema`); die Liste bleibt dann zu.
 *
 * ---------------------------------------------------------------------------
 *  Hydration
 * ---------------------------------------------------------------------------
 *
 * Der Rahmen darf seine Struktur nicht von Client-Zustand abhängig machen
 * (`docs/HYDRATION.md` §9). Server und erster Browserdurchgang rendern hier
 * genau dasselbe: ein Eingabefeld (ab `md`) und einen Symbolknopf (darunter).
 * Die Trefferliste entsteht erst nach einer Eingabe, der Dialog erst nach
 * einem Klick — beides lange nach dem Hydrieren. Der Tastaturkürzel-Hörer
 * hängt in einem Effekt und berührt das HTML nicht.
 *
 * ---------------------------------------------------------------------------
 *  Barrierefreiheit
 * ---------------------------------------------------------------------------
 *
 * Das Muster ist die „Combobox mit Listbox" aus den ARIA Authoring Practices:
 * Der Fokus bleibt im Eingabefeld, die aktive Option zeigt
 * `aria-activedescendant` an. Gruppen tragen `role="group"` mit ihrer
 * Überschrift als Namen. Die Zahl der Treffer geht zusätzlich über eine
 * höfliche Live-Region, weil ein Bildschirmleser das Erscheinen einer Liste
 * sonst nicht meldet.
 */

interface Treffer {
  art: string;
  id: string;
  titel: string;
  untertitel: string | null;
  link: string;
}

type Zustand =
  | { status: 'leer' }
  | { status: 'laedt'; vorher: Treffer[] }
  | { status: 'fertig'; q: string; treffer: Treffer[] }
  | { status: 'fehler'; meldung: string };

const ENTPRELLUNG_MS = 250;
const MINDESTLAENGE = 2;

/**
 * Gruppenüberschriften. Der Dienst liefert die Art in der Einzahl („Vertrag"),
 * die Liste nennt die Gruppe in der Mehrzahl. Eine unbekannte Art erscheint
 * unter ihrem eigenen Namen, statt verloren zu gehen.
 */
const GRUPPEN: Record<string, string> = {
  Kundschaft: 'Kundschaft',
  Anfrage: 'Anfragen',
  Objekt: 'Objekte',
  Buchung: 'Buchungen',
  Offerte: 'Offerten',
  Besichtigung: 'Besichtigungen',
  Vertrag: 'Verträge',
  Einsatz: 'Einsätze',
  Personal: 'Mitarbeitende',
  Rechnung: 'Rechnungen',
  Dokument: 'Dokumente',
  Reklamation: 'Reklamationen',
  Material: 'Material',
  Gerät: 'Geräte',
};

/**
 * Die Anfrage selbst — entprellt und mit Abbruch.
 *
 * `versuch` erlaubt ein erneutes Laden nach einem Fehler, ohne dass sich die
 * Eingabe ändern muss.
 */
function useLiveSuche(eingabe: string, versuch: number): Zustand {
  const [zustand, setZustand] = React.useState<Zustand>({ status: 'leer' });

  React.useEffect(() => {
    const q = eingabe.trim();
    if (q.length < MINDESTLAENGE) {
      setZustand({ status: 'leer' });
      return;
    }

    const abbruch = new AbortController();
    const zeitgeber = window.setTimeout(async () => {
      // Die bisherigen Treffer bleiben stehen, bis die neuen da sind — eine
      // Liste, die bei jedem Buchstaben verschwindet und wiederkommt, flackert.
      setZustand((vorher) => ({
        status: 'laedt',
        vorher: vorher.status === 'fertig' ? vorher.treffer : vorher.status === 'laedt' ? vorher.vorher : [],
      }));
      try {
        const antwort = await api.get<{ q: string; treffer: Treffer[] }>(
          '/api/search',
          { q },
          { signal: abbruch.signal },
        );
        if (abbruch.signal.aborted) return;
        setZustand({ status: 'fertig', q: antwort.q, treffer: antwort.treffer });
      } catch (fehler) {
        if (abbruch.signal.aborted) return;
        setZustand({
          status: 'fehler',
          meldung:
            fehler instanceof Error && fehler.message
              ? fehler.message
              : 'Die Suche ist gerade nicht erreichbar.',
        });
      }
    }, ENTPRELLUNG_MS);

    return () => {
      window.clearTimeout(zeitgeber);
      abbruch.abort();
    };
  }, [eingabe, versuch]);

  return zustand;
}

/** Suchbegriff im Titel hervorheben — ohne `dangerouslySetInnerHTML`. */
function Hervorgehoben({ text, begriff }: { text: string; begriff: string }) {
  const q = begriff.trim();
  if (!q) return <>{text}</>;
  const index = text.toLocaleLowerCase('de-CH').indexOf(q.toLocaleLowerCase('de-CH'));
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded-sm bg-primary/15 px-0.5 text-foreground">
        {text.slice(index, index + q.length)}
      </mark>
      {text.slice(index + q.length)}
    </>
  );
}

/**
 * Eingabefeld und Trefferliste — einmal im Kopf (ab `md`), einmal im Dialog
 * auf dem Telefon. Dieselbe Komponente an beiden Orten, damit Tastatur,
 * Hervorhebung und Wettlaufschutz nicht zweimal existieren.
 */
const SuchFeld = React.forwardRef<
  HTMLInputElement,
  { idPraefix: string; imDialog?: boolean; onGewaehlt?: () => void }
>(function SuchFeld({ idPraefix, imDialog = false, onGewaehlt }, ref) {
  const router = useRouter();
  const pathname = usePathname();
  const [eingabe, setEingabe] = React.useState('');
  const [offen, setOffen] = React.useState(false);
  const [aktiv, setAktiv] = React.useState(-1);
  const [versuch, setVersuch] = React.useState(0);
  const zustand = useLiveSuche(eingabe, versuch);
  const wurzel = React.useRef<HTMLDivElement>(null);

  const listeId = `${idPraefix}-liste`;
  const optionId = (index: number) => `${idPraefix}-option-${index}`;

  // Nach einem Seitenwechsel ist die Liste erledigt.
  React.useEffect(() => setOffen(false), [pathname]);

  // Memoisiert, weil der Effekt darunter an der Identität der Liste hängt —
  // ein bei jedem Rendern neues `[]` löste ihn bei jedem Rendern aus.
  const treffer = React.useMemo(
    () => (zustand.status === 'fertig' ? zustand.treffer : zustand.status === 'laedt' ? zustand.vorher : []),
    [zustand],
  );

  // Neue Treffer — keine Option ist mehr aktiv. Sonst zeigte ein altes
  // `aria-activedescendant` auf eine Zeile, die jetzt etwas anderes bedeutet.
  React.useEffect(() => setAktiv(-1), [treffer]);

  const gruppen = React.useMemo(() => {
    const karte = new Map<string, { treffer: Treffer; index: number }[]>();
    treffer.forEach((t, index) => {
      const liste = karte.get(t.art) ?? [];
      liste.push({ treffer: t, index });
      karte.set(t.art, liste);
    });
    return [...karte.entries()];
  }, [treffer]);

  const zeigeListe = offen && eingabe.trim().length >= MINDESTLAENGE;

  const oeffne = (t: Treffer) => {
    setOffen(false);
    onGewaehlt?.();
    router.push(t.link);
  };

  const alleTreffer = () => {
    const q = eingabe.trim();
    if (q.length < MINDESTLAENGE) return;
    setOffen(false);
    onGewaehlt?.();
    router.push(`/admin/suche?q=${encodeURIComponent(q)}`);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setOffen(true);
        if (treffer.length) setAktiv((i) => (i + 1) % treffer.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setOffen(true);
        if (treffer.length) setAktiv((i) => (i <= 0 ? treffer.length - 1 : i - 1));
        break;
      case 'Enter': {
        event.preventDefault();
        const gewaehlt = aktiv >= 0 ? treffer[aktiv] : undefined;
        // Ohne gewählte Zeile führt Enter zur Vollansicht aller Treffer —
        // dieselbe Erwartung wie bei jedem Suchfeld, und die Seite zeigt
        // mehr als die fünf Treffer je Bereich der Schnellliste.
        if (gewaehlt) oeffne(gewaehlt);
        else alleTreffer();
        break;
      }
      case 'Escape':
        // Erst die Liste schliessen, beim zweiten Mal das Feld leeren. Im
        // Dialog gehört Escape dem Dialog selbst.
        if (zeigeListe) {
          event.preventDefault();
          event.stopPropagation();
          setOffen(false);
        } else if (!imDialog && eingabe) {
          event.preventDefault();
          setEingabe('');
        }
        break;
      default:
        break;
    }
  };

  const statusText =
    zustand.status === 'laedt'
      ? 'Suche läuft …'
      : zustand.status === 'fehler'
        ? zustand.meldung
        : zustand.status === 'fertig'
          ? zustand.treffer.length === 0
            ? `Kein Treffer für „${zustand.q}“.`
            : `${zustand.treffer.length} Treffer.`
          : '';

  return (
    <div
      ref={wurzel}
      className="relative w-full"
      onBlur={(event) => {
        // Nur schliessen, wenn der Fokus die ganze Suche verlässt — ein Klick
        // in die Liste darf sie nicht vor dem Klick selbst schliessen.
        if (!wurzel.current?.contains(event.relatedTarget as Node | null)) setOffen(false);
      }}
    >
      <label htmlFor={`${idPraefix}-feld`} className="sr-only">
        Suchen in Kundschaft, Objekten, Aufträgen, Verträgen und Rechnungen
      </label>
      <Search
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <input
        ref={ref}
        id={`${idPraefix}-feld`}
        type="search"
        role="combobox"
        autoComplete="off"
        spellCheck={false}
        maxLength={80}
        aria-autocomplete="list"
        aria-expanded={zeigeListe}
        aria-controls={listeId}
        aria-activedescendant={zeigeListe && aktiv >= 0 ? optionId(aktiv) : undefined}
        placeholder="Kunden, Aufträge, Verträge, Rechnungen suchen …"
        value={eingabe}
        onChange={(event) => {
          setEingabe(event.target.value);
          setOffen(true);
        }}
        onFocus={() => setOffen(true)}
        // Nach Escape behält das Feld den Fokus; ein Klick hinein muss die
        // Liste deshalb selbst wieder öffnen — `focus` feuert dann nicht mehr.
        onClick={() => setOffen(true)}
        onKeyDown={onKeyDown}
        className={cn(
          'h-10 w-full rounded-xl border border-input bg-background pl-9 text-sm shadow-soft transition-colors',
          'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          '[&::-webkit-search-cancel-button]:hidden',
          imDialog ? 'pr-9' : 'pr-16',
        )}
      />
      {zustand.status === 'laedt' ? (
        <Loader2
          className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground"
          aria-hidden
        />
      ) : imDialog ? null : (
        <kbd className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded-md border border-border bg-muted px-1.5 py-0.5 font-sans text-2xs text-muted-foreground lg:inline">
          Strg K
        </kbd>
      )}

      <p className="sr-only" aria-live="polite">
        {zeigeListe ? statusText : ''}
      </p>

      {/*
        Das Listenelement steht immer im Baum, damit `aria-controls` auf ein
        vorhandenes Element zeigt; sichtbar und gefüllt wird es erst nach
        einer Eingabe. `hidden` statt Weglassen — die Struktur bleibt gleich.
      */}
      <div
        id={listeId}
        role="listbox"
        aria-label="Suchergebnisse"
        hidden={!zeigeListe}
        className={cn(
          'z-50 overflow-y-auto rounded-xl border border-border bg-card p-1.5 shadow-elevated',
          imDialog ? 'mt-3 max-h-[60dvh]' : 'absolute left-0 right-0 top-full mt-2 max-h-[70dvh]',
        )}
      >
        {zustand.status === 'fehler' ? (
          <div className="flex items-start gap-3 px-3 py-3 text-sm">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            <div className="space-y-2">
              <p>{zustand.meldung}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setVersuch((v) => v + 1)}
              >
                Erneut versuchen
              </Button>
            </div>
          </div>
        ) : zustand.status === 'fertig' && zustand.treffer.length === 0 ? (
          <p className="px-3 py-3 text-sm text-muted-foreground">
            Kein Treffer für „{zustand.q}“. Gesucht wird in Namen, Nummern und Titeln.
          </p>
        ) : treffer.length === 0 ? (
          <p className="px-3 py-3 text-sm text-muted-foreground">Suche läuft …</p>
        ) : (
          gruppen.map(([art, eintraege]) => (
            <div key={art} role="group" aria-labelledby={`${idPraefix}-gruppe-${art}`} className="py-1">
              <p
                id={`${idPraefix}-gruppe-${art}`}
                className="px-3 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground"
              >
                {GRUPPEN[art] ?? art}
              </p>
              {eintraege.map(({ treffer: t, index }) => (
                <div
                  key={`${t.art}-${t.id}`}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === aktiv}
                  onMouseEnter={() => setAktiv(index)}
                  // `mousedown` statt `click`: Der Klick käme erst nach dem
                  // `blur` des Eingabefelds an, und der hätte die Liste schon
                  // geschlossen.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    oeffne(t);
                  }}
                  className={cn(
                    'flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm',
                    index === aktiv ? 'bg-primary/10 text-foreground' : 'text-foreground/90',
                  )}
                >
                  <span className="min-w-0 truncate font-medium">
                    <Hervorgehoben text={t.titel} begriff={eingabe} />
                  </span>
                  {t.untertitel ? (
                    <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">
                      <Hervorgehoben text={t.untertitel} begriff={eingabe} />
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          ))
        )}
        {treffer.length > 0 ? (
          <div className="mt-1 border-t border-border px-1 pt-1">
            <button
              type="button"
              tabIndex={-1}
              onMouseDown={(event) => {
                event.preventDefault();
                alleTreffer();
              }}
              className="w-full rounded-lg px-2 py-2 text-left text-xs font-medium text-primary hover:bg-muted"
            >
              Alle Treffer anzeigen (Enter)
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
});

/**
 * Die Suche im Kopf: Feld ab `md`, Symbolknopf mit Dialog darunter.
 *
 * `Strg`+`K` (auf dem Mac `⌘`+`K`) führt in beiden Fällen in dieselbe Suche:
 * Auf breiten Bildschirmen bekommt das Feld den Fokus, auf schmalen öffnet
 * sich der Dialog. Das Kürzel greift auch, wenn der Fokus gerade in einem
 * anderen Feld steht — dort hat es keine eigene Bedeutung, und gerade aus
 * einem Formular heraus will man am ehesten schnell woanders hin.
 */
export function GlobalSearch() {
  const feld = React.useRef<HTMLInputElement>(null);
  const [dialogOffen, setDialogOffen] = React.useState(false);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      event.preventDefault();
      const breit = window.matchMedia('(min-width: 768px)').matches;
      if (breit && feld.current) {
        feld.current.focus();
        feld.current.select();
      } else {
        setDialogOffen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <>
      <div className="hidden w-full max-w-xl md:block">
        <SuchFeld ref={feld} idPraefix="kopfsuche" />
      </div>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="md:hidden"
        aria-label="Suche öffnen"
        onClick={() => setDialogOffen(true)}
      >
        <Search aria-hidden />
      </Button>

      <Dialog open={dialogOffen} onOpenChange={setDialogOffen}>
        <DialogContent className="top-4 translate-y-0 gap-3 p-4 sm:top-16" size="lg">
          <DialogTitle className="text-base">Suche</DialogTitle>
          <SuchFeld idPraefix="dialogsuche" imDialog onGewaehlt={() => setDialogOffen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}
