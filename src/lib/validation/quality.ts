import { z } from 'zod';

/**
 * Schemata der Qualitätskontrolle (Wave 11).
 *
 * ---------------------------------------------------------------------------
 *  Zwei Regeln, die sich durch alle Schemata ziehen
 * ---------------------------------------------------------------------------
 *
 * **Kein Feld für ein Ergebnis.** Weder `scoreAchieved` noch `scorePercent`
 * noch `outcome` noch `targetScore` lassen sich von aussen setzen. Die
 * Punktzahl entsteht aus den Positionen, der Zielwert aus der Vertragsfassung,
 * die zum Zeitpunkt der Begehung galt. Ein mitgeschicktes Ergebnis wäre eine
 * Behauptung über die eigene Note — dieselbe Regel wie beim Preis.
 *
 * **Kein Feld für einen Zustand.** `status`, `number` und `completedAt` fehlen
 * ebenfalls. Eine Begehung wird nicht dadurch abgeschlossen, dass jemand
 * `status: "COMPLETED"` schickt, sondern durch die Handlung — und die hat ihr
 * eigenes Recht (`quality:complete`).
 */

const cuid = z.string().cuid('Ungültige ID.');
const optionalCuid = z
  .union([cuid, z.literal('')])
  .optional()
  .transform((v) => (v === '' ? undefined : v));

const notiz = z.string().trim().max(4000, 'Der Text ist zu lang (max. 4000 Zeichen).').optional();

/**
 * Eine Einzelbewertung.
 *
 * `weight: 0` heisst **nicht beurteilbar** — der Keller war verschlossen —
 * und klammert die Position aus der Rechnung aus, statt sie als null Punkte
 * zu werten. Deshalb ist 0 erlaubt und nicht als Untergrenze ausgeschlossen.
 */
export const qualityItemSchema = z
  .object({
    label: z.string().trim().min(2, 'Bitte geben Sie an, was beurteilt wurde.').max(160),
    room: z.string().trim().max(120).optional(),
    points: z.number().min(0, 'Punkte können nicht negativ sein.').max(1000),
    maxPoints: z.number().min(0.5, 'Die Höchstpunktzahl muss grösser als null sein.').max(1000),
    weight: z.number().min(0, 'Ein Gewicht kann nicht negativ sein.').max(100).default(1),
    note: z.string().trim().max(2000).optional(),
    position: z.number().int().min(0).max(999).default(0),
  })
  .superRefine((werte, ctx) => {
    if (werte.points > werte.maxPoints) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['points'],
        message: 'Mehr Punkte als möglich — bitte prüfen Sie die Höchstpunktzahl.',
      });
    }
  });

/**
 * Eine Begehung anlegen.
 *
 * Mindestens eines von `contractId` und `propertyId` ist Pflicht: Eine
 * Kontrolle ohne Bezug wäre eine Notiz. Der Zielwert kommt aus der
 * Vertragsfassung; ohne Vertrag misst die Begehung, ohne zu urteilen.
 */
export const qualityInspectionCreateSchema = z
  .object({
    contractId: optionalCuid,
    propertyId: optionalCuid,
    jobId: optionalCuid,
    /** Wann begangen wurde — nicht wann der Datensatz entsteht. */
    inspectedAt: z.coerce.date(),
    /**
     * Wer begangen hat. Ohne Angabe die auslösende Person; eine Begehung im
     * Namen einer anderen ist möglich, weil der Rapport oft erst im Büro
     * erfasst wird.
     */
    inspectorId: optionalCuid,
    /** Die Begehung, die diese hier korrigiert. */
    followUpOfId: optionalCuid,
    note: notiz,
    internalNote: notiz,
    items: z.array(qualityItemSchema).max(200, 'Höchstens 200 Positionen je Begehung.').default([]),
  })
  .superRefine((werte, ctx) => {
    if (!werte.contractId && !werte.propertyId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contractId'],
        message: 'Bitte geben Sie einen Vertrag oder ein Objekt an — eine Begehung ohne Bezug ist eine Notiz.',
      });
    }
  });

/**
 * Einen Entwurf ändern.
 *
 * Die Positionen werden als Ganzes ersetzt, nicht zeilenweise abgeglichen —
 * dieselbe Entscheidung wie beim Leistungsumfang eines Vertragsentwurfs und
 * aus demselben Grund: An den Zeilen hängt nichts, was ihre Kennung bräuchte.
 */
export const qualityInspectionUpdateSchema = z
  .object({
    inspectedAt: z.coerce.date().optional(),
    inspectorId: optionalCuid,
    note: notiz,
    internalNote: notiz,
    items: z.array(qualityItemSchema).max(200).optional(),
  })
  .strict();

/**
 * Abschliessen.
 *
 * Der Rumpf trägt keine Zahlen — sie stehen bereits am Entwurf. Was er trägt,
 * ist die Gelegenheit, den abschliessenden Befund zu formulieren, bevor der
 * Beleg unveränderlich wird.
 */
export const qualityInspectionCompleteSchema = z
  .object({
    note: notiz,
  })
  .strict();

export const qualityQuerySchema = z.object({
  status: z.enum(['DRAFT', 'COMPLETED', 'CANCELLED']).optional(),
  outcome: z.enum(['BESTANDEN', 'KNAPP', 'NICHT_BESTANDEN', 'OHNE_ZIEL']).optional(),
  contractId: z.string().cuid().optional(),
  propertyId: z.string().cuid().optional(),
  /** Nur Begehungen ab diesem Tag. */
  von: z.coerce.date().optional(),
  bis: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
});

export type QualityItemInput = z.infer<typeof qualityItemSchema>;
export type QualityInspectionCreateInput = z.infer<typeof qualityInspectionCreateSchema>;
export type QualityInspectionUpdateInput = z.infer<typeof qualityInspectionUpdateSchema>;
