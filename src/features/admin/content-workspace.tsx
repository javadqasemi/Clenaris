'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  ExternalLink,
  History,
  Monitor,
  RefreshCw,
  Rocket,
  Save,
  Smartphone,
  Tablet,
  Undo2,
} from 'lucide-react';
import { toast } from 'sonner';

import { cn, formatDateTime } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import { definitionFor, type ContentDefinition, type ContentGroup } from '@/lib/cms/registry';
import { Button } from '@/components/ui/button';
import { Alert, Skeleton } from '@/components/ui/primitives';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
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
} from '@/components/ui/overlays';
import { ContentField, CharCount } from '@/features/admin/content-field';
import { ImageField } from '@/features/admin/image-field';
import { assetFieldLabel } from '@/lib/cms/assets';
import { CMS_MESSAGE } from '@/components/cms/preview-bridge';

/**
 * Redaktionsarbeitsplatz: die echte Website, direkt beschreibbar.
 *
 * Architekturentscheide:
 *
 *  • **Die Vorschau ist die Website, keine Nachbildung.** Im Rahmen läuft die
 *    öffentliche Seite selbst, im Vorschaumodus. Eine nachgebaute Vorschau
 *    würde bei jeder Layoutänderung auseinanderlaufen und wäre genau dann
 *    falsch, wenn man sich auf sie verlässt — sie ist die aufwendigste Art,
 *    Vertrauen zu zerstören.
 *
 *  • **Geschrieben wird in der Seite, nicht in einer Maske daneben.** Früher
 *    stand links eine Liste aller Felder und rechts die Vorschau; ein Klick in
 *    der Vorschau sprang zum Feld. Das war ein Umweg: Man las die Überschrift
 *    rechts, tippte sie links und prüfte rechts, ob sie umbricht. Jetzt tippt
 *    man in die Überschrift. Enter oder ein Klick daneben speichert den Text
 *    als Entwurf, Esc verwirft ihn. Die Brücke in der Vorschau meldet nur den
 *    fertigen Wortlaut; gespeichert, gezählt und gemeldet wird hier.
 *
 *  • **Was sich nicht in der Seite tippen lässt, bekommt eine kleine Maske.**
 *    Listen, Texte mit Platzhalter und Bausteine, die auf keiner Seite stehen,
 *    öffnen einen Dialog mit genau einem Feld — aus dem Klick heraus oder über
 *    die Bausteinauswahl in der Werkzeugleiste. Der Dialog ist die alte Maske
 *    auf ein Feld geschrumpft, nicht eine zweite Art zu speichern.
 *
 *  • **Der Vorschaumodus wird über einen Endpunkt eingeschaltet, bevor der
 *    Rahmen lädt.** Er setzt Next's Draft-Mode-Cookie; nur Anfragen mit diesem
 *    Cookie umgehen den Seitencache. Für alle anderen bleibt die Website
 *    statisch ausgeliefert.
 *
 *  • **Gerätebreiten statt eines Schiebereglers.** Drei feste Breiten
 *    beantworten die Frage, die im Alltag gestellt wird („bricht die
 *    Überschrift auf dem Telefon um?"). Ein stufenloser Regler lädt zum
 *    Spielen ein und beantwortet sie nicht besser.
 *
 *  • **Veröffentlichen ist ein eigener Knopf mit eigener Rückfrage.** Bis
 *    dahin sieht nur diese Vorschau die Änderungen.
 */

export interface PreviewPage {
  path: string;
  label: string;
}

const WIDTHS = [
  { id: 'desktop', label: 'Desktop', width: '100%', Icon: Monitor },
  { id: 'tablet', label: 'Tablet', width: '820px', Icon: Tablet },
  { id: 'mobile', label: 'Telefon', width: '390px', Icon: Smartphone },
] as const;

type Values = Record<string, string | string[]>;

/** Der Rahmen füllt die Seite bis auf Kopfzeile und Werkzeugleiste. */
const FRAME_HEIGHT = 'h-[calc(100vh-14rem)] min-h-[32rem]';

export function ContentWorkspace({
  groups,
  pages,
  initial,
  defaults,
  draftCount,
  lastPublishedAt,
}: {
  groups: ContentGroup[];
  /** Seiten, die sich in der Vorschau aufrufen lassen — vom Server bestimmt. */
  pages: PreviewPage[];
  /** Aktueller Entwurfsstand: gepflegte Werte, sonst Standardtext. */
  initial: Values;
  /** Auslieferungsfassung je Schlüssel — für „Auf Standard". */
  defaults: Values;
  draftCount: number;
  lastPublishedAt: string | null;
}) {
  const router = useRouter();
  const [path, setPath] = React.useState(pages[0]?.path ?? '/');
  const [device, setDevice] = React.useState<(typeof WIDTHS)[number]['id']>('desktop');
  const [nonce, setNonce] = React.useState(0);
  const [pending, setPending] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<'publish' | 'discard' | null>(null);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  /** Der Baustein, für den gerade die kleine Maske offen ist. */
  const [fieldKey, setFieldKey] = React.useState<string | null>(null);
  /** Der Text, in dem in der Vorschau gerade getippt wird — für die Zeichenzahl. */
  const [editing, setEditing] = React.useState<{ key: string; length: number } | null>(null);
  /** Das in der Vorschau angeklickte Bild — öffnet die Bildmaske. */
  const [asset, setAsset] = React.useState<{
    entity: string;
    id: string;
    field: string;
  } | null>(null);
  const frameRef = React.useRef<HTMLIFrameElement>(null);

  /**
   * Der Entwurfsstand, wie ihn dieser Arbeitsplatz kennt.
   *
   * Nach jedem Speichern wird der Wert hier sofort übernommen — und der
   * Server über `router.refresh()` erneut gefragt. Sobald der antwortet, kommt
   * ein neues `initial`, und das gewinnt: Es kennt auch Änderungen, die dieser
   * Arbeitsplatz nicht gemacht hat, etwa eine zurückgeholte Fassung.
   */
  const [values, setValues] = React.useState<Values>(initial);
  React.useEffect(() => {
    setValues(initial);
  }, [initial]);

  /** Alle Bausteine flach, mit ihrer Gruppe als Kontext — für Auswahl und Verlauf. */
  const fields = React.useMemo(
    () =>
      groups.flatMap((group) =>
        group.items.map((item) => ({
          key: item.key,
          label: `${group.label} · ${item.label}`,
        })),
      ),
    [groups],
  );
  const labelFor = React.useCallback(
    (key: string) => fields.find((field) => field.key === key)?.label ?? key,
    [fields],
  );

  /**
   * Für den eigenen Tab bleibt es beim Endpunkt mit Weiterleitung: Dort ist es
   * eine gewöhnliche Navigation, die das Cookie setzt und ankommt.
   */
  const previewHref = `/api/content/preview?pfad=${encodeURIComponent(path)}`;

  const reload = React.useCallback(() => setNonce((value) => value + 1), []);

  /**
   * Der Vorschaumodus wird eingeschaltet, *bevor* der Rahmen lädt — und der
   * Rahmen zeigt danach direkt auf die Seite.
   *
   * Der naheliegende Weg wäre, den Rahmen auf den Endpunkt zu richten und ihn
   * der Weiterleitung folgen zu lassen. Genau das scheitert: Chrome bricht eine
   * weitergeleitete Navigation im `iframe` ab und stellt eine Fehlerseite
   * fremden Ursprungs dar — der Rahmen bleibt leer, ohne Meldung. Ein Aufruf
   * vorab, dann eine schlichte Navigation: beides für sich unproblematisch.
   *
   * Das hängt am Zähler und läuft damit bei jedem „neu laden" mit. Das kostet
   * eine sehr kleine Anfrage und repariert nebenbei den Fall, dass das Cookie
   * zwischenzeitlich verfallen ist — sonst zeigte die Vorschau stillschweigend
   * den veröffentlichten Stand.
   */
  const [armed, setArmed] = React.useState<'pending' | 'ready' | 'failed'>('pending');

  React.useEffect(() => {
    let cancelled = false;
    setArmed('pending');

    fetch('/api/content/preview?nur=1', { credentials: 'same-origin', cache: 'no-store' })
      .then((response) => {
        if (!cancelled) setArmed(response.ok ? 'ready' : 'failed');
      })
      .catch(() => {
        if (!cancelled) setArmed('failed');
      });

    return () => {
      cancelled = true;
    };
  }, [nonce]);

  /**
   * Beim Verlassen der Maske den Vorschaumodus wieder ausschalten.
   *
   * Das Cookie ist nach dem Umbau von `isPreview` zwar ausserhalb des
   * Rahmens wirkungslos — es gilt nur mit Sitzung und nur im Rahmen. Es
   * trotzdem zu räumen hält den Browser sauber: Wer die Maske schliesst,
   * soll kein Cookie behalten, das unveröffentlichte Inhalte freischaltet.
   * `pagehide` statt `beforeunload`: zuverlässiger beim Schliessen des Tabs,
   * und `keepalive` lässt die Anfrage den Seitenwechsel überleben.
   */
  React.useEffect(() => {
    const disarm = () => {
      void fetch('/api/content/preview?aus=1&nur=1', {
        credentials: 'same-origin',
        cache: 'no-store',
        keepalive: true,
      }).catch(() => undefined);
    };
    window.addEventListener('pagehide', disarm);
    return () => window.removeEventListener('pagehide', disarm);
  }, []);

  /**
   * Einen Baustein als Entwurf speichern.
   *
   * Ein Aufruf je Änderung: Wer in der Seite tippt, ändert einen Text und
   * sieht ihn sofort — eine Sammelübergabe wie in der alten Maske gäbe es
   * nicht mehr zu sammeln. Das Prüfprotokoll zeigt dann je Vorgang, was
   * angefasst wurde.
   */
  const saveDraft = React.useCallback(
    async (key: string, value: string | string[]) => {
      await api.patch('/api/content', { entries: [{ key, value }] });
      setValues((current) => ({ ...current, [key]: value }));
      router.refresh();
    },
    [router],
  );

  const postToFrame = React.useCallback((payload: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage(payload, window.location.origin);
  }, []);

  /**
   * Nachrichten aus der Vorschau entgegennehmen.
   *
   * Das ist der Kern dieser Arbeitsfläche: Man schreibt in der Vorschau in den
   * Text, den man ändern will. Die Vorschau meldet den fertigen Wortlaut, hier
   * wird er gespeichert und die Vorschau bekommt Bescheid, ob es geklappt hat.
   *
   * Der Ursprung wird geprüft, obwohl der Rahmen dieselbe Domain trägt: Ein
   * `message`-Ereignis kann von jedem Fenster kommen, das eine Referenz auf
   * dieses hat.
   */
  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const type = event.data?.type;

      if (type === CMS_MESSAGE.asset) {
        const { entity, id, field } = event.data as Record<string, string>;
        /*
          Nur öffnen, was die Maske auch benennen kann. Eine Anschrift, die
          nicht in der Liste steht, würde der Server ohnehin abweisen — die
          Redaktion sähe dann eine Maske, die beim Speichern scheitert.
        */
        if (entity && id && field && assetFieldLabel(entity, field)) {
          setAsset({ entity, id, field });
        }
        return;
      }

      if (type === CMS_MESSAGE.editing) {
        const key = event.data.key ? String(event.data.key) : null;
        setEditing(key ? { key, length: Number(event.data.length ?? 0) } : null);
        return;
      }

      if (type === CMS_MESSAGE.select) {
        const key = String(event.data.key ?? '');
        if (key && definitionFor(key)) setFieldKey(key);
        return;
      }

      if (type === CMS_MESSAGE.change) {
        const key = String(event.data.key ?? '');
        const value = event.data.value;
        if (!key || typeof value !== 'string' || !definitionFor(key)) return;

        void (async () => {
          try {
            await saveDraft(key, value);
            postToFrame({ type: CMS_MESSAGE.saved, key });
            if (value === '') {
              // Geleert heisst „zurück zum Auslieferungstext" — den kennt nur
              // der Server. Erst ein Neuladen zeigt ihn.
              toast.success('Auf den Standardtext zurückgesetzt — als Entwurf.');
              reload();
            } else {
              toast.success('Als Entwurf gespeichert.');
            }
          } catch (error) {
            postToFrame({ type: CMS_MESSAGE.rejected, key });
            toast.error(
              error instanceof ApiError
                ? (error.fieldErrors[0]?.message ?? error.message)
                : 'Die Änderung konnte nicht gespeichert werden.',
            );
          }
        })();
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [saveDraft, postToFrame, reload]);

  const run = async (action: string, request: () => Promise<unknown>, message: string) => {
    setPending(action);
    try {
      await request();
      toast.success(message);
      setDialog(null);
      reload();
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'Die Aktion konnte nicht ausgeführt werden.',
      );
    } finally {
      setPending(null);
    }
  };

  const activeWidth = WIDTHS.find((entry) => entry.id === device) ?? WIDTHS[0];
  const editingDefinition = editing ? definitionFor(editing.key) : undefined;
  const fieldDefinition = fieldKey ? definitionFor(fieldKey) : undefined;

  return (
    <div className="space-y-4">
      {/* Statusleiste */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-card p-3 shadow-soft">
        <span
          className={cn(
            'inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium',
            draftCount > 0 ? 'bg-warning/12 text-warning' : 'bg-success/12 text-success',
          )}
        >
          <span
            className={cn('size-2 rounded-full', draftCount > 0 ? 'bg-warning' : 'bg-success')}
            aria-hidden
          />
          {draftCount > 0
            ? `${draftCount} unveröffentlichte ${draftCount === 1 ? 'Änderung' : 'Änderungen'}`
            : 'Alles veröffentlicht'}
        </span>

        {lastPublishedAt ? (
          <span className="text-meta text-muted-foreground">
            Zuletzt veröffentlicht {formatDateTime(lastPublishedAt)}
          </span>
        ) : null}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/*
            Der Verlauf steht immer zur Verfügung, nicht nur bei offenen
            Entwürfen: Man schlägt ihn gerade dann nach, wenn alles
            veröffentlicht ist und die Frage lautet „was stand hier vorher?".
          */}
          <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}>
            <History aria-hidden />
            Fassungsverlauf
          </Button>

          {draftCount > 0 ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDialog('discard')}
                disabled={pending !== null}
              >
                <Undo2 aria-hidden />
                Entwürfe verwerfen
              </Button>
              <Button size="sm" onClick={() => setDialog('publish')} disabled={pending !== null}>
                <Rocket aria-hidden />
                Veröffentlichen
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {/* Vorschau */}
      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <Select value={path} onValueChange={setPath}>
            <SelectTrigger className="w-56" aria-label="Seite in der Vorschau">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pages.map((page) => (
                <SelectItem key={page.path} value={page.path}>
                  {page.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div
            className="flex items-center gap-0.5 rounded-xl bg-muted p-1"
            role="radiogroup"
            aria-label="Vorschaubreite"
          >
            {WIDTHS.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={device === id}
                aria-label={label}
                title={label}
                onClick={() => setDevice(id)}
                className={cn(
                  'flex size-8 items-center justify-center rounded-lg transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  device === id
                    ? 'bg-card text-foreground shadow-soft'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="size-4" aria-hidden />
              </button>
            ))}
          </div>

          {/*
            Bausteinauswahl: der Weg zu allem, was in der Vorschau nicht
            anklickbar ist — Bausteine, die auf keiner der Seiten stehen oder
            deren Seite gerade nicht geladen ist. Der Wert bleibt leer, damit
            der Platzhalter stehen bleibt; die Auswahl ist eine Handlung
            (Maske öffnen), kein Zustand.
          */}
          <Select value="" onValueChange={(key) => setFieldKey(key)}>
            <SelectTrigger className="w-64" aria-label="Baustein direkt bearbeiten">
              <SelectValue placeholder="Baustein direkt bearbeiten…" />
            </SelectTrigger>
            <SelectContent>
              {groups.map((group) => (
                <SelectGroup key={group.id}>
                  <SelectLabel>{group.label}</SelectLabel>
                  {group.items.map((item) => (
                    <SelectItem key={item.key} value={item.key}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>

          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" onClick={reload} aria-label="Vorschau neu laden">
              <RefreshCw aria-hidden />
            </Button>
            <Button variant="ghost" size="icon-sm" asChild aria-label="In neuem Tab öffnen">
              <a href={previewHref} target="_blank" rel="noreferrer">
                <ExternalLink aria-hidden />
              </a>
            </Button>
          </div>
        </div>

        <div className="flex justify-center bg-muted/40 p-3">
          {armed === 'failed' ? (
            <Alert variant="destructive" title="Vorschau nicht verfügbar" className="w-full">
              Der Vorschaumodus liess sich nicht einschalten. Bitte laden Sie die Seite neu —
              besteht das Problem fort, ist vermutlich die Anmeldung abgelaufen.
            </Alert>
          ) : armed === 'pending' ? (
            <Skeleton
              className={cn(FRAME_HEIGHT, 'rounded-xl')}
              style={{ width: activeWidth.width, maxWidth: '100%' }}
            />
          ) : (
            /*
              `key` statt eines Zählers in der Adresse: Der Rahmen wird beim
              Neuladen ausgetauscht und lädt darum auch dann neu, wenn der
              Pfad derselbe blieb. Ein Parameter in der Adresse täte es
              auch — er stünde aber in der Vorschau sichtbar in der Zeile
              und wäre Teil dessen, was man beim Prüfen der Seite sieht.
            */
            <iframe
              key={nonce}
              ref={frameRef}
              src={path}
              title="Vorschau der Website"
              className={cn(
                FRAME_HEIGHT,
                'rounded-xl border border-border bg-background shadow-soft transition-[width] duration-300',
              )}
              style={{ width: activeWidth.width, maxWidth: '100%' }}
            />
          )}
        </div>

        {/*
          Die Zeile unter dem Rahmen wechselt zwischen Anleitung und
          Bearbeitungsstand. Während getippt wird, steht hier, *was* gerade
          bearbeitet wird und wie viele Zeichen erlaubt sind — die Vorschau
          selbst kann das nicht zeigen, ohne die Seite zu verändern.
        */}
        <div className="flex min-h-10 flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-4 py-2 text-meta text-muted-foreground">
          {editing && editingDefinition ? (
            <>
              <span className="font-medium text-foreground">{labelFor(editing.key)}</span>
              {editingDefinition.maxLength ? (
                <CharCount current={editing.length} max={editingDefinition.maxLength} />
              ) : null}
              <span>
                Enter speichert als Entwurf
                {editingDefinition.kind !== 'line' ? ', Umschalt+Enter bricht die Zeile um' : ''}
                , Esc verwirft.
              </span>
            </>
          ) : (
            <span>
              Klicken Sie in der Vorschau auf einen Text und schreiben Sie direkt hinein. Listen und
              Bilder öffnen eine kleine Maske. Besucherinnen und Besucher sehen weiterhin die
              veröffentlichte Fassung, bis Sie oben auf &bdquo;Veröffentlichen&ldquo; tippen.
            </span>
          )}
        </div>
      </div>

      {/* Veröffentlichen */}
      <Dialog open={dialog === 'publish'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>
              {draftCount} {draftCount === 1 ? 'Änderung' : 'Änderungen'} veröffentlichen?
            </DialogTitle>
            <DialogDescription>
              Die Texte erscheinen sofort auf der öffentlichen Website. Die bisherige Fassung
              wandert in die Historie und lässt sich von dort zurückholen.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Abbrechen
            </Button>
            <Button
              loading={pending === 'publish'}
              onClick={() =>
                run(
                  'publish',
                  () => api.post('/api/content', { action: 'publish' }),
                  'Website aktualisiert.',
                )
              }
            >
              <Rocket aria-hidden />
              Jetzt veröffentlichen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Verwerfen */}
      <Dialog open={dialog === 'discard'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Alle Entwürfe verwerfen?</DialogTitle>
            <DialogDescription>
              Die unveröffentlichten Änderungen gehen verloren. Die Website bleibt unverändert —
              sie zeigt ohnehin noch die veröffentlichte Fassung.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Abbrechen
            </Button>
            <Button
              variant="destructive"
              loading={pending === 'discard'}
              onClick={() =>
                run(
                  'discard',
                  () => api.post('/api/content', { action: 'discard' }),
                  'Entwürfe verworfen.',
                )
              }
            >
              <Undo2 aria-hidden />
              Verwerfen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <FieldDialog
        definition={fieldDefinition ?? null}
        groupLabel={fieldKey ? labelFor(fieldKey) : ''}
        value={fieldKey ? values[fieldKey] : undefined}
        defaultValue={fieldKey ? defaults[fieldKey] : undefined}
        onClose={() => setFieldKey(null)}
        onSave={async (key, value) => {
          await saveDraft(key, value);
          setFieldKey(null);
          toast.success('Als Entwurf gespeichert.');
          // Die Seite rendert Listen und Platzhalter selbst — erst ein
          // Neuladen zeigt den neuen Stand.
          reload();
        }}
      />

      <AssetDialog
        target={asset}
        onClose={() => setAsset(null)}
        onSaved={() => {
          setAsset(null);
          reload();
        }}
      />

      <RevisionDialog
        open={historyOpen}
        fields={fields}
        onClose={() => setHistoryOpen(false)}
        onRestored={() => {
          setHistoryOpen(false);
          reload();
          router.refresh();
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Ein Baustein in der kleinen Maske
// ---------------------------------------------------------------------------

/**
 * Die Maske für einen einzelnen Baustein.
 *
 * Sie entsteht aus dem Klick — auf eine Liste, einen Text mit Platzhalter —
 * oder aus der Bausteinauswahl, und verschwindet mit dem Speichern. Der
 * Wert wird beim Öffnen aus dem Entwurfsstand übernommen und danach nicht
 * mehr nachgezogen: Wer tippt, soll nicht überschrieben werden, weil im
 * Hintergrund `router.refresh()` einen neuen Stand gebracht hat.
 */
function FieldDialog({
  definition,
  groupLabel,
  value,
  defaultValue,
  onClose,
  onSave,
}: {
  definition: ContentDefinition | null;
  groupLabel: string;
  value: string | string[] | undefined;
  defaultValue: string | string[] | undefined;
  onClose: () => void;
  onSave: (key: string, value: string | string[]) => Promise<void>;
}) {
  const [draft, setDraft] = React.useState<string | string[]>('');
  const [error, setError] = React.useState<string | undefined>();
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!definition) return;
    setDraft(value ?? definition.default);
    setError(undefined);
    // Bewusst nur beim Wechsel des Bausteins — siehe Kommentar oben.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definition?.key]);

  const changed = definition ? JSON.stringify(draft) !== JSON.stringify(value ?? definition.default) : false;

  const save = async () => {
    if (!definition) return;
    setSaving(true);
    setError(undefined);
    try {
      await onSave(definition.key, draft);
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.fieldErrors[0]?.message ?? caught.message);
      } else {
        setError('Die Änderung konnte nicht gespeichert werden.');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={definition !== null} onOpenChange={(next) => !next && !saving && onClose()}>
      <DialogContent size="md">
        {definition ? (
          <>
            <DialogHeader>
              <DialogTitle>{groupLabel}</DialogTitle>
              <DialogDescription>
                Wird als Entwurf gespeichert und erscheint erst nach dem Veröffentlichen auf der
                Website.
              </DialogDescription>
            </DialogHeader>

            <ContentField
              definition={definition}
              value={draft}
              defaultValue={defaultValue ?? definition.default}
              error={error}
              autoFocus
              onChange={(next) => {
                setDraft(next);
                setError(undefined);
              }}
            />

            <DialogFooter>
              <Button variant="ghost" onClick={onClose} disabled={saving}>
                Abbrechen
              </Button>
              <Button loading={saving} disabled={!changed} onClick={() => void save()}>
                <Save aria-hidden />
                Als Entwurf speichern
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
//  Bild austauschen
// ---------------------------------------------------------------------------

/**
 * Bildmaske für ein Bild, das an einem Datensatz hängt.
 *
 * **Warum ein Dialog aus dem Klick heraus.** Bilder gehören dem Datensatz,
 * der gerade zufällig auf dieser Seite steht: Morgen ist ein anderer
 * Galerieeintrag hervorgehoben, und ein festes Feld zeigte auf ein Bild, das
 * nirgends mehr zu sehen ist. Der Dialog entsteht aus dem Klick und
 * verschwindet mit ihm.
 *
 * **Warum es keinen Entwurfsstand gibt.** Anders als ein Text wirkt der
 * Austausch sofort — begründet im Dienst (`updateAssetField`). Der Hinweis im
 * Dialog sagt das ausdrücklich, damit niemand auf „Veröffentlichen" wartet.
 */
function AssetDialog({
  target,
  onClose,
  onSaved,
}: {
  target: { entity: string; id: string; field: string } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  /*
    Beim Öffnen leeren: Der Dialog bleibt zwischen zwei Klicks montiert, und
    ohne diesen Schritt stünde die Adresse des zuletzt bearbeiteten Bildes im
    Feld — mit dem Ergebnis, dass ein Klick auf „Speichern" das falsche Bild
    an die falsche Stelle schriebe.
  */
  React.useEffect(() => {
    setValue('');
  }, [target?.entity, target?.id, target?.field]);

  const label = target ? assetFieldLabel(target.entity, target.field) : null;

  const save = async (next: string | null) => {
    if (!target) return;
    setSaving(true);
    try {
      await api.patch('/api/content/asset', { ...target, url: next });
      toast.success(next ? 'Bild ausgetauscht.' : 'Bild entfernt.');
      onSaved();
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'Das Bild konnte nicht gespeichert werden.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={target !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{label ?? 'Bild austauschen'}</DialogTitle>
          <DialogDescription>
            Das Bild gehört zum Datensatz und wird <strong>sofort</strong> ausgetauscht — nicht
            erst beim Veröffentlichen. Es ändert sich überall dort, wo dieser Datensatz erscheint.
          </DialogDescription>
        </DialogHeader>

        <ImageField id="cms-asset-url" value={value} onChange={setValue} />

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Abbrechen
          </Button>
          <Button
            variant="outline"
            onClick={() => void save(null)}
            disabled={saving}
            className="text-muted-foreground hover:text-destructive"
          >
            Bild entfernen
          </Button>
          <Button loading={saving} disabled={!value} onClick={() => void save(value)}>
            Übernehmen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
//  Fassungsverlauf
// ---------------------------------------------------------------------------

interface Revision {
  id: string;
  value: unknown;
  createdAt: string;
}

function RevisionDialog({
  open,
  fields,
  onClose,
  onRestored,
}: {
  open: boolean;
  fields: { key: string; label: string }[];
  onClose: () => void;
  onRestored: () => void;
}) {
  const [contentKey, setContentKey] = React.useState(fields[0]?.key ?? '');
  const [revisions, setRevisions] = React.useState<Revision[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [restoring, setRestoring] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open || !contentKey) {
      setRevisions(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    api
      .get<Revision[]>('/api/content/revisions', { key: contentKey })
      .then((result) => {
        if (!cancelled) setRevisions(result);
      })
      .catch(() => {
        if (!cancelled) setRevisions([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, contentKey]);

  const restore = async (id: string) => {
    setRestoring(id);
    try {
      await api.post('/api/content/revisions', { revisionId: id });
      toast.success('Frühere Fassung als Entwurf zurückgeholt — bitte prüfen und veröffentlichen.');
      onRestored();
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'Die Fassung konnte nicht zurückgeholt werden.',
      );
    } finally {
      setRestoring(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Fassungsverlauf</DialogTitle>
          <DialogDescription>
            Frühere <strong>veröffentlichte</strong> Stände eines Textbausteins. Zwischenstände
            eines Entwurfs stehen nicht darin — sie wären eine Aufzeichnung des Tippens, nicht der
            Website.
          </DialogDescription>
        </DialogHeader>

        <Select value={contentKey} onValueChange={setContentKey}>
          <SelectTrigger aria-label="Textbaustein">
            <SelectValue placeholder="Textbaustein wählen" />
          </SelectTrigger>
          <SelectContent>
            {fields.map((field) => (
              <SelectItem key={field.key} value={field.key}>
                {field.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-16" />
            ))}
          </div>
        ) : revisions && revisions.length === 0 ? (
          <Alert variant="info" title="Noch keine frühere Fassung">
            Dieser Baustein wurde noch nicht ersetzt. Die Historie füllt sich beim
            Veröffentlichen.
          </Alert>
        ) : (
          <ul className="space-y-2">
            {revisions?.map((revision) => (
              <li
                key={revision.id}
                className="flex flex-wrap items-start gap-3 rounded-xl border border-border p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-muted-foreground">
                    ersetzt am {formatDateTime(revision.createdAt)}
                  </p>
                  <p className="mt-1 whitespace-pre-line break-words text-sm">
                    {Array.isArray(revision.value)
                      ? revision.value.join(' · ')
                      : String(revision.value ?? '')}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  loading={restoring === revision.id}
                  onClick={() => void restore(revision.id)}
                >
                  <Undo2 aria-hidden />
                  Zurückholen
                </Button>
              </li>
            ))}
          </ul>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Schliessen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
