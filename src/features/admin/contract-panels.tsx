'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { RHYTHMUS, uhrzeit, WOCHENTAG } from '@/lib/contracts/bezeichnungen';
import { Button } from '@/components/ui/button';
import { Checkbox, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/controls';
import { Label } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/overlays';
import { FormDialog, type FieldSpec, type FieldValues } from '@/components/app/resource-form';

/**
 * Die Masken des Vertragsmoduls.
 *
 * ---------------------------------------------------------------------------
 *  Warum hier und nicht auf der Seite
 * ---------------------------------------------------------------------------
 *
 * Zwei Gründe, und beide sind erfahrungsgestützt:
 *
 * **1. `transform` ist eine Funktion.** Der Einsatzplan schickt `weekdays` als
 * Zahlenreihe und Uhrzeiten als Minuten seit Mitternacht — eine Umrechnung,
 * die `ResourceForm` über `transform` erlaubt. Funktionen lassen sich nicht
 * von einer Server- an eine Client-Komponente reichen; die Maske muss also
 * selbst im Browser laufen.
 *
 * **2. Eine Seitendatei unter `src/app` darf nur `default`, `metadata` und die
 * Segmentkonfiguration ausführen.** Feldlisten gehören deshalb ohnehin hierher.
 *
 * Alle Masken schreiben über die **bestehenden Endpunkte** — dieselbe
 * Validierung, dieselbe Rechteprüfung, dasselbe Protokoll wie jeder andere
 * Zugriff. Keine zweite Schreibstrecke, keine Beispielwerte.
 */

// ---------------------------------------------------------------------------
//  Gemeinsame Feldlisten
// ---------------------------------------------------------------------------

const ZYKLUS_OPTIONEN = [
  { value: 'PER_VISIT', label: 'Je Einsatz' },
  { value: 'MONTHLY', label: 'Monatlich' },
  { value: 'QUARTERLY', label: 'Vierteljährlich' },
  { value: 'SEMIANNUAL', label: 'Halbjährlich' },
  { value: 'ANNUAL', label: 'Jährlich' },
];

const PREISMODELL_OPTIONEN = [
  { value: 'FIXED_PERIOD', label: 'Pauschale je Periode' },
  { value: 'FIXED_PER_VISIT', label: 'Pauschale je Einsatz' },
  { value: 'HOURLY', label: 'Nach Stunden' },
  { value: 'UNIT_BASED', label: 'Nach Menge' },
  { value: 'CUSTOM', label: 'Abweichende Vereinbarung' },
];

/**
 * Die Konditionen einer Fassung — vollständig, nicht als Teilmenge.
 *
 * Eine Fassung, die nur im Zusammenhang mit ihrer Vorgängerin lesbar wäre,
 * ist keine Fassung. Deshalb verlangt auch das Schema alle Felder, und die
 * Maske belegt sie aus der geltenden Fassung vor, statt sie leer zu lassen.
 */
const VERSIONSFELDER: FieldSpec[] = [
  { name: 'effectiveFrom', label: 'Gültig ab', type: 'date', required: true, half: true },
  { name: 'reason', label: 'Begründung', type: 'text', required: true, hint: 'Warum es diese Fassung gibt — steht später im Protokoll und im Dokument.' },
  { name: 'pricingModel', label: 'Preismodell', type: 'select', options: PREISMODELL_OPTIONEN, required: true, half: true },
  { name: 'baseAmount', label: 'Betrag', type: 'number', step: 0.05, min: 0, required: true, half: true, suffix: 'CHF' },
  { name: 'hourlyRate', label: 'Stundensatz', type: 'number', step: 0.05, min: 0, half: true, suffix: 'CHF', nullable: true, hint: 'Nur bei Abrechnung nach Stunden.' },
  { name: 'unitPrice', label: 'Einzelpreis', type: 'number', step: 0.0001, min: 0, half: true, nullable: true, hint: 'Nur bei mengenabhängigem Preis.' },
  { name: 'unitLabel', label: 'Einheit', type: 'text', half: true, nullable: true, placeholder: 'm², Fenster, Stockwerk' },
  { name: 'vatRate', label: 'MWST', type: 'number', step: 0.1, min: 0, max: 30, required: true, half: true, suffix: '%' },
  { name: 'billingCycle', label: 'Abrechnung', type: 'select', options: ZYKLUS_OPTIONEN, required: true, half: true },
  { name: 'paymentTermDays', label: 'Zahlungsziel', type: 'number', min: 0, max: 180, required: true, half: true, suffix: 'Tage' },
  { name: 'noticePeriodDays', label: 'Kündigungsfrist', type: 'number', min: 0, max: 730, required: true, half: true, suffix: 'Tage' },
  { name: 'minimumTermMonths', label: 'Mindestlaufzeit', type: 'number', min: 0, max: 120, half: true, suffix: 'Monate', nullable: true },
  {
    name: 'renewalType',
    label: 'Verlängerung',
    type: 'select',
    options: [
      { value: 'NONE', label: 'Keine — endet zum Enddatum' },
      { value: 'AUTOMATIC', label: 'Automatisch' },
      { value: 'MANUAL', label: 'Nur auf ausdrücklichen Wunsch' },
    ],
    required: true,
    half: true,
  },
  { name: 'renewalPeriodMonths', label: 'Verlängert sich um', type: 'number', min: 1, max: 120, half: true, suffix: 'Monate', nullable: true },
  { name: 'indexReference', label: 'Indexierung', type: 'text', half: true, nullable: true, placeholder: 'LIK Dezember', hint: 'Worauf sich die Parteien geeinigt haben. Erhöht nichts von selbst.' },
  { name: 'nextReviewAt', label: 'Nächste Preisprüfung', type: 'date', half: true, nullable: true },
  { name: 'targetQualityScore', label: 'Qualitätszielwert', type: 'number', min: 0, max: 100, half: true, nullable: true },
  { name: 'inspectionIntervalDays', label: 'Kontrolle alle', type: 'number', min: 1, max: 365, half: true, suffix: 'Tage', nullable: true },
  { name: 'responseHours', label: 'Reaktionszeit', type: 'number', min: 1, max: 720, half: true, suffix: 'Stunden', nullable: true },
  { name: 'slaNote', label: 'SLA-Hinweis', type: 'textarea', rows: 2, nullable: true },
  { name: 'terms', label: 'Vertragsbedingungen', type: 'textarea', rows: 4, nullable: true, hint: 'Erscheint im Vertragsdokument zur Unterzeichnung.' },
  { name: 'internalNote', label: 'Interne Notiz', type: 'textarea', rows: 2, nullable: true, hint: 'Steht nicht im Kundendokument.' },
];

// ---------------------------------------------------------------------------
//  Fassungen
// ---------------------------------------------------------------------------

export function NeueVersionDialog({
  contractId,
  vorlage,
}: {
  contractId: string;
  /** Die geltende Fassung — als Vorbelegung, damit niemand alles neu tippt. */
  vorlage?: FieldValues;
}) {
  return (
    <FormDialog
      title="Neue Vertragsversion"
      description="Eine geltende Fassung wird nie geändert, sondern abgelöst. Die neue Fassung gilt ab ihrem Stichtag; alles davor bleibt, wie es war."
      triggerLabel="Neue Version"
      triggerVariant="outline"
      triggerSize="sm"
      fields={VERSIONSFELDER}
      values={vorlage}
      endpoint={`/api/contracts/${contractId}/versions`}
      method="POST"
      submitLabel="Version anlegen"
      successMessage="Die Version ist angelegt. Sie gilt, sobald der Vertrag mit ihrem Stichtag in Kraft gesetzt wird."
      /*
        Der Endpunkt nimmt `{ version, services? }` entgegen, nicht die Felder
        flach: Ohne `services` kopiert er den Leistungsumfang der geltenden
        Fassung samt Einsatzplänen — und dieser Unterschied gehört sichtbar in
        den Rumpf, nicht in eine Vermutung des Servers.
      */
      transform={(payload) => ({ version: payload })}
    />
  );
}

export function VersionBearbeitenDialog({
  contractId,
  versionId,
  werte,
}: {
  contractId: string;
  versionId: string;
  werte: FieldValues;
}) {
  return (
    <FormDialog
      title="Versionsentwurf ändern"
      description="Nur Entwürfe lassen sich ändern — und auch die nicht mehr, sobald sie zur Unterzeichnung vorliegen."
      triggerLabel="Entwurf bearbeiten"
      triggerVariant="outline"
      triggerSize="sm"
      plainTrigger
      fields={VERSIONSFELDER}
      values={werte}
      endpoint={`/api/contracts/${contractId}/versions/${versionId}`}
      method="PATCH"
      submitLabel="Änderungen speichern"
      successMessage="Der Entwurf ist geändert."
    />
  );
}

// ---------------------------------------------------------------------------
//  Einsatzplan
// ---------------------------------------------------------------------------

interface PlanWerte {
  id?: string;
  frequency: string;
  interval: number;
  weekdays: number[];
  monthDay: number | null;
  startMinute: number;
  endMinute: number;
  effectiveFrom: string;
  effectiveUntil: string | null;
  holidayHandling: string;
  active: boolean;
}

const LEERER_PLAN: PlanWerte = {
  frequency: 'WEEKLY',
  interval: 1,
  weekdays: [1],
  monthDay: null,
  startMinute: 360,
  endMinute: 600,
  effectiveFrom: new Date().toISOString().slice(0, 10),
  effectiveUntil: null,
  holidayHandling: 'SKIP',
  active: true,
};

/**
 * Die Maske des Einsatzplans — eigene Komponente statt `FormDialog`.
 *
 * Drei Felder passen nicht in eine flache Feldliste: Wochentage sind eine
 * Menge (und als Textfeld „1,3,5" eine Einladung zum Vertippen), und die
 * Uhrzeiten stehen in der Datenbank als **Minuten seit Mitternacht** — weil
 * ein Zeitfenster keine Zeitpunktangabe ist und „ab 06:00" über die
 * Sommerzeit hinweg richtig bleiben muss, ein UTC-Zeitpunkt aber nicht.
 * Die Umrechnung steht hier, an einer Stelle, statt im Kopf der Nutzenden.
 */
export function EinsatzplanDialog({
  contractServiceId,
  plan,
  auslöser,
}: {
  contractServiceId: string;
  /** Vorhandener Plan = ändern; ohne = anlegen. */
  plan?: PlanWerte;
  auslöser?: string;
}) {
  const router = useRouter();
  const [offen, setOffen] = React.useState(false);
  const [werte, setWerte] = React.useState<PlanWerte>(plan ?? LEERER_PLAN);
  const [speichert, setSpeichert] = React.useState(false);
  const [fehler, setFehler] = React.useState<string | null>(null);

  // Beim Öffnen zurück auf den gespeicherten Stand: Ein abgebrochener Versuch
  // soll beim nächsten Öffnen nicht als halbe Eingabe wieder dastehen.
  React.useEffect(() => {
    if (offen) setWerte(plan ?? LEERER_PLAN);
  }, [offen, plan]);

  const wochenrhythmus = werte.frequency === 'WEEKLY' || werte.frequency === 'BIWEEKLY';

  const speichern = async (event: React.FormEvent) => {
    event.preventDefault();
    setSpeichert(true);
    setFehler(null);
    try {
      const rumpf = {
        frequency: werte.frequency,
        interval: werte.interval,
        weekdays: wochenrhythmus ? werte.weekdays : [],
        monthDay: wochenrhythmus ? undefined : (werte.monthDay ?? undefined),
        startMinute: werte.startMinute,
        endMinute: werte.endMinute,
        effectiveFrom: werte.effectiveFrom,
        effectiveUntil: werte.effectiveUntil || undefined,
        holidayHandling: werte.holidayHandling,
        active: werte.active,
      };
      if (plan?.id) await api.patch(`/api/contract-schedules/${plan.id}`, rumpf);
      else await api.post(`/api/contract-services/${contractServiceId}/schedules`, rumpf);

      toast.success(plan?.id ? 'Der Einsatzplan ist geändert.' : 'Der Einsatzplan ist angelegt.');
      setOffen(false);
      router.refresh();
    } catch (error) {
      setFehler(error instanceof ApiError ? error.message : 'Der Einsatzplan liess sich nicht speichern.');
    } finally {
      setSpeichert(false);
    }
  };

  return (
    <Dialog open={offen} onOpenChange={setOffen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          {auslöser ?? (plan?.id ? 'Plan bearbeiten' : 'Einsatzplan anlegen')}
        </Button>
      </DialogTrigger>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{plan?.id ? 'Einsatzplan ändern' : 'Einsatzplan anlegen'}</DialogTitle>
          <DialogDescription>
            Aus dieser Regel erzeugt der nächtliche Lauf die Einsätze. Bereits geplante Termine bleiben unberührt —
            einen einzelnen Termin verschiebt man über eine Ausnahme.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={speichern} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="plan-frequenz">Rhythmus</Label>
              <Select
                value={werte.frequency}
                onValueChange={(wert) => setWerte((v) => ({ ...v, frequency: wert }))}
              >
                <SelectTrigger id="plan-frequenz">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'].map((wert) => (
                    <SelectItem key={wert} value={wert}>
                      {RHYTHMUS[wert] ?? wert}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="plan-intervall">Jede n-te Periode</Label>
              <Input
                id="plan-intervall"
                type="number"
                min={1}
                max={52}
                value={werte.interval}
                onChange={(e) => setWerte((v) => ({ ...v, interval: Number(e.target.value) || 1 }))}
              />
              <p className="text-meta text-muted-foreground">
                1 = jede Periode. Zusammen mit dem Rhythmus ergibt das „alle drei Wochen“.
              </p>
            </div>
          </div>

          {wochenrhythmus ? (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Wochentage</legend>
              <div className="flex flex-wrap gap-3">
                {WOCHENTAG.map((name, tag) => (
                  <label key={tag} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={werte.weekdays.includes(tag)}
                      onCheckedChange={(an) =>
                        setWerte((v) => ({
                          ...v,
                          weekdays: an
                            ? [...v.weekdays, tag].sort((a, b) => a - b)
                            : v.weekdays.filter((t) => t !== tag),
                        }))
                      }
                    />
                    {name.slice(0, 2)}
                  </label>
                ))}
              </div>
              <p className="text-meta text-muted-foreground">
                Ohne Wochentag fände der Planer nie einen Termin — das Formular wird dann abgewiesen.
              </p>
            </fieldset>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="plan-monatstag">Tag im Monat</Label>
              <Input
                id="plan-monatstag"
                type="number"
                min={1}
                max={31}
                value={werte.monthDay ?? ''}
                onChange={(e) =>
                  setWerte((v) => ({ ...v, monthDay: e.target.value === '' ? null : Number(e.target.value) }))
                }
              />
              <p className="text-meta text-muted-foreground">
                Leer = derselbe Tag wie der Beginn. Der 31. rutscht in kürzeren Monaten auf den letzten Tag.
              </p>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="plan-von">Zeitfenster von</Label>
              <Input
                id="plan-von"
                type="time"
                value={uhrzeit(werte.startMinute)}
                onChange={(e) => setWerte((v) => ({ ...v, startMinute: alsMinuten(e.target.value, v.startMinute) }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plan-bis">bis</Label>
              <Input
                id="plan-bis"
                type="time"
                value={uhrzeit(werte.endMinute)}
                onChange={(e) => setWerte((v) => ({ ...v, endMinute: alsMinuten(e.target.value, v.endMinute) }))}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="plan-ab">Plan gilt ab</Label>
              <Input
                id="plan-ab"
                type="date"
                value={werte.effectiveFrom}
                onChange={(e) => setWerte((v) => ({ ...v, effectiveFrom: e.target.value }))}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plan-bis-datum">und bis (optional)</Label>
              <Input
                id="plan-bis-datum"
                type="date"
                value={werte.effectiveUntil ?? ''}
                onChange={(e) => setWerte((v) => ({ ...v, effectiveUntil: e.target.value || null }))}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="plan-feiertag">An Feiertagen</Label>
            <Select
              value={werte.holidayHandling}
              onValueChange={(wert) => setWerte((v) => ({ ...v, holidayHandling: wert }))}
            >
              <SelectTrigger id="plan-feiertag">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="SKIP">Termin entfällt</SelectItem>
                <SelectItem value="IGNORE">Termin bleibt stehen</SelectItem>
                <SelectItem value="MOVE_BEFORE">Auf den Werktag davor</SelectItem>
                <SelectItem value="MOVE_AFTER">Auf den Werktag danach</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-meta text-muted-foreground">
              Massgebend sind die Feiertage des Kantons Bern.
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={werte.active}
              onCheckedChange={(an) => setWerte((v) => ({ ...v, active: an === true }))}
            />
            Plan ist aktiv
          </label>

          {fehler ? <p className="text-sm text-destructive">{fehler}</p> : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOffen(false)}>
              Abbrechen
            </Button>
            <Button type="submit" loading={speichert}>
              {plan?.id ? 'Änderungen speichern' : 'Plan anlegen'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** „06:00" → 360. Bei unlesbarer Eingabe bleibt der bisherige Wert stehen. */
function alsMinuten(wert: string, rückfall: number): number {
  const treffer = /^(\d{1,2}):(\d{2})$/.exec(wert);
  if (!treffer) return rückfall;
  return Number(treffer[1]) * 60 + Number(treffer[2]);
}

/**
 * Eine Ausnahme ist **keine** Regeländerung.
 *
 * Wer wegen Betriebsferien einen Termin verschiebt, will nicht den Vertrag
 * ändern — und eine Regeländerung wäre eine neue Vertragsversion. Deshalb
 * eine eigene, kleine Maske und ein eigener Endpunkt mit `contract:update`.
 */
export function AusnahmeDialog({ planId }: { planId: string }) {
  return (
    <FormDialog
      title="Einzelnen Termin ändern"
      description="Aussetzen, verschieben oder zusätzlich ansetzen — ohne den Vertrag anzufassen. Eine Ausnahme je Serientag; ein zweiter Eintrag für denselben Tag ersetzt den ersten."
      triggerLabel="Ausnahme"
      triggerVariant="ghost"
      triggerSize="sm"
      size="md"
      fields={[
        {
          name: 'kind',
          label: 'Art',
          type: 'select',
          required: true,
          options: [
            { value: 'SKIP', label: 'Termin entfällt' },
            { value: 'MOVE', label: 'Termin verschieben' },
            { value: 'EXTRA', label: 'Zusätzlicher Termin' },
          ],
        },
        { name: 'originalDate', label: 'Betroffener Termin', type: 'date', required: true, half: true },
        {
          name: 'newDate',
          label: 'Ersatztermin',
          type: 'date',
          half: true,
          hint: 'Nur beim Verschieben.',
        },
        { name: 'reason', label: 'Grund', type: 'text', placeholder: 'Betriebsferien der Kundschaft' },
      ]}
      endpoint={`/api/contract-schedules/${planId}/exceptions`}
      method="POST"
      submitLabel="Ausnahme eintragen"
      successMessage="Die Ausnahme ist eingetragen."
    />
  );
}

// ---------------------------------------------------------------------------
//  Änderungsanträge
// ---------------------------------------------------------------------------

export function AenderungsantragDialog({ contractId }: { contractId: string }) {
  return (
    <FormDialog
      title="Änderung beantragen"
      description="Der Antrag ist nicht die Änderung. Er wird geprüft und freigegeben und wird erst dann wirksam, indem er eine neue Vertragsversion erzeugt."
      triggerLabel="Änderung beantragen"
      triggerVariant="outline"
      triggerSize="sm"
      size="md"
      fields={[
        {
          name: 'type',
          label: 'Gegenstand',
          type: 'select',
          required: true,
          options: [
            { value: 'SCOPE', label: 'Leistungsumfang' },
            { value: 'PRICE', label: 'Preis' },
            { value: 'FREQUENCY', label: 'Frequenz' },
            { value: 'TERM', label: 'Laufzeit' },
            { value: 'SLA', label: 'Qualität / SLA' },
            { value: 'PAYMENT_TERMS', label: 'Zahlungsbedingungen' },
            { value: 'INDEXATION', label: 'Indexierung' },
            { value: 'OTHER', label: 'Anderes' },
          ],
        },
        { name: 'title', label: 'Titel', type: 'text', required: true, placeholder: 'Zusätzliche Fensterreinigung ab Q2' },
        { name: 'effectiveFrom', label: 'Wirksam ab', type: 'date', required: true, half: true },
        { name: 'reason', label: 'Begründung', type: 'textarea', rows: 2, required: true },
        { name: 'description', label: 'Beschreibung', type: 'textarea', rows: 3 },
      ]}
      endpoint={`/api/contracts/${contractId}/amendments`}
      method="POST"
      submitLabel="Antrag stellen"
      successMessage="Der Antrag ist gestellt. Freigeben muss ihn jemand anderes."
    />
  );
}

/**
 * Den freigegebenen Antrag wirksam machen — als neue Fassung.
 *
 * Die Maske trägt die **vollständigen** neuen Konditionen, vorbelegt aus der
 * geltenden Fassung. Eine Version, die aus „dem Vorgänger plus ein paar
 * Feldern" entstünde, wäre nur im Zusammenhang lesbar.
 */
export function AntragAnwendenDialog({
  contractId,
  amendmentId,
  vorlage,
}: {
  contractId: string;
  amendmentId: string;
  vorlage?: FieldValues;
}) {
  return (
    <FormDialog
      title="Änderung übernehmen"
      description="Es entsteht ein Versionsentwurf mit diesen Konditionen. Er gilt erst, wenn jemand mit Aktivierungsrecht „Fassung in Kraft setzen“ wählt — auf Wunsch nach der Annahme durch die Kundschaft."
      triggerLabel="Übernehmen"
      triggerVariant="default"
      triggerSize="sm"
      fields={VERSIONSFELDER}
      values={vorlage}
      endpoint={`/api/contracts/${contractId}/amendments/${amendmentId}/apply`}
      method="POST"
      submitLabel="Versionsentwurf erzeugen"
      successMessage="Der Versionsentwurf ist angelegt. Er gilt ab „Fassung in Kraft setzen“."
      transform={(payload) => ({ version: payload })}
    />
  );
}

// ---------------------------------------------------------------------------
//  Abrechnung
// ---------------------------------------------------------------------------

/**
 * Die Rechnung einer Vertragsperiode auslösen.
 *
 * Kein Betrag und kein Zeitraum in der Maske: Beides ergibt sich aus der
 * geltenden Fassung. Der Stichtag sagt nur, **welche** Periode gemeint ist —
 * liesse man den Zeitraum frei wählen, wären beliebig viele sich
 * überlappende „Perioden" fakturierbar, und der Schutz gegen
 * Doppelabrechnung hätte keinen Schlüssel mehr.
 */
export function VertragsrechnungDialog({ contractId }: { contractId: string }) {
  return (
    <FormDialog
      title="Periode abrechnen"
      description="Der Betrag entsteht aus der geltenden Fassung und den erbrachten Einsätzen. Eine Periode lässt sich nur einmal abrechnen — ein zweiter Versuch zeigt die bestehende Rechnung."
      triggerLabel="Periode abrechnen"
      triggerVariant="outline"
      triggerSize="sm"
      size="md"
      fields={[
        {
          name: 'stichtag',
          label: 'Stichtag in der Periode',
          type: 'date',
          hint: 'Irgendein Tag der gewünschten Periode. Ohne Angabe: die vorige.',
        },
        {
          name: 'sofortAusstellen',
          label: 'Sofort ausstellen',
          type: 'checkbox',
          hint: 'Vergibt die Rechnungsnummer. Danach ist der Beleg unveränderlich — Korrekturen laufen über eine Gutschrift.',
        },
      ]}
      endpoint={`/api/contracts/${contractId}/invoices`}
      method="POST"
      submitLabel="Rechnung erzeugen"
      successMessage="Die Rechnung ist erzeugt."
    />
  );
}

// ---------------------------------------------------------------------------
//  Leistungsumfang eines Entwurfs
// ---------------------------------------------------------------------------

export interface Leistungszeile {
  /**
   * Die Kennung der bestehenden Zeile. Mit ihr behält der Dienst die Zeile
   * samt Einsatzplan; ohne sie entstünde eine neue, und der Plan ginge über
   * die Kaskade verloren (bis 2026-09-23 der Fall).
   */
  id?: string | null;
  serviceId?: string | null;
  label: string;
  description?: string | null;
  zone?: string | null;
  estimatedMinutes: number;
  requiredCrewSize: number;
  /**
   * Mitgeschickt, weil der Endpunkt den Umfang als Ganzes ersetzt: Fehlte das
   * Feld, löschte jede neue Position die Qualifikationen aller bestehenden.
   */
  requiredSkills: string[];
  materialsBy: string;
  quantity?: number | null;
  specialInstructions?: string | null;
}

/** „Hochdruck, Stapler" oder zeilenweise → ["Hochdruck", "Stapler"]. */
export function qualifikationenAus(wert: unknown): string[] {
  return [...new Set(String(wert ?? '').split(/[\n,;]/).map((s) => s.trim()).filter(Boolean))];
}

/**
 * Eine Leistung zum Entwurf hinzufügen.
 *
 * Der Endpunkt nimmt den Leistungsumfang **als Ganzes** — deshalb schickt die
 * Maske die bestehenden Zeilen mit, **mit ihrer Kennung**. Der Dienst behält
 * genannte Zeilen und ihren Einsatzplan, entfernt nicht genannte und legt
 * neue an.
 */
export function LeistungHinzufuegenDialog({
  contractId,
  versionId,
  bestehende,
  leistungen,
}: {
  contractId: string;
  versionId: string;
  bestehende: Leistungszeile[];
  /** Der Leistungskatalog — die Bezeichnung wird daraus vorbelegt. */
  leistungen: { value: string; label: string }[];
}) {
  return (
    <FormDialog
      title="Leistung hinzufügen"
      description="Die Position gehört zu diesem Versionsentwurf. Sobald die Fassung gilt, lässt sich der Umfang nicht mehr ändern — dann braucht es eine neue Version."
      triggerLabel="Leistung hinzufügen"
      triggerVariant="outline"
      triggerSize="sm"
      size="md"
      fields={[
        { name: 'serviceId', label: 'Aus dem Katalog', type: 'select', options: leistungen, hint: 'Ohne Auswahl entsteht eine freie Position.' },
        { name: 'label', label: 'Bezeichnung auf dem Vertrag', type: 'text', required: true },
        { name: 'zone', label: 'Etage, Zone, Trakt', type: 'text', half: true },
        { name: 'estimatedMinutes', label: 'Dauer je Einsatz', type: 'number', min: 5, max: 1440, required: true, half: true, suffix: 'Minuten' },
        { name: 'requiredCrewSize', label: 'Personen', type: 'number', min: 1, max: 50, required: true, half: true },
        {
          name: 'materialsBy',
          label: 'Material stellt',
          type: 'select',
          required: true,
          half: true,
          options: [
            { value: 'PROVIDER', label: 'Clenaris' },
            { value: 'CUSTOMER', label: 'Die Kundschaft' },
          ],
        },
        { name: 'quantity', label: 'Menge', type: 'number', min: 0, half: true, hint: 'Nur bei mengenabhängigem Preis.' },
        {
          name: 'requiredSkills',
          label: 'Verlangte Qualifikationen',
          type: 'textarea',
          rows: 2,
          hint: 'Durch Komma oder Zeilen getrennt, gleich benannt wie in der Personalakte. Wer sie nicht hat, lässt sich für diese Einsätze nicht einteilen.',
        },
        { name: 'specialInstructions', label: 'Besondere Hinweise', type: 'textarea', rows: 2 },
      ]}
      values={{ estimatedMinutes: 120, requiredCrewSize: 1, materialsBy: 'PROVIDER' }}
      endpoint={`/api/contracts/${contractId}/versions/${versionId}/services`}
      method="PUT"
      submitLabel="Position hinzufügen"
      successMessage="Die Leistung gehört jetzt zur Fassung."
      transform={(payload) => ({ services: [...bestehende, { ...payload, requiredSkills: qualifikationenAus(payload.requiredSkills) }] })}
    />
  );
}

/** Eine Position entfernen — dieselbe Regel, nur andersherum. */
export function LeistungEntfernenButton({
  contractId,
  versionId,
  bestehende,
  index,
}: {
  contractId: string;
  versionId: string;
  bestehende: Leistungszeile[];
  index: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  return (
    <Button
      variant="ghost"
      size="sm"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await api.put(`/api/contracts/${contractId}/versions/${versionId}/services`, {
            services: bestehende.filter((_, i) => i !== index),
          });
          toast.success('Die Position ist entfernt.');
          router.refresh();
        } catch (error) {
          toast.error(error instanceof ApiError ? error.message : 'Die Position liess sich nicht entfernen.');
        } finally {
          setBusy(false);
        }
      }}
    >
      Entfernen
    </Button>
  );
}

// ---------------------------------------------------------------------------
//  Lebenslauf: Pause, Kündigung, Verlängerung, Preisanpassung
// ---------------------------------------------------------------------------

/**
 * Pausieren — mit Beginn und optionalem Ende.
 *
 * Bis 2026-09-23 war die Pause ein Knopf: ab heute, ohne Ende. Eine
 * vereinbarte Pause („Betriebsferien 20. Juli bis 10. August") liess sich
 * nicht erfassen. Jetzt stehen beide Tage in der Maske; bereits geplante
 * Einsätze im Zeitraum werden abgesagt, und nach dem Ende setzt der
 * nächtliche Lauf den Vertrag von selbst fort.
 */
export function PauseDialog({ contractId, heute }: { contractId: string; heute: string }) {
  return (
    <FormDialog
      title="Vertrag pausieren"
      description="Im Zeitraum wird nicht gereinigt. Bereits geplante Einsätze darin werden abgesagt; davor und danach bleibt alles. Ohne Ende läuft die Pause, bis jemand fortsetzt."
      triggerLabel="Pausieren"
      triggerVariant="outline"
      triggerSize="sm"
      size="md"
      fields={[
        { name: 'pausedFrom', label: 'Ab', type: 'date', required: true, half: true },
        { name: 'pausedUntil', label: 'Bis und mit', type: 'date', half: true, hint: 'Leer lassen für eine offene Pause.' },
        { name: 'reason', label: 'Grund', type: 'text', required: true, placeholder: 'Betriebsferien der Kundschaft' },
      ]}
      values={{ pausedFrom: heute }}
      endpoint={`/api/contracts/${contractId}/pause`}
      method="POST"
      submitLabel="Pausieren"
      successMessage="Der Vertrag ist pausiert."
    />
  );
}

/**
 * Eine Kündigung erfassen — wer, wann, auf wann.
 *
 * Bis 2026-09-23 schickte der Knopf fest „durch die Kundschaft, heute".
 * Eine Kündigung der Firma oder eine nachgetragene liess sich nicht erfassen.
 */
export function KuendigungDialog({ contractId }: { contractId: string }) {
  return (
    <FormDialog
      title="Kündigung erfassen"
      description="Festgehalten wird, dass gekündigt wurde. Ohne Wirkungsdatum rechnet das System es aus Frist und Laufzeit — ob die Kündigung wirksam ist, entscheidet dieses System nicht. Einsätze nach der Wirkung werden abgesagt."
      triggerLabel="Kündigung erfassen"
      triggerVariant="outline"
      triggerSize="sm"
      size="md"
      fields={[
        {
          name: 'noticeGivenBy',
          label: 'Gekündigt durch',
          type: 'select',
          required: true,
          options: [
            { value: 'CUSTOMER', label: 'Die Kundschaft' },
            { value: 'PROVIDER', label: 'Die Firma' },
          ],
        },
        { name: 'noticeGivenAt', label: 'Gekündigt am', type: 'date', half: true, hint: 'Ohne Angabe: heute.' },
        { name: 'terminationEffectiveAt', label: 'Wirksam auf', type: 'date', half: true, hint: 'Ohne Angabe: gerechnet.' },
        { name: 'reason', label: 'Grund', type: 'textarea', rows: 2 },
      ]}
      values={{ noticeGivenBy: 'CUSTOMER' }}
      endpoint={`/api/contracts/${contractId}/notice`}
      method="POST"
      submitLabel="Kündigung erfassen"
      successMessage="Die Kündigung ist erfasst."
    />
  );
}

/** Verlängern — um die vereinbarte Dauer oder eine angegebene. */
export function VerlaengernDialog({ contractId }: { contractId: string }) {
  return (
    <FormDialog
      title="Vertrag verlängern"
      description="Das Vertragsende verschiebt sich; die Kündigungsfrist wird neu gerechnet. Die Konditionen bleiben — ein anderer Preis ist eine neue Fassung."
      triggerLabel="Verlängern"
      triggerVariant="outline"
      triggerSize="sm"
      size="md"
      fields={[
        { name: 'months', label: 'Um Monate', type: 'number', min: 1, max: 120, hint: 'Ohne Angabe: die vereinbarte Verlängerungsdauer.' },
        { name: 'reason', label: 'Begründung', type: 'textarea', rows: 2, required: true },
      ]}
      endpoint={`/api/contracts/${contractId}/renew`}
      method="POST"
      submitLabel="Verlängern"
      successMessage="Der Vertrag ist verlängert."
    />
  );
}

/**
 * Eine Preisanpassung vorschlagen.
 *
 * Der Endpunkt bestand seit Wave 10, eine Maske nicht (Audit 2026-09-23).
 * Der alte Betrag fehlt in der Maske mit Absicht: Er steht in der geltenden
 * Fassung, und ihn mitschicken zu lassen hiesse, dem Client die Vergangenheit
 * behaupten zu lassen. Freigeben muss eine zweite Person.
 */
export function PreisanpassungDialog({ contractId }: { contractId: string }) {
  return (
    <FormDialog
      title="Preisanpassung vorschlagen"
      description="Der Vorschlag ändert nichts. Nach der Freigabe durch eine zweite Person entsteht daraus ein Versionsentwurf, der mit „Fassung in Kraft setzen“ gilt."
      triggerLabel="Preisanpassung"
      triggerVariant="outline"
      triggerSize="sm"
      size="md"
      fields={[
        { name: 'newAmount', label: 'Neuer Betrag', type: 'number', min: 0, required: true, half: true, suffix: 'CHF' },
        { name: 'effectiveFrom', label: 'Gilt ab', type: 'date', required: true, half: true },
        { name: 'indexReference', label: 'Index', type: 'text', placeholder: 'LIK, Basis Dez. 2025' },
        { name: 'indexNewValue', label: 'Neuer Indexstand', type: 'number', min: 0, half: true },
        { name: 'reviewDueAt', label: 'Nächste Überprüfung', type: 'date', half: true },
        { name: 'reason', label: 'Begründung', type: 'textarea', rows: 2, required: true },
      ]}
      endpoint={`/api/contracts/${contractId}/price-adjustments`}
      method="POST"
      submitLabel="Vorschlagen"
      successMessage="Die Preisanpassung ist vorgeschlagen. Freigeben muss sie jemand anderes."
    />
  );
}

/** Nur zur Anzeige — die Notiz erklärt, warum die Maske fehlt. */
export function GesperrtHinweis({ grund }: { grund: 'ANGENOMMEN' | 'IN_UNTERZEICHNUNG' }) {
  return (
    <p className="text-meta text-muted-foreground">
      {grund === 'ANGENOMMEN'
        ? 'Diese Fassung wurde elektronisch angenommen und ist unveränderlich. Änderungen entstehen als neue Version.'
        : 'Diese Fassung liegt zur Unterzeichnung vor und ist bis dahin eingefroren. Ziehen Sie den Vorgang zurück, wenn die Konditionen noch nicht stimmen.'}
    </p>
  );
}
