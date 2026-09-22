'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { bewerte, beurteile } from '@/lib/quality/bewertung';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/form';
import { Input, Textarea } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/overlays';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/controls';

/**
 * Die Maske der Qualitätsbegehung.
 *
 * ---------------------------------------------------------------------------
 *  Warum eine eigene Komponente und kein `FieldSpec[]`
 * ---------------------------------------------------------------------------
 *
 * Eine Begehung ist eine **Liste von Bewertungen**, keine Reihe von Feldern.
 * Wer vor Ort steht, trägt Zeile für Zeile ein und will dabei sehen, wo er
 * steht — nicht erst nach dem Absenden. `ResourceForm` kann das nicht, und es
 * soll es auch nicht können: Dafür gibt es sonst eine zweite, halbherzige
 * Listenverwaltung in einem Baustein, der für flache Formulare gedacht ist.
 *
 * ---------------------------------------------------------------------------
 *  Die Zwischenanzeige ist eine Vorschau, kein Ergebnis
 * ---------------------------------------------------------------------------
 *
 * Die Punktzahl unten rechnet **derselbe reine Kern** wie der Server
 * (`src/lib/quality/bewertung.ts`) — deshalb stimmen beide überein, ohne dass
 * die Zahl je mitgeschickt würde. Verbindlich ist ausschliesslich, was der
 * Server zurückgibt; diese Anzeige sagt nur, wohin es gerade läuft.
 *
 * Das ist dieselbe Trennung wie bei der Preisberechnung des
 * Buchungsformulars, nur umgekehrt herum: Dort fragt der Client den Server,
 * hier teilen sich beide die Funktion. Für eine Begehung im Keller ohne
 * Empfang ist das der Unterschied zwischen benutzbar und nicht.
 */

interface Position {
  label: string;
  room: string;
  points: string;
  maxPoints: string;
  weight: string;
  note: string;
}

const LEERE_POSITION: Position = { label: '', room: '', points: '', maxPoints: '5', weight: '1', note: '' };

/** Vorlage für den Normalfall — Unterhaltsreinigung eines Bürogebäudes. */
const VORLAGE: Position[] = [
  { ...LEERE_POSITION, label: 'Eingang und Empfang' },
  { ...LEERE_POSITION, label: 'Büroflächen' },
  { ...LEERE_POSITION, label: 'Sanitärbereiche', weight: '2' },
  { ...LEERE_POSITION, label: 'Küche und Aufenthalt', weight: '2' },
  { ...LEERE_POSITION, label: 'Treppenhaus und Gänge' },
];

const zahl = (text: string, ersatz = 0): number => {
  const wert = Number.parseFloat(text.replace(',', '.'));
  return Number.isFinite(wert) ? wert : ersatz;
};

export function BegehungDialog({
  contractId,
  propertyId,
  zielwert,
  followUpOfId,
  auslöser,
}: {
  contractId?: string;
  propertyId?: string;
  /** Der zugesagte Zielwert — nur zur Vorschau; verbindlich rechnet der Server. */
  zielwert?: number | null;
  /** Diese Begehung korrigiert jene. */
  followUpOfId?: string;
  auslöser?: string;
}) {
  const router = useRouter();
  const [offen, setOffen] = React.useState(false);
  const [datum, setDatum] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [positionen, setPositionen] = React.useState<Position[]>(VORLAGE);
  const [notiz, setNotiz] = React.useState('');
  const [interneNotiz, setInterneNotiz] = React.useState('');
  const [speichert, setSpeichert] = React.useState(false);
  const [fehler, setFehler] = React.useState<string | null>(null);

  // Beim Öffnen zurück auf die Vorlage: Ein abgebrochener Versuch soll beim
  // nächsten Öffnen nicht als halbe Begehung wieder dastehen.
  React.useEffect(() => {
    if (!offen) return;
    setDatum(new Date().toISOString().slice(0, 10));
    setPositionen(VORLAGE);
    setNotiz('');
    setInterneNotiz('');
    setFehler(null);
  }, [offen]);

  const vorschau = bewerte(
    positionen
      .filter((p) => p.label.trim().length >= 2)
      .map((p) => ({
        punkte: zahl(p.points),
        maximum: zahl(p.maxPoints, 5),
        gewicht: zahl(p.weight, 1),
      })),
  );
  const urteil = beurteile(vorschau.prozent, zielwert ?? null);

  const setzen = (index: number, feld: keyof Position, wert: string) =>
    setPositionen((alt) => alt.map((p, i) => (i === index ? { ...p, [feld]: wert } : p)));

  const speichern = async (event: React.FormEvent) => {
    event.preventDefault();
    setSpeichert(true);
    setFehler(null);

    try {
      const items = positionen
        .filter((p) => p.label.trim().length >= 2)
        .map((p, index) => ({
          label: p.label.trim(),
          room: p.room.trim() || undefined,
          points: zahl(p.points),
          maxPoints: zahl(p.maxPoints, 5),
          weight: zahl(p.weight, 1),
          note: p.note.trim() || undefined,
          position: index,
        }));

      if (items.length === 0) {
        setFehler('Bitte tragen Sie mindestens eine Position mit Bezeichnung ein.');
        return;
      }

      const antwort = await api.post<{ data: { id: string } }>('/api/quality-inspections', {
        contractId,
        propertyId,
        followUpOfId,
        // Der Tag reicht; die Uhrzeit einer Begehung ist keine Angabe, die
        // jemand verlässlich nachträgt.
        inspectedAt: new Date(`${datum}T12:00:00`).toISOString(),
        note: notiz.trim() || undefined,
        internalNote: interneNotiz.trim() || undefined,
        items,
      });

      toast.success('Die Begehung ist als Entwurf erfasst.');
      setOffen(false);
      router.push(`/admin/qualitaet/${antwort.data.id}`);
    } catch (error) {
      setFehler(error instanceof ApiError ? error.message : 'Die Begehung liess sich nicht speichern.');
    } finally {
      setSpeichert(false);
    }
  };

  return (
    <Dialog open={offen} onOpenChange={setOffen}>
      <DialogTrigger asChild>
        <Button variant={followUpOfId ? 'outline' : 'default'} size="sm">
          {followUpOfId ? null : <Plus aria-hidden />}
          {auslöser ?? (followUpOfId ? 'Nachkontrolle' : 'Begehung erfassen')}
        </Button>
      </DialogTrigger>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{followUpOfId ? 'Nachkontrolle erfassen' : 'Qualitätsbegehung erfassen'}</DialogTitle>
          <DialogDescription>
            Die Begehung entsteht als Entwurf und lässt sich danach noch ändern. Erst mit dem Abschluss wird sie
            zum Beleg — dann ist sie unveränderlich.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={speichern} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="begehung-datum">Begangen am</Label>
              <Input
                id="begehung-datum"
                type="date"
                value={datum}
                onChange={(e) => setDatum(e.target.value)}
                required
              />
              <p className="text-meta text-muted-foreground">
                Nicht das Erfassungsdatum. Danach richtet sich, welche Vertragsfassung als Massstab gilt.
              </p>
            </div>
            {zielwert != null ? (
              <div className="space-y-1.5">
                <Label>Zugesagter Zielwert</Label>
                <p className="pt-2 text-sm font-medium tabular-nums">{zielwert} %</p>
                <p className="text-meta text-muted-foreground">Aus der Vertragsfassung, die am Begehungstag galt.</p>
              </div>
            ) : null}
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Bewertung</legend>
            <div className="space-y-2">
              {positionen.map((position, index) => (
                <div key={index} className="grid gap-2 rounded-xl border border-border p-3 sm:grid-cols-12">
                  <div className="sm:col-span-4">
                    <Input
                      aria-label={`Kriterium ${index + 1}`}
                      placeholder="Was wurde beurteilt"
                      value={position.label}
                      onChange={(e) => setzen(index, 'label', e.target.value)}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <Input
                      aria-label={`Ort ${index + 1}`}
                      placeholder="Etage, Zone"
                      value={position.room}
                      onChange={(e) => setzen(index, 'room', e.target.value)}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <Input
                      aria-label={`Punkte ${index + 1}`}
                      inputMode="decimal"
                      placeholder="Punkte"
                      value={position.points}
                      onChange={(e) => setzen(index, 'points', e.target.value)}
                    />
                  </div>
                  <div className="sm:col-span-1">
                    <Input
                      aria-label={`Von ${index + 1}`}
                      inputMode="decimal"
                      value={position.maxPoints}
                      onChange={(e) => setzen(index, 'maxPoints', e.target.value)}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <Select value={position.weight} onValueChange={(wert) => setzen(index, 'weight', wert)}>
                      <SelectTrigger aria-label={`Gewicht ${index + 1}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {/*
                          Gewicht 0 ist der Weg, etwas zu erfassen, das an
                          diesem Tag nicht beurteilbar war — der Keller war
                          verschlossen. „Nicht geprüft" ist keine schlechte
                          Note, und deshalb darf es nicht als null Punkte in
                          die Rechnung gehen.
                        */}
                        <SelectItem value="0">nicht beurteilbar</SelectItem>
                        <SelectItem value="1">einfach</SelectItem>
                        <SelectItem value="2">doppelt</SelectItem>
                        <SelectItem value="3">dreifach</SelectItem>
                        <SelectItem value="4">vierfach</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center justify-end sm:col-span-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Position ${index + 1} entfernen`}
                      onClick={() => setPositionen((alt) => alt.filter((_, i) => i !== index))}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                  <div className="sm:col-span-12">
                    <Input
                      aria-label={`Bemerkung ${index + 1}`}
                      placeholder="Bemerkung (erscheint im Bericht)"
                      value={position.note}
                      onChange={(e) => setzen(index, 'note', e.target.value)}
                    />
                  </div>
                </div>
              ))}
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPositionen((alt) => [...alt, { ...LEERE_POSITION }])}
            >
              <Plus aria-hidden />
              Position hinzufügen
            </Button>
          </fieldset>

          {/*
            Die Vorschau rechnet derselbe reine Kern wie der Server. Deshalb
            stimmen beide überein, ohne dass die Zahl je mitgeschickt würde —
            verbindlich ist ausschliesslich, was der Server zurückgibt.
          */}
          <div className="rounded-xl border border-border bg-muted/40 p-3 text-sm">
            <span className="font-medium tabular-nums">
              {vorschau.prozent === null ? 'Noch nichts beurteilbar' : `${vorschau.prozent} %`}
            </span>
            <span className="ml-2 text-muted-foreground tabular-nums">
              {vorschau.erreicht} von {vorschau.moeglich} Punkten
              {vorschau.ausgeklammert > 0 ? ` · ${vorschau.ausgeklammert} nicht beurteilbar` : ''}
            </span>
            {urteil !== 'OHNE_ZIEL' ? (
              <span className="ml-2 text-muted-foreground">
                · voraussichtlich {urteil === 'BESTANDEN' ? 'bestanden' : urteil === 'KNAPP' ? 'knapp' : 'nicht bestanden'}
              </span>
            ) : null}
            <p className="mt-1 text-meta text-muted-foreground">
              Vorschau. Verbindlich ist die Berechnung des Servers beim Speichern.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="begehung-notiz">Befund</Label>
            <Textarea
              id="begehung-notiz"
              rows={2}
              value={notiz}
              onChange={(e) => setNotiz(e.target.value)}
              placeholder="Was der Kundschaft mitgeteilt wird"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="begehung-intern">Interne Notiz</Label>
            <Textarea
              id="begehung-intern"
              rows={2}
              value={interneNotiz}
              onChange={(e) => setInterneNotiz(e.target.value)}
              placeholder="Nur für den Betrieb sichtbar"
            />
          </div>

          {fehler ? <p className="text-sm text-destructive">{fehler}</p> : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOffen(false)}>
              Abbrechen
            </Button>
            <Button type="submit" loading={speichert}>
              Als Entwurf speichern
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
