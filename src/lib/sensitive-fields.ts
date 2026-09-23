/**
 * Welche Werte nie in ein Protokoll gehören — eine Regel für alle Senken.
 *
 * ---------------------------------------------------------------------------
 *  Warum ein eigenes Modul
 * ---------------------------------------------------------------------------
 *
 * Bis hierher gab es zwei Listen: `REDACTED_FIELDS` im Prüfprotokoll
 * (`src/lib/audit.ts`) und `SECRET_KEYS` im Logger. Beide waren exakte
 * Namenslisten, und beide liefen auseinander — der Logger kannte
 * `refreshToken`, das Prüfprotokoll nicht; das Prüfprotokoll kannte
 * `alarmCode`, der Logger nicht. Und keine von beiden kannte `hourlyRate`,
 * `monthlySalary` oder `birthday`. Das Audit vom 2026-09-23 hat genau das
 * gefunden: `updateEmployee` schrieb die vollständige Eingabe ins
 * Prüfprotokoll, Lohn und Geburtsdatum im Klartext — in eine Tabelle, die man
 * gerade *nicht* bereinigen will, weil sie der Beleg ist.
 *
 * Deshalb eine Regel an einer Stelle, ohne `server-only`, damit auch der
 * Logger sie benutzen kann, und ohne Abhängigkeiten, damit sie sich ohne
 * Server prüfen lässt (`tests/api/protokoll-schwaerzung.test.ts`).
 *
 * ---------------------------------------------------------------------------
 *  Warum Muster und nicht nur eine Namensliste
 * ---------------------------------------------------------------------------
 *
 * Eine exakte Liste versagt beim nächsten Feld, das niemand eingetragen hat:
 * `emergencyPhone` neben `emergencyContact`, `accessToken` neben `token`,
 * `bankAccountNumber` neben `iban`. Ein Teilwort-Muster erfasst die Familie.
 * Der Preis ist, dass es gelegentlich mehr schwärzt als nötig (ein Feld
 * namens `tokenCount` verlöre seinen Wert im Protokoll) — die richtige
 * Fehlerrichtung: Ein zu viel geschwärzter Wert kostet eine Rückfrage, ein zu
 * wenig geschwärzter ist nicht mehr zurückzuholen.
 *
 * Kurze, mehrdeutige Namen (`net`, `pin`, `bvg`) dürfen **nicht** als
 * Teilwort gelten — `net` steckt in `internet`, `pin` in `shipping`. Sie
 * stehen in einer exakten Liste.
 *
 * **Was bleibt sichtbar:** der Schlüssel. Das Protokoll zeigt weiterhin,
 * *dass* sich `monthlySalary` geändert hat — nur nicht, von welchem Betrag
 * auf welchen. Das ist die Grenze, die ein Prüfprotokoll braucht: Wer, wann,
 * was — nicht wie viel.
 */

/** Ersatzwert für einen geschwärzten Wert. */
export const GESCHWAERZT = '[redigiert]';

/**
 * Teilwörter, die einen Schlüssel als sensibel ausweisen.
 *
 * Verglichen wird gegen den **normalisierten** Namen: klein geschrieben, ohne
 * `_`, `-` und Leerzeichen. `monthly_salary`, `monthlySalary` und
 * `Monthly-Salary` sind damit dasselbe.
 */
const SENSIBLE_TEILWOERTER = [
  // Zugangsdaten und Geheimnisse
  'password',
  'passwort',
  'kennwort',
  'secret',
  'token',
  'apikey',
  'privatekey',
  'authorization',
  'cookie',
  'recoverycode',
  'otp',
  'alarmcode',
  'accesscode',
  'zugangscode',
  'signaturedataurl',
  // Bank und Sozialversicherung. Bewusst nicht `ahv` allein: `ahvIvEo` ist
  // der *Beitragssatz* in `PayrollSetting`, Betriebskonfiguration und kein
  // Personendatum — seine Änderung muss im Protokoll nachvollziehbar bleiben.
  'iban',
  'bankaccount',
  'accountnumber',
  'kontonummer',
  'ahvnumber',
  'ahvnr',
  'ahvnummer',
  'socialsecurity',
  // Lohn und Steuern. `hourlyRate` steht bewusst **nicht** hier, sondern je
  // Entität: `Service.hourlyRate` ist der Katalogpreis, und seine Änderung
  // gehört sichtbar ins Protokoll. Der erste Trockenlauf von
  // `scripts/audit-bereinigung.ts` hat genau diese Überschwärzung gefunden.
  'salary',
  'wage',
  'lohn',
  'quellensteuer',
  'withholding',
  'taxid',
  'taxnumber',
  // Gesundheit und Notfall. Nicht `health` allein: Der Gesundheitswert des
  // Betriebs (`healthScore`, Unternehmensführung) ist eine Kennzahl, kein
  // Gesundheitsdatum einer Person.
  'medical',
  'diagnos',
  'krankheit',
  'emergency',
  'notfall',
  // Geburtsdatum
  'birth',
  'geburt',
] as const;

/** Exakte Namen — zu kurz oder zu mehrdeutig für ein Teilwort. */
const SENSIBLE_NAMEN = new Set(['pin', 'cvc', 'cvv']);

/**
 * Felder, die nur **in einer bestimmten Entität** Personendaten sind.
 *
 * `alv` ist in `Payslip` der Betrag, den eine Person abgezogen bekam, in
 * `PayrollSetting` der Satz, den der Betrieb anwendet. `city` ist in
 * `Employee` die Wohnadresse, in `Property` der Einsatzort. Eine globale
 * Regel müsste sich für eine der beiden Lesarten entscheiden und läge bei der
 * anderen falsch — entweder verlöre das Protokoll die Nachvollziehbarkeit
 * einer Satzänderung, oder es hielte Lohnbeträge fest.
 *
 * Die Zuordnung steht trotzdem hier und nicht beim Aufrufer: Eine Liste je
 * Dienst wäre wieder die Liste, die beim nächsten Dienst fehlt.
 */
const ENTITAET_FELDER: Readonly<Record<string, ReadonlySet<string>>> = {
  Employee: new Set([
    'hourlyrate',
    'nationality',
    'permittype',
    'permitvaliduntil',
    'street',
    'postalcode',
    'city',
    'notes',
    'vehicleplate',
  ]),
  Payslip: new Set([
    'hours',
    'grosspay',
    'ahviv',
    'alv',
    'bvg',
    'uvg',
    'ktg',
    'otherdeductions',
    'netpay',
    'breakdown',
    'expenses',
    'employercontributions',
    'reviewreason',
    'reviewnote',
  ]),
  /**
   * Lohnpositionen (Wave 9): Betrag, Stunden, Ansatz — und die Bezeichnung,
   * weil dort „Lohnpfändung Betreibungsamt …" oder „Vorschuss Zahnarzt"
   * stehen kann.
   */
  PayrollItem: new Set(['amount', 'quantity', 'rate', 'surchargepct', 'label', 'note']),
  PayslipLine: new Set(['amount', 'quantity', 'rate', 'label']),
  /**
   * Quellensteuerprofil: Konfession (Kirchensteuer) ist ein besonders
   * schützenswertes Personendatum (Art. 5 DSG), Kinderzahl und Tarif lassen
   * auf Zivilstand und Familie schliessen.
   */
  WithholdingTaxProfile: new Set(['canton', 'tariffcode', 'churchtax', 'children', 'note']),
  EmployeePayrollProfile: new Set(['holidaypaypct', 'thirteenthmode', 'note']),
  SalaryCertificate: new Set(['fields']),
  SalaryRecord: new Set(['hourlyrate', 'workloadpct', 'reason']),
  TimeEntry: new Set(['hourlyrate']),
};

function normalisiert(schluessel: string): string {
  return schluessel.toLowerCase().replace(/[\s_-]/g, '');
}

/**
 * Ist der Wert unter diesem Schlüssel tabu?
 *
 * Ohne `entitaet` gilt nur die allgemeine Regel — so ruft der Logger, der
 * keine Entität kennt. Mit `entitaet` kommen deren eigene Felder dazu.
 */
export function istSensiblerSchluessel(schluessel: string, entitaet?: string): boolean {
  const name = normalisiert(schluessel);
  if (SENSIBLE_NAMEN.has(name)) return true;
  if (entitaet && ENTITAET_FELDER[entitaet]?.has(name)) return true;
  return SENSIBLE_TEILWOERTER.some((teil) => name.includes(teil));
}

/**
 * Muster in **Freitext** — für `summary`, Fehlermeldungen und alles, was
 * nicht unter einem Schlüssel steht.
 *
 * Der Schlüssel hilft dort nicht: „IBAN geändert auf CH93 0076 …" ist ein
 * einziger String. Erfasst werden die Formate, die sich sicher erkennen
 * lassen — Schweizer IBAN, AHV-Nummer, JWT. Namen oder Beträge im Freitext
 * lassen sich nicht zuverlässig erkennen; dafür gilt die Regel, dass eine
 * Zusammenfassung sie gar nicht erst enthält.
 */
const FREITEXT_MUSTER: ReadonlyArray<[RegExp, string]> = [
  [/\b756[.\s]?\d{4}[.\s]?\d{4}[.\s]?\d{2}\b/g, '756.****.****.**'],
  [/\b[A-Z]{2}\d{2}(?:[\s]?[0-9A-Z]{4}){3,7}(?:[\s]?[0-9A-Z]{1,4})?\b/g, '[IBAN redigiert]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[JWT redigiert]'],
];

export function freitextSchwaerzen(text: string): string {
  let ergebnis = text;
  for (const [muster, ersatz] of FREITEXT_MUSTER) ergebnis = ergebnis.replace(muster, ersatz);
  return ergebnis;
}

/** Tiefe, ab der nicht mehr hineingeschaut wird. */
const MAX_TIEFE = 6;
/** Längste Liste, die ins Protokoll übernommen wird. */
const MAX_LISTE = 50;

/**
 * Einen beliebigen Wert für ein Protokoll schwärzen.
 *
 * Drei Regeln, jede mit einem Anlass:
 *
 *  • **Zu tief heisst gekürzt, nicht ungefiltert.** Die frühere Fassung gab ab
 *    Tiefe 4 den Wert unverändert zurück — ein Geheimnis in der fünften Ebene
 *    einer verschachtelten Eingabe landete im Klartext. Wer nicht mehr
 *    hineinschaut, darf auch nichts durchlassen.
 *  • **`toJSON` zuerst.** `Date` und Prismas `Decimal` sind Objekte; ohne
 *    diesen Schritt würde ein Betrag als `{ d: [...], e: 3, s: 1 }` ins
 *    Protokoll geschrieben — unlesbar und trotzdem nicht geschwärzt, weil die
 *    inneren Schlüssel harmlos heissen.
 *  • **Schlüssel entscheidet vor Inhalt.** Unter einem sensiblen Schlüssel
 *    wird der ganze Wert ersetzt, auch wenn er ein Objekt ist
 *    (`{ monthlySalary: { from, to } }` aus `diff()`).
 */
export function wertSchwaerzen(wert: unknown, entitaet?: string, tiefe = 0): unknown {
  if (wert === null || wert === undefined) return wert;
  if (typeof wert === 'string') return freitextSchwaerzen(wert);
  if (typeof wert !== 'object') return wert;
  if (tiefe >= MAX_TIEFE) return '[gekürzt]';

  const mitJson = wert as { toJSON?: () => unknown };
  if (typeof mitJson.toJSON === 'function' && !Array.isArray(wert)) {
    return wertSchwaerzen(mitJson.toJSON(), entitaet, tiefe + 1);
  }

  if (Array.isArray(wert)) {
    return wert.slice(0, MAX_LISTE).map((eintrag) => wertSchwaerzen(eintrag, entitaet, tiefe + 1));
  }

  const aus: Record<string, unknown> = {};
  for (const [schluessel, eintrag] of Object.entries(wert as Record<string, unknown>)) {
    // `undefined` bleibt `undefined`: Ein Feld, das gar nicht übergeben
    // wurde, soll im Protokoll nicht als „geändert, Wert redigiert" erscheinen.
    aus[schluessel] = istSensiblerSchluessel(schluessel, entitaet)
      ? eintrag === undefined
        ? undefined
        : GESCHWAERZT
      : wertSchwaerzen(eintrag, entitaet, tiefe + 1);
  }
  return aus;
}
