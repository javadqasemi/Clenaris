import { z } from 'zod';

/**
 * Schemata der Lohnabrechnung.
 *
 * **Kein Feld für einen Betrag.** Weder Brutto noch Netto noch ein einzelner
 * Abzug lässt sich von aussen setzen — die rechnet der Server aus
 * freigegebenen Zeiten, Lohnstamm und Beitragssätzen. Ein Feld, in das jemand
 * eine Lohnsumme schreiben könnte, wäre das Gegenteil einer Abrechnung.
 *
 * Gesetzt werden dürfen nur die **Sätze**, und die sind eine bewusste
 * Stammdatenpflege mit eigener Berechtigung und eigenem Protokolleintrag.
 */

const jahr = z
  .number()
  .int()
  .min(2020, 'Vor 2020 gibt es keine Abrechnungen in diesem System.')
  .max(2100);

const monat = z.number().int().min(1).max(12);

export const payrollRunSchema = z.object({
  year: jahr,
  month: monat,
  /**
   * Ohne Auswahl laufen alle aktiven Personalakten. Die Auswahl ist für den
   * Nachlauf gedacht: Eine Person hatte offene Zeiten, die inzwischen
   * freigegeben sind — dann rechnet man sie einzeln nach, statt den ganzen
   * Monat noch einmal zu fahren.
   */
  employeeIds: z.array(z.string().cuid()).max(500).optional(),
});

export const payrollPublishSchema = z.object({
  payslipIds: z.array(z.string().cuid()).min(1).max(500),
  /**
   * Ausdrückliche Bestätigung, dass mit **ungeprüften** Beitragssätzen
   * veröffentlicht wird. Ohne sie lehnt der Dienst ab, solange eine der
   * benutzten Satzversionen nicht fachlich bestätigt ist — die Vorbelegung
   * darf nicht still zur Auszahlung werden.
   */
  trotzUngepruefterSaetze: z.boolean().optional(),
});

export const payslipQuerySchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  employeeId: z.string().cuid().optional(),
  published: z.enum(['true', 'false']).optional(),
});

/**
 * Ein Prozentsatz als Zahl **in Prozent** (5.3 heisst 5,3 %).
 *
 * Das ist die Schreibweise, in der er im Kreisschreiben, im
 * Versicherungsvertrag und im Kopf der eintragenden Person steht. Ein Feld,
 * bei dem man raten muss, ob 0.053 oder 5.3 gemeint ist, wäre die teuerste
 * Art von Eleganz.
 */
const prozent = z.number().min(0).max(100);
const betrag = z.number().min(0).max(1_000_000);
const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT.');
/**
 * Kennungen der Lohnstammdaten. Nicht `cuid()`: Die Satzversionen, die die
 * Migration aus den alten Jahreszeilen übernommen hat, tragen eine abgeleitete
 * Kennung (`pr_…`), damit ein zweites Einspielen dieselbe Zeile trifft.
 */
const kennung = z.string().min(1).max(64);

// ---------------------------------------------------------------------------
//  Satzversionen
// ---------------------------------------------------------------------------

export const PAYROLL_RATE_CODES = [
  'AHV_IV_EO',
  'ALV',
  'ALV_SOLIDARITY',
  'UVG_NBU',
  'UVG_BU',
  'KTG',
  'FAK',
  'VK',
  'BVG',
] as const;

const bvgParameter = z.object({
  eintrittsschwelle: betrag,
  koordinationsabzug: betrag,
  mindestKoordiniert: betrag,
  obergrenze: betrag,
  baender: z
    .array(z.object({ abAlter: z.number().int().min(16).max(75), satz: prozent }))
    .min(1)
    .max(10),
});

const satzWerte = {
  employeePct: prozent.optional(),
  employerPct: prozent.optional(),
  thresholdMin: betrag.nullable().optional(),
  thresholdMax: betrag.nullable().optional(),
  parameters: bvgParameter.nullable().optional(),
  reference: z.string().trim().max(300).nullable().optional(),
};

/**
 * Eine neue Satzversion. **`source` ist Pflicht:** Ein Wert ohne Herkunft ist
 * genau das, was diese Tabelle verhindern soll — „irgendwer hat 1,4
 * eingetragen" lässt sich nicht prüfen.
 */
export const payrollRateCreateSchema = z
  .object({
    code: z.enum(PAYROLL_RATE_CODES),
    validFrom: datum,
    validUntil: datum.nullable().optional(),
    source: z.string().trim().min(3, 'Bitte die Quelle des Satzes angeben.').max(300),
    ...satzWerte,
  })
  .superRefine((wert, ctx) => {
    /**
     * Gesetzlich trägt der Betrieb **mindestens die Hälfte** der
     * Altersgutschrift (Art. 66 BVG). Über 50 % hiesse, dass die angestellte
     * Person mehr trägt als der Betrieb — das ist kein Tippfehler, den man
     * durchlassen sollte.
     */
    if (wert.code === 'BVG' && (wert.employeePct ?? 0) > 50) {
      ctx.addIssue({ code: 'custom', path: ['employeePct'], message: 'Der Betrieb trägt gesetzlich mindestens die Hälfte (Art. 66 BVG).' });
    }
    if (wert.code === 'BVG' && !wert.parameters) {
      ctx.addIssue({ code: 'custom', path: ['parameters'], message: 'Für die berufliche Vorsorge braucht es Schwellen und Altersbänder.' });
    }
  });

export const payrollRateUpdateSchema = z
  .object({ source: z.string().trim().min(3).max(300).optional(), ...satzWerte })
  .refine((wert) => Object.keys(wert).length > 0, { message: 'Es wurde nichts zum Ändern angegeben.' });

export const payrollRateVerifySchema = z.object({
  note: z.string().trim().min(3, 'Bitte festhalten, worauf sich die Bestätigung stützt.').max(500),
});

export const payrollRateQuerySchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100).optional(),
  code: z.enum(PAYROLL_RATE_CODES).optional(),
});

// ---------------------------------------------------------------------------
//  Lohnvereinbarungen je Person
// ---------------------------------------------------------------------------

export const payrollProfileSchema = z.object({
  thirteenthMode: z.enum(['NONE', 'ANNUAL', 'PRO_RATA', 'MONTHLY']),
  thirteenthPayoutMonth: monat.default(12),
  vacationPayInWage: z.boolean().default(false),
  holidayPayPct: z.number().min(0).max(20).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

// ---------------------------------------------------------------------------
//  Lohnpositionen
// ---------------------------------------------------------------------------

export const PAYROLL_ITEM_TYPES = [
  'OVERTIME',
  'ALLOWANCE',
  'FAMILY_ALLOWANCE',
  'EXPENSE',
  'CORRECTION',
  'NET_CORRECTION',
  'DEDUCTION',
  'WITHHOLDING_TAX_MANUAL',
] as const;

/**
 * Eine Lohnposition. Bei **Überstunden** rechnet der Server den Betrag aus
 * Stunden, Ansatz und Zuschlag — ein mitgeschickter Betrag wird dort nicht
 * angenommen. Nur Korrekturen dürfen negativ sein; ein negativer Abzug wäre
 * eine verdeckte Auszahlung.
 */
export const payrollItemCreateSchema = z
  .object({
    employeeId: z.string().cuid(),
    year: jahr,
    month: monat,
    type: z.enum(PAYROLL_ITEM_TYPES),
    label: z.string().trim().min(2).max(120),
    quantity: z.number().min(0).max(744).nullable().optional(),
    rate: betrag.nullable().optional(),
    surchargePct: z.number().min(0).max(200).nullable().optional(),
    amount: z.number().min(-1_000_000).max(1_000_000).optional(),
    note: z.string().trim().max(500).nullable().optional(),
    correctsPayslipId: z.string().cuid().nullable().optional(),
  })
  .superRefine((wert, ctx) => {
    if (wert.type === 'OVERTIME') {
      if (!wert.quantity || wert.rate === undefined || wert.rate === null) {
        ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'Überstunden brauchen Stunden und Ansatz.' });
      }
      if (wert.amount !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['amount'], message: 'Den Betrag der Überstunden rechnet der Server.' });
      }
      return;
    }
    if (wert.amount === undefined) {
      ctx.addIssue({ code: 'custom', path: ['amount'], message: 'Bitte einen Betrag angeben.' });
      return;
    }
    const vorzeichenErlaubt = wert.type === 'CORRECTION' || wert.type === 'NET_CORRECTION';
    if (!vorzeichenErlaubt && wert.amount < 0) {
      ctx.addIssue({ code: 'custom', path: ['amount'], message: 'Nur Korrekturen dürfen negativ sein.' });
    }
    if (wert.amount === 0) {
      ctx.addIssue({ code: 'custom', path: ['amount'], message: 'Eine Position über null Franken ist keine Position.' });
    }
  });

export const payrollItemUpdateSchema = z
  .object({
    label: z.string().trim().min(2).max(120).optional(),
    quantity: z.number().min(0).max(744).nullable().optional(),
    rate: betrag.nullable().optional(),
    surchargePct: z.number().min(0).max(200).nullable().optional(),
    amount: z.number().min(-1_000_000).max(1_000_000).optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .refine((wert) => Object.keys(wert).length > 0, { message: 'Es wurde nichts zum Ändern angegeben.' });

export const payrollItemQuerySchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  employeeId: z.string().cuid().optional(),
});

// ---------------------------------------------------------------------------
//  Quellensteuer
// ---------------------------------------------------------------------------

const kanton = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^(AG|AI|AR|BE|BL|BS|FR|GE|GL|GR|JU|LU|NE|NW|OW|SG|SH|SO|SZ|TG|TI|UR|VD|VS|ZG|ZH)$/, 'Unbekanntes Kantonskürzel.');
/** Tarifcode, wie ihn die Steuerverwaltung vergibt — Buchstabe, Kinderzahl, Kirchensteuer (z. B. „A0N"). */
const tarifcode = z.string().trim().toUpperCase().regex(/^[A-Z][0-9]{1,2}[YN]?$/, 'Tarifcode im Format „A0N".');

export const withholdingProfileCreateSchema = z.object({
  employeeId: z.string().cuid(),
  validFrom: datum,
  validUntil: datum.nullable().optional(),
  canton: kanton,
  tariffCode: tarifcode,
  churchTax: z.boolean().default(false),
  children: z.number().int().min(0).max(20).default(0),
  note: z.string().trim().max(500).nullable().optional(),
});

export const withholdingProfileUpdateSchema = z
  .object({
    validUntil: datum.nullable().optional(),
    canton: kanton.optional(),
    tariffCode: tarifcode.optional(),
    churchTax: z.boolean().optional(),
    children: z.number().int().min(0).max(20).optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .refine((wert) => Object.keys(wert).length > 0, { message: 'Es wurde nichts zum Ändern angegeben.' });

export const withholdingProfileQuerySchema = z.object({ employeeId: z.string().cuid().optional() });

/**
 * Einlesen eines Tarifausschnitts. **Die Zeilen kommen aus einer Quelle** —
 * der Datei der kantonalen Steuerverwaltung —, nie aus der Luft; `source` ist
 * deshalb Pflicht. Eingelesen wird ungeprüft; bestätigt wird je Stapel.
 */
export const withholdingRateImportSchema = z.object({
  canton: kanton,
  year: jahr,
  source: z.string().trim().min(3, 'Bitte die Quelle des Tarifs angeben.').max(300),
  reference: z.string().trim().max(300).nullable().optional(),
  rows: z
    .array(
      z
        .object({
          tariffCode: tarifcode,
          incomeFrom: betrag,
          incomeTo: betrag.nullable().optional(),
          ratePct: prozent,
        })
        .refine((z_) => z_.incomeTo === undefined || z_.incomeTo === null || z_.incomeTo > z_.incomeFrom, {
          message: 'Die Obergrenze liegt nicht über der Untergrenze.',
          path: ['incomeTo'],
        }),
    )
    .min(1)
    .max(5000),
});

export const withholdingRateQuerySchema = z.object({
  canton: kanton.optional(),
  year: z.coerce.number().int().min(2020).max(2100).optional(),
  tariffCode: tarifcode.optional(),
});

export const withholdingRateVerifySchema = z.object({
  importBatch: z.string().min(1).max(64),
  note: z.string().trim().min(3).max(500),
});

// ---------------------------------------------------------------------------
//  Prüfung und Lohnausweis
// ---------------------------------------------------------------------------

/**
 * Eine zur Prüfung markierte Abrechnung freigeben. Die Notiz ist Pflicht —
 * „geprüft" ohne Begründung wäre dieselbe Leerstelle wie vorher.
 */
export const payslipReviewSchema = z.object({
  note: z.string().trim().min(3, 'Bitte festhalten, was geprüft wurde.').max(500),
});

export const salaryCertificateCreateSchema = z.object({
  employeeId: z.string().cuid(),
  year: jahr,
});

export const salaryCertificateQuerySchema = z.object({
  employeeId: z.string().cuid().optional(),
  year: z.coerce.number().int().min(2020).max(2100).optional(),
});

export const payrollIdParam = z.object({ id: kennung });
export const payrollEmployeeParam = z.object({ employeeId: z.string().cuid() });

export type PayrollRunInput = z.infer<typeof payrollRunSchema>;
export type PayslipQuery = z.infer<typeof payslipQuerySchema>;
export type PayrollRateCreateInput = z.infer<typeof payrollRateCreateSchema>;
export type PayrollRateUpdateInput = z.infer<typeof payrollRateUpdateSchema>;
export type PayrollProfileInput = z.infer<typeof payrollProfileSchema>;
export type PayrollItemCreateInput = z.infer<typeof payrollItemCreateSchema>;
export type PayrollItemUpdateInput = z.infer<typeof payrollItemUpdateSchema>;
export type WithholdingProfileCreateInput = z.infer<typeof withholdingProfileCreateSchema>;
export type WithholdingProfileUpdateInput = z.infer<typeof withholdingProfileUpdateSchema>;
export type WithholdingRateImportInput = z.infer<typeof withholdingRateImportSchema>;
