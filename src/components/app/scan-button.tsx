'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertCircle, Camera, CameraOff, ImageUp, Loader2, PackagePlus, QrCode, ScanLine, Tag } from 'lucide-react';

import { api, ApiError } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/overlays';
import { ResourceForm } from '@/components/app/resource-form';
import { aktionsMaske, neuerArtikelMaske, type AktionsMaske, type ScanAktionSchluessel } from '@/features/shared/scan-aktionen';

/**
 * Scanner in der Kopfzeile (Scanplattform, 2026-09-26).
 *
 * ---------------------------------------------------------------------------
 *  Drei Eingänge, ein Weg
 * ---------------------------------------------------------------------------
 *
 *  • **Kamera** über `BarcodeDetector` — die im Browser eingebaute Erkennung.
 *    Verbreitet ist sie in Chromium-Browsern auf Android, macOS und ChromeOS;
 *    Chrome unter Windows und Firefox bieten sie nicht an. Diese Liste ist
 *    keine Zusage — die Komponente fragt selbst, ob es den Detektor gibt und
 *    welche Formate er erkennt (`getSupportedFormats`), und zeigt genau das.
 *  • **Bild** — ein Foto aus der Galerie, erkannt mit demselben Detektor. Das
 *    Bild verlässt das Gerät nicht; gesendet wird nur der erkannte Text.
 *  • **Eingabe** — eintippen, einfügen oder ein Handscanner. Ein USB- oder
 *    Bluetooth-Handscanner ist eine Tastatur, die den Code tippt und Enter
 *    drückt; das Feld nimmt ihn deshalb ohne jede Sonderbehandlung an. Das ist
 *    der Weg, der überall funktioniert — auch dort, wo die Kamera fehlt.
 *
 * Keine Bibliothek als Ersatz für fehlende Kamera-Erkennung: Die Abwägung
 * (zxing-js, jsQR, html5-qrcode — Grösse, Pflegezustand, Lizenz) steht in
 * `docs/SCANNER.md`. Kurz: Ein halbes Megabyte Skript für einen Weg, den der
 * Handscanner und das Eintippen schon abdecken, und zwei der drei Kandidaten
 * werden nicht mehr gepflegt.
 *
 * ---------------------------------------------------------------------------
 *  Was der Scanner nie tut
 * ---------------------------------------------------------------------------
 *
 * Er öffnet keine gescannte Adresse, navigiert nicht von allein, löst keine
 * Aktion aus. Der erkannte Text geht an `POST /api/scan/resolve`; was
 * zurückkommt, sind Treffer im Leserecht der Person und Knöpfe. Ein Link wird
 * erst mit einem Klick verfolgt, eine Aktion erst mit dem Knopf in ihrer
 * Maske gesendet — und der Endpunkt dahinter prüft Recht, Mandant und Zustand
 * noch einmal. Dargestellt wird alles als React-Text: Ein Code mit
 * `<script>` erscheint als diese Zeichen, nicht als Element.
 *
 * ---------------------------------------------------------------------------
 *  Hydration
 * ---------------------------------------------------------------------------
 *
 * Server und erster Browserdurchgang rendern genau einen Knopf. Ob der
 * Browser eine Kamera-Erkennung hat, wird erst beim Öffnen des Dialogs
 * gefragt (`docs/HYDRATION.md` §9) — nie beim Rendern des Rahmens.
 */

interface Treffer {
  art: 'MATERIAL' | 'GERAET' | 'EINSATZ' | 'RECHNUNG' | 'KUNDSCHAFT' | 'OBJEKT';
  id: string;
  titel: string;
  untertitel: string | null;
  link: string | null;
  merkmale: { label: string; wert: string }[];
  aktionen: { schluessel: ScanAktionSchluessel; label: string }[];
  etikett: string | null;
}

interface Ergebnis {
  eingabe: { art: string; anzeige: string; format: string | null };
  treffer: Treffer[];
  hinweis: string | null;
  neuerArtikel: { barcode: string; format: string } | null;
}

type Zustand =
  | { status: 'bereit' }
  | { status: 'laedt'; text: string }
  | { status: 'fertig'; text: string; ergebnis: Ergebnis }
  | { status: 'fehler'; meldung: string };

const ART_LABEL: Record<Treffer['art'], string> = {
  MATERIAL: 'Material',
  GERAET: 'Gerät',
  EINSATZ: 'Einsatz',
  RECHNUNG: 'Rechnung',
  KUNDSCHAFT: 'Kundschaft',
  OBJEKT: 'Objekt',
};

/** Formate, die der Detektor liefern soll — nur die, die `scanEinordnen` versteht oder als Nummer liest. */
const GEWUENSCHTE_FORMATE = ['qr_code', 'ean_13', 'ean_8', 'upc_a', 'code_128', 'code_39', 'data_matrix'];

interface Detektor {
  detect(quelle: CanvasImageSource | ImageBitmap): Promise<{ rawValue: string }[]>;
}
type DetektorKlasse = {
  new (optionen?: { formats?: string[] }): Detektor;
  getSupportedFormats?: () => Promise<string[]>;
};

function detektorKlasse(): DetektorKlasse | null {
  const k = (globalThis as { BarcodeDetector?: DetektorKlasse }).BarcodeDetector;
  return typeof k === 'function' ? k : null;
}

/**
 * Kamera und Erkennung. Hält den Strom nur, solange die Ansicht offen ist,
 * und beendet jede Spur beim Schliessen — eine Kamera, die nach dem Dialog
 * weiterläuft, ist die Art Fehler, die das Vertrauen in eine Firma kostet.
 */
function useKamera(onErkannt: (text: string) => void) {
  const video = React.useRef<HTMLVideoElement>(null);
  const strom = React.useRef<MediaStream | null>(null);
  const [status, setStatus] = React.useState<'aus' | 'startet' | 'laeuft' | 'fehlt' | 'verweigert' | 'keineKamera' | 'belegt'>('aus');
  const [formate, setFormate] = React.useState<string[] | null>(null);
  const erkannt = React.useRef(onErkannt);
  erkannt.current = onErkannt;

  const stoppen = React.useCallback(() => {
    strom.current?.getTracks().forEach((t) => t.stop());
    strom.current = null;
    if (video.current) video.current.srcObject = null;
    setStatus((s) => (s === 'laeuft' || s === 'startet' ? 'aus' : s));
  }, []);

  const starten = React.useCallback(async () => {
    const Klasse = detektorKlasse();
    if (!Klasse || !navigator.mediaDevices?.getUserMedia) {
      setStatus('fehlt');
      return;
    }
    setStatus('startet');
    try {
      const unterstuetzt = (await Klasse.getSupportedFormats?.()) ?? GEWUENSCHTE_FORMATE;
      const genutzt = GEWUENSCHTE_FORMATE.filter((f) => unterstuetzt.includes(f));
      setFormate(genutzt);
      if (genutzt.length === 0) {
        setStatus('fehlt');
        return;
      }
      const detektor = new Klasse({ formats: genutzt });
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      strom.current = s;
      if (!video.current) {
        stoppen();
        return;
      }
      video.current.srcObject = s;
      await video.current.play();
      setStatus('laeuft');
      // Vier Versuche pro Sekunde genügen; jeder Versuch kostet auf einem
      // älteren Telefon spürbar Akku.
      const runde = async () => {
        if (strom.current !== s || !video.current) return;
        try {
          const funde = await detektor.detect(video.current);
          const text = funde.find((f) => f.rawValue)?.rawValue;
          if (text) {
            stoppen();
            erkannt.current(text);
            return;
          }
        } catch {
          // Ein einzelnes Bild, das nicht ausgewertet werden konnte — weiter.
        }
        window.setTimeout(runde, 250);
      };
      void runde();
    } catch (fehler) {
      stoppen();
      /*
        Jeder Kamerafehler hiess bis 2026-09-27 „Dieser Browser erkennt keine
        Codes" — auch wenn das Gerät gar keine Kamera hat oder eine andere
        Anwendung sie gerade benutzt. Die Meldung schickte die Person zum
        falschen Ausweg (Browser wechseln statt Videoanruf beenden).
      */
      const name = fehler instanceof DOMException ? fehler.name : '';
      setStatus(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'verweigert'
          : name === 'NotFoundError' || name === 'OverconstrainedError'
            ? 'keineKamera'
            : name === 'NotReadableError' || name === 'AbortError'
              ? 'belegt'
              : 'fehlt',
      );
    }
  }, [stoppen]);

  React.useEffect(() => stoppen, [stoppen]);

  return { video, status, formate, starten, stoppen };
}

async function ausBild(datei: File): Promise<string | null> {
  const Klasse = detektorKlasse();
  if (!Klasse) return null;
  const bild = await createImageBitmap(datei);
  try {
    const funde = await new Klasse({ formats: GEWUENSCHTE_FORMATE }).detect(bild);
    return funde.find((f) => f.rawValue)?.rawValue ?? null;
  } finally {
    bild.close();
  }
}

function ScanInhalt() {
  const [eingabe, setEingabe] = React.useState('');
  const [zustand, setZustand] = React.useState<Zustand>({ status: 'bereit' });
  const [maske, setMaske] = React.useState<{ trefferId: string; maske: AktionsMaske } | null>(null);
  const [bildHinweis, setBildHinweis] = React.useState<string | null>(null);
  const feld = React.useRef<HTMLInputElement>(null);

  const aufloesen = React.useCallback(async (text: string) => {
    setMaske(null);
    setBildHinweis(null);
    setZustand({ status: 'laedt', text });
    try {
      const ergebnis = await api.post<Ergebnis>('/api/scan/resolve', { text });
      setZustand({ status: 'fertig', text, ergebnis });
    } catch (fehler) {
      setZustand({ status: 'fehler', meldung: fehler instanceof ApiError ? fehler.message : 'Der Scan konnte nicht ausgewertet werden.' });
    }
  }, []);

  const kamera = useKamera((text) => {
    setEingabe('');
    void aufloesen(text);
  });

  const hatDetektor = typeof window !== 'undefined' && detektorKlasse() !== null;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className={cn('overflow-hidden rounded-xl border border-border bg-muted', kamera.status === 'laeuft' || kamera.status === 'startet' ? 'block' : 'hidden')}>
          <video ref={kamera.video} className="aspect-video w-full object-cover" muted playsInline aria-label="Kamerabild" />
        </div>
        <div className="flex flex-wrap gap-2">
          {kamera.status === 'laeuft' || kamera.status === 'startet' ? (
            <Button type="button" variant="outline" size="sm" onClick={kamera.stoppen}>
              <CameraOff aria-hidden /> Kamera beenden
            </Button>
          ) : hatDetektor ? (
            <Button type="button" variant="outline" size="sm" onClick={() => void kamera.starten()}>
              <Camera aria-hidden /> Kamera
            </Button>
          ) : null}
          {hatDetektor ? (
            <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-input px-3 text-sm font-medium hover:bg-muted">
              <ImageUp className="size-4" aria-hidden /> Bild
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                onChange={async (event) => {
                  const datei = event.target.files?.[0];
                  event.target.value = '';
                  if (!datei) return;
                  const text = await ausBild(datei).catch(() => null);
                  if (text) void aufloesen(text);
                  else setBildHinweis('Auf dem Bild wurde kein Code erkannt.');
                }}
              />
            </label>
          ) : null}
        </div>
        {/*
          Ohne Erkennung im Browser gar kein Kameraknopf, sondern gleich der
          Hinweis (2026-09-27) — vorher führte der Knopf nur zu dieser Meldung.
        */}
        {kamera.status === 'fehlt' || (!hatDetektor && kamera.status === 'aus') ? (
          <p className="text-sm text-muted-foreground">
            Dieser Browser erkennt keine Codes über die Kamera. Code eintippen, einfügen oder einen Handscanner verwenden.
          </p>
        ) : kamera.status === 'verweigert' ? (
          <p className="text-sm text-muted-foreground" role="status">
            Der Zugriff auf die Kamera wurde nicht erlaubt. In den Einstellungen des Browsers freigeben oder den Code eintippen.
          </p>
        ) : kamera.status === 'keineKamera' ? (
          <p className="text-sm text-muted-foreground" role="status">Auf diesem Gerät wurde keine Kamera gefunden. Code eintippen oder einfügen.</p>
        ) : kamera.status === 'belegt' ? (
          <p className="text-sm text-muted-foreground" role="status">
            Die Kamera wird gerade von einer anderen Anwendung benutzt. Diese schliessen und erneut versuchen.
          </p>
        ) : kamera.status === 'laeuft' && kamera.formate ? (
          <p className="text-xs text-muted-foreground">Erkennt: {kamera.formate.map((f) => f.replace('_', '-').toUpperCase()).join(', ')}</p>
        ) : null}
        {bildHinweis ? <p className="text-sm text-muted-foreground">{bildHinweis}</p> : null}
      </div>

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (eingabe.trim()) void aufloesen(eingabe);
        }}
      >
        <label htmlFor="scan-eingabe" className="sr-only">
          Code eingeben oder einfügen
        </label>
        <input
          ref={feld}
          id="scan-eingabe"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          maxLength={1000}
          value={eingabe}
          onChange={(event) => setEingabe(event.target.value)}
          // Eine eingefügte QR-Rechnung ist mehrzeilig; ein einzeiliges Feld
          // würde die Zeilen verschlucken. Deshalb wird Eingefügtes direkt
          // aufgelöst, mit Zeilen.
          onPaste={(event) => {
            const text = event.clipboardData.getData('text');
            if (/\r|\n/.test(text.trim())) {
              event.preventDefault();
              setEingabe('');
              void aufloesen(text);
            }
          }}
          placeholder="Code eingeben, einfügen oder scannen"
          className="h-10 min-w-0 flex-1 rounded-xl border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button type="submit" disabled={!eingabe.trim() || zustand.status === 'laedt'}>
          Suchen
        </Button>
      </form>

      <div aria-live="polite" className="space-y-3">
        {zustand.status === 'laedt' ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Wird ausgewertet …
          </p>
        ) : zustand.status === 'fehler' ? (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden /> {zustand.meldung}
          </p>
        ) : zustand.status === 'fertig' ? (
          <>
            <p className="text-xs text-muted-foreground" data-scan-eingabe>
              Gescannt{zustand.ergebnis.eingabe.format ? ` (${zustand.ergebnis.eingabe.format})` : ''}:{' '}
              <span className="font-mono">{zustand.ergebnis.eingabe.anzeige}</span>
            </p>
            {zustand.ergebnis.hinweis ? (
              <p className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm" data-scan-hinweis>
                {zustand.ergebnis.hinweis}
              </p>
            ) : null}
            {zustand.ergebnis.neuerArtikel ? (
              maske?.trefferId === '__neu__' ? null : (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setMaske({ trefferId: '__neu__', maske: neuerArtikelMaske(zustand.ergebnis.neuerArtikel!.barcode) })}
                >
                  <PackagePlus aria-hidden /> Neuen Artikel erfassen
                </Button>
              )
            ) : null}
            {maske?.trefferId === '__neu__' ? (
              <AktionsForm maske={maske.maske} onFertig={() => void aufloesen(zustand.text)} onAbbruch={() => setMaske(null)} />
            ) : null}
            <ul className="space-y-3">
              {zustand.ergebnis.treffer.map((t) => (
                <li key={`${t.art}-${t.id}`} className="rounded-xl border border-border bg-card p-3 shadow-soft" data-scan-treffer={t.art}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{ART_LABEL[t.art]}</p>
                      <p className="truncate font-medium">{t.titel}</p>
                      {t.untertitel ? <p className="truncate text-xs text-muted-foreground">{t.untertitel}</p> : null}
                    </div>
                    {t.link ? (
                      <Button asChild size="sm" variant="ghost">
                        <Link href={t.link}>Öffnen</Link>
                      </Button>
                    ) : null}
                  </div>
                  {t.merkmale.length ? (
                    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                      {t.merkmale.map((m) => (
                        <React.Fragment key={m.label}>
                          <dt className="text-muted-foreground">{m.label}</dt>
                          <dd className="num">{m.wert}</dd>
                        </React.Fragment>
                      ))}
                    </dl>
                  ) : null}
                  {t.aktionen.length || t.etikett ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {t.aktionen.map((a) => (
                        <Button
                          key={a.schluessel}
                          type="button"
                          size="sm"
                          variant={maske?.trefferId === t.id && maske.maske.titel === aktionsMaske(a.schluessel, t.id).titel ? 'default' : 'outline'}
                          onClick={() => setMaske({ trefferId: t.id, maske: aktionsMaske(a.schluessel, t.id) })}
                        >
                          {a.label}
                        </Button>
                      ))}
                      {t.etikett ? (
                        <Button asChild size="sm" variant="ghost">
                          <Link href={t.etikett}>
                            <Tag aria-hidden /> Etikett
                          </Link>
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  {maske?.trefferId === t.id ? (
                    <AktionsForm maske={maske.maske} onFertig={() => void aufloesen(zustand.text)} onAbbruch={() => setMaske(null)} />
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <QrCode className="size-4" aria-hidden /> Etikett, Strichcode, QR-Rechnung oder Nummer.
          </p>
        )}
      </div>
    </div>
  );
}

function AktionsForm({ maske, onFertig, onAbbruch }: { maske: AktionsMaske; onFertig: () => void; onAbbruch: () => void }) {
  return (
    <div className="mt-3 rounded-lg border border-border bg-background p-3" data-scan-maske={maske.titel}>
      <p className="mb-3 text-sm font-semibold">{maske.titel}</p>
      <ResourceForm
        // Neue Maske, neuer Zustand — sonst trüge die Entnahme die Menge des Eingangs.
        key={`${maske.endpoint}-${maske.titel}`}
        fields={maske.fields}
        values={maske.values}
        extra={maske.extra}
        endpoint={maske.endpoint}
        submitLabel={maske.submitLabel}
        successMessage={maske.successMessage}
        onCancel={onAbbruch}
        onSuccess={onFertig}
      />
    </div>
  );
}

/**
 * Der Knopf im Kopf. Der Dialog und damit Kamera und Eingabe entstehen erst
 * beim Öffnen; beim Schliessen wird alles abgebaut, die Kamera eingeschlossen.
 */
export function ScanButton() {
  const [offen, setOffen] = React.useState(false);
  return (
    <>
      {/*
        `DialogTrigger` statt eines Knopfs mit eigenem `onClick` (2026-09-27):
        Nur so weiss Radix, wohin der Fokus nach dem Schliessen zurückgehört.
        Vorher landete er nach Escape im Dokument, und wer mit der Tastatur
        arbeitet, begann wieder oben auf der Seite (gefunden von der
        Oberflächenprüfung, `phase21-oberflaeche.spec.ts`).
      */}
      <Dialog open={offen} onOpenChange={setOffen}>
        <DialogTrigger asChild>
          <Button type="button" variant="ghost" size="icon" aria-label="Scannen" title="Scannen">
            <ScanLine aria-hidden />
          </Button>
        </DialogTrigger>
        <DialogContent className="top-4 translate-y-0 gap-3 p-4 sm:top-16" size="lg">
          <DialogHeader>
            <DialogTitle className="text-base">Scannen</DialogTitle>
            <DialogDescription>Nichts wird automatisch geöffnet oder geändert — Sie wählen, was geschieht.</DialogDescription>
          </DialogHeader>
          {offen ? <ScanInhalt /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
