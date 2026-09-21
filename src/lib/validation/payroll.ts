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

export const payrollSettingsSchema = z
  .object({
    ahvIvEo: prozent.optional(),
    alv: prozent.optional(),
    alvGrenzeJahr: betrag.optional(),
    alvUeberGrenze: prozent.optional(),
    uvgNbu: prozent.optional(),
    ktg: prozent.optional(),
    bvgEintrittsschwelle: betrag.optional(),
    bvgKoordinationsabzug: betrag.optional(),
    bvgMindestKoordiniert: betrag.optional(),
    bvgObergrenze: betrag.optional(),
    /**
     * Gesetzlich trägt der Betrieb **mindestens die Hälfte** der
     * Altersgutschrift (Art. 66 BVG). Über 50 % hiesse, dass die angestellte
     * Person mehr trägt als der Betrieb — das ist kein Tippfehler, den man
     * durchlassen sollte.
     */
    bvgAnteilArbeitnehmer: prozent
      .max(50, 'Der Betrieb trägt gesetzlich mindestens die Hälfte (Art. 66 BVG).')
      .optional(),
    bvgSaetze: z
      .array(
        z.object({
          abAlter: z.number().int().min(16).max(75),
          satz: prozent,
        }),
      )
      .min(1)
      .max(10)
      .optional(),
  })
  .refine((wert) => Object.keys(wert).length > 0, {
    message: 'Es wurde nichts zum Ändern angegeben.',
  });

export type PayrollRunInput = z.infer<typeof payrollRunSchema>;
export type PayrollSettingsInput = z.infer<typeof payrollSettingsSchema>;
export type PayslipQuery = z.infer<typeof payslipQuerySchema>;
