'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/form';
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
 * Qualifikationen und Arbeitszeiten bearbeiten.
 *
 * ---------------------------------------------------------------------------
 *  Warum eine eigene Komponente und nicht `FormDialog`
 * ---------------------------------------------------------------------------
 *
 * `ResourceForm`/`FormDialog` sind über eine `FieldSpec[]` gesteuert und
 * bilden damit **einen** Datensatz ab: ein Feld, ein Wert. Hier geht es um
 * Listen, deren Länge die bearbeitende Person bestimmt — Zeilen kommen dazu
 * und fallen weg.
 *
 * Das in `FieldSpec` unterzubringen hiesse, dort einen Feldtyp „Liste von
 * Teilformularen" einzuführen, mit eigener Zustandsverwaltung, eigener
 * Fehlerzuordnung je Zeile und eigenem Zusammenbau. Das wäre eine
 * Verallgemeinerung für zwei Verwendungen — und `resource-form.tsx` ist die
 * Datei, die jede CRUD-Maske der Anwendung trägt. Die zwei Listen kosten hier
 * weniger, als sie dort anrichten würden.
 *
 * ---------------------------------------------------------------------------
 *  Warum die ganze Liste geschickt wird
 * ---------------------------------------------------------------------------
 *
 * Der Endpunkt ersetzt sie als Ganzes (`PUT`). Die Maske muss deshalb keine
 * Unterschiede ausrechnen, und zwei offene Browserfenster ergeben am Ende die
 * zuletzt gespeicherte Fassung — nicht eine Mischung, in der ein gelöschter
 * Eintrag wieder auftaucht.
 */

// ---------------------------------------------------------------------------
//  Qualifikationen
// ---------------------------------------------------------------------------

export interface SkillZeile {
  name: string;
  level: number;
  certifiedUntil: string | null;
}

export function EmployeeSkillsDialog({
  employeeId,
  skills,
}: {
  employeeId: string;
  skills: SkillZeile[];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [zeilen, setZeilen] = React.useState<SkillZeile[]>(skills);
  const [laeuft, setLaeuft] = React.useState(false);
  const [fehler, setFehler] = React.useState<string | null>(null);

  /**
   * Beim Öffnen auf den Serverstand zurücksetzen.
   *
   * Ohne das behielte der Dialog die abgebrochenen Änderungen des letzten
   * Versuchs — und wer ihn ein zweites Mal öffnet und speichert, schreibt, was
   * er vorher verworfen hatte.
   */
  React.useEffect(() => {
    if (open) {
      setZeilen(skills);
      setFehler(null);
    }
  }, [open, skills]);

  const speichern = async () => {
    setLaeuft(true);
    setFehler(null);
    try {
      await api.put(`/api/employees/${employeeId}/skills`, {
        skills: zeilen
          .filter((z) => z.name.trim() !== '')
          .map((z) => ({
            name: z.name.trim(),
            level: z.level,
            certifiedUntil: z.certifiedUntil || null,
          })),
      });
      toast.success('Qualifikationen gespeichert.');
      setOpen(false);
      router.refresh();
    } catch (error) {
      setFehler(
        error instanceof ApiError ? error.message : 'Die Änderung liess sich nicht speichern.',
      );
    } finally {
      setLaeuft(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Qualifikationen bearbeiten
        </Button>
      </DialogTrigger>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Qualifikationen</DialogTitle>
          <DialogDescription>
            Sie bestimmen mit, wer einen Einsatz übernehmen kann, und stehen im
            Personalvorschlag. Die Stufe ist eine Einschätzung von 1 bis 5.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {zeilen.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Noch keine Qualifikation erfasst.
            </p>
          ) : null}

          {zeilen.map((zeile, index) => (
            <div key={index} className="flex flex-wrap items-end gap-2">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor={`skill-${index}`}>Bezeichnung</Label>
                <Input
                  id={`skill-${index}`}
                  value={zeile.name}
                  placeholder="Fensterreinigung"
                  onChange={(e) =>
                    setZeilen((alt) =>
                      alt.map((z, i) => (i === index ? { ...z, name: e.target.value } : z)),
                    )
                  }
                />
              </div>
              <div className="w-20">
                <Label htmlFor={`level-${index}`}>Stufe</Label>
                <Input
                  id={`level-${index}`}
                  type="number"
                  min={1}
                  max={5}
                  value={zeile.level}
                  onChange={(e) =>
                    setZeilen((alt) =>
                      alt.map((z, i) =>
                        i === index ? { ...z, level: Number(e.target.value) || 1 } : z,
                      ),
                    )
                  }
                />
              </div>
              <div className="w-40">
                <Label htmlFor={`cert-${index}`}>Zertifikat bis</Label>
                <Input
                  id={`cert-${index}`}
                  type="date"
                  value={zeile.certifiedUntil ?? ''}
                  onChange={(e) =>
                    setZeilen((alt) =>
                      alt.map((z, i) =>
                        i === index ? { ...z, certifiedUntil: e.target.value || null } : z,
                      ),
                    )
                  }
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`„${zeile.name || 'Zeile'}" entfernen`}
                onClick={() => setZeilen((alt) => alt.filter((_, i) => i !== index))}
              >
                <Trash2 aria-hidden />
              </Button>
            </div>
          ))}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setZeilen((alt) => [...alt, { name: '', level: 1, certifiedUntil: null }])
            }
          >
            <Plus aria-hidden /> Qualifikation hinzufügen
          </Button>

          {fehler ? <p className="text-sm text-destructive">{fehler}</p> : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Abbrechen
          </Button>
          <Button type="button" onClick={speichern} disabled={laeuft}>
            {laeuft ? 'Wird gespeichert …' : 'Speichern'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
//  Arbeitszeiten
// ---------------------------------------------------------------------------

const WOCHENTAGE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

export interface ZeitfensterZeile {
  weekday: number;
  startTime: string;
  endTime: string;
}

export function EmployeeAvailabilityDialog({
  employeeId,
  availability,
}: {
  employeeId: string;
  availability: ZeitfensterZeile[];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [zeilen, setZeilen] = React.useState<ZeitfensterZeile[]>(availability);
  const [laeuft, setLaeuft] = React.useState(false);
  const [fehler, setFehler] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setZeilen(availability);
      setFehler(null);
    }
  }, [open, availability]);

  const speichern = async () => {
    setLaeuft(true);
    setFehler(null);
    try {
      await api.put(`/api/employees/${employeeId}/availability`, { availability: zeilen });
      toast.success('Arbeitszeiten gespeichert.');
      setOpen(false);
      router.refresh();
    } catch (error) {
      setFehler(
        error instanceof ApiError ? error.message : 'Die Änderung liess sich nicht speichern.',
      );
    } finally {
      setLaeuft(false);
    }
  };

  /**
   * Eine flache Liste statt sieben fester Wochentagszeilen.
   *
   * Sieben Zeilen mit „arbeitet von–bis" wären übersichtlicher und liessen
   * genau einen Fall nicht zu, den es in diesem Gewerbe häufig gibt: den
   * geteilten Dienst (morgens Treppenhaus, abends Büroreinigung). Der
   * Endpunkt kann zwei Fenster am selben Tag; eine Maske, die es nicht kann,
   * würde das zweite beim nächsten Speichern **stillschweigend löschen**.
   */
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Arbeitszeiten bearbeiten
        </Button>
      </DialogTrigger>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Arbeitszeiten</DialogTitle>
          <DialogDescription>
            Eine Planungshilfe, keine Zusage: Ein Einsatz ausserhalb dieser Zeiten wird
            beim Zuteilen als Hinweis angezeigt und nicht verhindert. Mehrere Fenster am
            selben Tag sind möglich — etwa für einen geteilten Dienst.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {zeilen.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Keine Arbeitszeiten hinterlegt. Ohne Angabe entfällt der Hinweis beim
              Zuteilen.
            </p>
          ) : null}

          {zeilen.map((zeile, index) => (
            <div key={index} className="flex flex-wrap items-end gap-2">
              <div className="min-w-[10rem] flex-1">
                <Label htmlFor={`tag-${index}`}>Wochentag</Label>
                <select
                  id={`tag-${index}`}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={zeile.weekday}
                  onChange={(e) =>
                    setZeilen((alt) =>
                      alt.map((z, i) =>
                        i === index ? { ...z, weekday: Number(e.target.value) } : z,
                      ),
                    )
                  }
                >
                  {WOCHENTAGE.map((name, tag) => (
                    <option key={tag} value={tag}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="w-32">
                <Label htmlFor={`von-${index}`}>Von</Label>
                <Input
                  id={`von-${index}`}
                  type="time"
                  value={zeile.startTime}
                  onChange={(e) =>
                    setZeilen((alt) =>
                      alt.map((z, i) => (i === index ? { ...z, startTime: e.target.value } : z)),
                    )
                  }
                />
              </div>
              <div className="w-32">
                <Label htmlFor={`bis-${index}`}>Bis</Label>
                <Input
                  id={`bis-${index}`}
                  type="time"
                  value={zeile.endTime}
                  onChange={(e) =>
                    setZeilen((alt) =>
                      alt.map((z, i) => (i === index ? { ...z, endTime: e.target.value } : z)),
                    )
                  }
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`${WOCHENTAGE[zeile.weekday]} ${zeile.startTime}–${zeile.endTime} entfernen`}
                onClick={() => setZeilen((alt) => alt.filter((_, i) => i !== index))}
              >
                <Trash2 aria-hidden />
              </Button>
            </div>
          ))}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setZeilen((alt) => [...alt, { weekday: 1, startTime: '07:00', endTime: '17:00' }])
            }
          >
            <Plus aria-hidden /> Zeitfenster hinzufügen
          </Button>

          {fehler ? <p className="text-sm text-destructive">{fehler}</p> : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Abbrechen
          </Button>
          <Button type="button" onClick={speichern} disabled={laeuft}>
            {laeuft ? 'Wird gespeichert …' : 'Speichern'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
