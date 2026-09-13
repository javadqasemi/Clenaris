'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  ExternalLink,
  History,
  Monitor,
  RefreshCw,
  Rocket,
  Smartphone,
  Tablet,
  Undo2,
} from 'lucide-react';
import { toast } from 'sonner';

import { cn, formatDateTime } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import type { ContentGroup } from '@/lib/cms/registry';
import { Button } from '@/components/ui/button';
import { Alert, Skeleton } from '@/components/ui/primitives';
import {
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
} from '@/components/ui/overlays';
import { ContentEditor } from '@/features/admin/content-editor';
import { ImageField } from '@/features/admin/image-field';
import { assetFieldLabel } from '@/lib/cms/assets';
import { CMS_MESSAGE } from '@/components/cms/preview-bridge';

/**
 * Redaktionsarbeitsplatz: Maske links, echte Website rechts.
 *
 * Architekturentscheide:
 *
 *  • **Die Vorschau ist die Website, keine Nachbildung.** Im Rahmen läuft die
 *    öffentliche Seite selbst, im Vorschaumodus. Eine nachgebaute Vorschau
 *    würde bei jeder Layoutänderung auseinanderlaufen und wäre genau dann
 *    falsch, wenn man sich auf sie verlässt — sie ist die aufwendigste Art,
 *    Vertrauen zu zerstören.
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

const PAGES = [
  { path: '/', label: 'Startseite' },
  { path: '/leistungen', label: 'Leistungen' },
  { path: '/preise', label: 'Preise' },
  { path: '/ueber-uns', label: 'Über uns' },
  { path: '/einsatzgebiet', label: 'Einsatzgebiet' },
  { path: '/galerie', label: 'Galerie' },
  { path: '/bewertungen', label: 'Bewertungen' },
  { path: '/faq', label: 'Häufige Fragen' },
  { path: '/kontakt', label: 'Kontakt' },
  { path: '/offerte', label: 'Offerte anfordern' },
  { path: '/buchen', label: 'Buchung' },
];

const WIDTHS = [
  { id: 'desktop', label: 'Desktop', width: '100%', Icon: Monitor },
  { id: 'tablet', label: 'Tablet', width: '820px', Icon: Tablet },
  { id: 'mobile', label: 'Telefon', width: '390px', Icon: Smartphone },
] as const;

type Values = Record<string, string | string[]>;

export function ContentWorkspace({
  groups,
  initial,
  defaults,
  draftCount,
  lastPublishedAt,
}: {
  groups: ContentGroup[];
  initial: Values;
  defaults: Values;
  draftCount: number;
  lastPublishedAt: string | null;
}) {
  const router = useRouter();
  const [path, setPath] = React.useState('/');
  const [device, setDevice] = React.useState<(typeof WIDTHS)[number]['id']>('desktop');
  const [nonce, setNonce] = React.useState(0);
  const [pending, setPending] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<'publish' | 'discard' | null>(null);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  /**
   * Der in der Vorschau angeklickte Baustein — steuert die linke Spalte.
   *
   * Mitgezählt wird, *wie oft* ausgewählt wurde, nicht nur *was*. Sonst wäre
   * der zweite Klick auf denselben Text wirkungslos, weil sich der Zustand
   * nicht ändert.
   */
  const [selection, setSelection] = React.useState<{ key: string; seq: number } | null>(null);
  /** Das in der Vorschau angeklickte Bild — öffnet die Bildmaske. */
  const [asset, setAsset] = React.useState<{
    entity: string;
    id: string;
    field: string;
  } | null>(null);
  const frameRef = React.useRef<HTMLIFrameElement>(null);

  /** Alle Bausteine flach, mit ihrer Gruppe als Kontext — für die Auswahl im Verlauf. */
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
   * Klicks in der Vorschau entgegennehmen.
   *
   * Das ist der Kern dieser Arbeitsfläche: Man zeigt in der Vorschau auf den
   * Text, den man ändern will, statt ihn in einer Liste von zwanzig Feldern zu
   * suchen. Die Vorschau meldet den Schlüssel, hier wird das passende Feld
   * geöffnet.
   *
   * Der Ursprung wird geprüft, obwohl der Rahmen dieselbe Domain trägt: Ein
   * `message`-Ereignis kann von jedem Fenster kommen, das eine Referenz auf
   * dieses hat.
   */
  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;

      if (event.data?.type === CMS_MESSAGE.asset) {
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

      if (event.data?.type !== CMS_MESSAGE.select) return;

      const key = String(event.data.key ?? '');
      if (key) setSelection((current) => ({ key, seq: (current?.seq ?? 0) + 1 }));
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  /** Umgekehrte Richtung: Feld in der Maske gewählt → in der Vorschau zeigen. */
  const highlightInPreview = React.useCallback((key: string) => {
    frameRef.current?.contentWindow?.postMessage(
      { type: CMS_MESSAGE.highlight, key },
      window.location.origin,
    );
  }, []);

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

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] xl:items-start">
        {/* Maske */}
        <div className="min-w-0">
          <ContentEditor
            groups={groups}
            initial={initial}
            defaults={defaults}
            onSaved={reload}
            selectedKey={selection?.key ?? null}
            selectionSeq={selection?.seq ?? 0}
            onFocusField={highlightInPreview}
          />
        </div>

        {/* Vorschau */}
        <div className="sticky top-20 hidden min-w-0 xl:block">
          <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
            <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
              <Select value={path} onValueChange={setPath}>
                <SelectTrigger className="w-48" aria-label="Seite in der Vorschau">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGES.map((page) => (
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
                <Alert
                  variant="destructive"
                  title="Vorschau nicht verfügbar"
                  className="w-full"
                >
                  Der Vorschaumodus liess sich nicht einschalten. Bitte laden Sie die Seite neu —
                  besteht das Problem fort, ist vermutlich die Anmeldung abgelaufen.
                </Alert>
              ) : armed === 'pending' ? (
                <Skeleton
                  className="h-[calc(100vh-16rem)] rounded-xl"
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
                  className="h-[calc(100vh-16rem)] rounded-xl border border-border bg-background shadow-soft transition-[width] duration-300"
                  style={{ width: activeWidth.width, maxWidth: '100%' }}
                />
              )}
            </div>
          </div>

          <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">
            Die Vorschau zeigt den Entwurfsstand. Besucherinnen und Besucher sehen weiterhin die
            veröffentlichte Fassung, bis Sie oben auf &bdquo;Veröffentlichen&ldquo; tippen.
          </p>
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
//  Bild austauschen
// ---------------------------------------------------------------------------

/**
 * Bildmaske für ein Bild, das an einem Datensatz hängt.
 *
 * **Warum ein Dialog und nicht ein Feld in der linken Spalte.** Die linke
 * Spalte führt die Textbausteine des Registers — eine Liste, die zu jeder Seite
 * dieselbe ist. Bilder gehören dagegen dem Datensatz, der gerade zufällig auf
 * dieser Seite steht: Morgen ist ein anderer Galerieeintrag hervorgehoben, und
 * das Feld zeigte auf ein Bild, das nirgends mehr zu sehen ist. Der Dialog
 * entsteht aus dem Klick und verschwindet mit ihm.
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
