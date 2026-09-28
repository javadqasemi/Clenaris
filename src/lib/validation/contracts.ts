import { z } from 'zod';

import { dateOnlySchema, moneySchema } from './common';

/**
 * Schemata des Vertragsmoduls (Wave 10).
 *
 * ---------------------------------------------------------------------------
 *  Zwei Regeln, die sich durch alle Schemata ziehen
 * ---------------------------------------------------------------------------
 *
 * **Kein Feld für einen Zustand.** `status`, `number`, `versionNumber`,
 * `effectiveUntil`, jedes `…At` — nichts davon lässt sich von aussen setzen.
 * Ein Vertrag wird nicht dadurch aktiv, dass jemand `status: "ACTIVE"`
 * schickt, sondern dadurch, dass er die Bedingungen erfüllt und ein Mensch mit
 * dem Recht dazu ihn aktiviert. Dasselbe Prinzip wie bei Rechnungen, Preisen
 * und Lohnabrechnungen.
 *
 * **Konditionen gibt es nur an der Version.** Das Schema des Vertragskopfs
 * kennt weder Preis noch Frequenz noch Zahlungsziel. Wer sie ändern will,
 * legt eine Version an — und die verlangt eine Begründung.
 */

const cuid = z.string().cuid('Ungültige ID.');
const optionalCuid = z
  .union([cuid, z.literal('')])
  .optional()
  .transform((v) => (v === '' ? undefined : v));

/** Kurzer Freitext, wie er in Notizfeldern der Verwaltung üblich ist. */
const notiz = z.string().trim().max(4000, 'Der Text ist zu lang (max. 4000 Zeichen).').optional();

/**
 * Eine Begründung ist Pflicht und darf nicht leer sein.
 *
 * Nicht Bürokratie: Eine Vertragsversion ohne Grund ist eine Änderung, die
 * ein halbes Jahr später niemand mehr erklären kann — und genau dann wird
 * gefragt.
 */
const begruendung = z
  .string()
  .trim()
  .min(5, 'Bitte begründen Sie die Änderung (mindestens 5 Zeichen).')
  .max(2000, 'Die Begründung ist zu lang (max. 2000 Zeichen).');

// ---------------------------------------------------------------------------
//  Vertragskopf
// ---------------------------------------------------------------------------

export const contractCreateSchema = z.object({
  customerId: cuid,
  propertyId: optionalCuid,
  /** Die angenommene Offerte, aus der der Vertrag entsteht. */
  quoteId: optionalCuid,

  title: z.string().trim().min(3, 'Bitte geben Sie eine Bezeichnung an.').max(160),
  description: notiz,

  startDate: dateOnlySchema,
  /**
   * Nur bei befristeten Verträgen. Die Prüfung „Ende nach Beginn" steht
   * bewusst hier und nicht im Dienst: Sie ist eine Eigenschaft der Eingabe,
   * keine Geschäftsregel, und im Formular erscheint sie am richtigen Feld.
   */
  endDate: dateOnlySchema.optional(),

  responsibleEmployeeId: optionalCuid,
  salesOwnerId: optionalCuid,
  serviceManagerId: optionalCuid,
  costCenter: z.string().trim().max(60).optional(),

  internalNote: notiz,
}).refine((werte) => !werte.endDate || werte.endDate > werte.startDate, {
  message: 'Das Ende muss nach dem Beginn liegen.',
  path: ['endDate'],
});

export const contractUpdateSchema = z
  .object({
    title: z.string().trim().min(3).max(160).optional(),
    description: notiz,
    propertyId: optionalCuid,
    responsibleEmployeeId: optionalCuid,
    salesOwnerId: optionalCuid,
    serviceManagerId: optionalCuid,
    costCenter: z.string().trim().max(60).optional(),
    internalNote: notiz,
    /**
     * Beginn und Ende sind hier **nicht** änderbar.
     *
     * Bei einem Entwurf wären sie harmlos, bei einem laufenden Vertrag wären
     * sie die stillste Form einer Vertragsänderung: Wer das Ende verschiebt,
     * verlängert den Vertrag, ohne dass irgendwo eine Version entsteht. Die
     * Laufzeit gehört deshalb in `contractVersionSchema`.
     */
  })
  .strict();

// ---------------------------------------------------------------------------
//  Vertragsversion
// ---------------------------------------------------------------------------

export const contractPricingModelSchema = z.enum([
  'FIXED_PERIOD',
  'FIXED_PER_VISIT',
  'HOURLY',
  'UNIT_BASED',
  'CUSTOM',
]);

export const contractVersionSchema = z
  .object({
    effectiveFrom: dateOnlySchema,
    reason: begruendung,

    minimumTermMonths: z.number().int().min(0).max(240).optional(),
    renewalType: z.enum(['NONE', 'AUTOMATIC', 'MANUAL']).default('NONE'),
    renewalPeriodMonths: z.number().int().min(1).max(120).optional(),
    noticePeriodDays: z.number().int().min(0).max(730).default(90),

    billingCycle: z.enum(['PER_VISIT', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL']).default('MONTHLY'),
    paymentTermDays: z.number().int().min(0).max(180).default(30),
    currency: z.string().trim().length(3).default('CHF'),

    pricingModel: contractPricingModelSchema.default('FIXED_PERIOD'),
    baseAmount: moneySchema.default(0),
    hourlyRate: moneySchema.optional(),
    unitPrice: z.number().min(0).max(999_999).optional(),
    unitLabel: z.string().trim().max(40).optional(),
    vatRate: z.number().min(0).max(100).default(8.1),

    indexReference: z.string().trim().max(120).optional(),
    indexBaseValue: z.number().min(0).max(999_999).optional(),
    nextReviewAt: dateOnlySchema.optional(),

    targetQualityScore: z.number().int().min(0).max(100).optional(),
    inspectionIntervalDays: z.number().int().min(1).max(3650).optional(),
    responseHours: z.number().int().min(1).max(8760).optional(),
    slaNote: z.string().trim().max(2000).optional(),

    terms: z.string().trim().max(20_000).optional(),
    internalNote: notiz,
  })
  /**
   * Das Preismodell entscheidet, welches Feld gefüllt sein muss.
   *
   * Ohne diese Prüfung entstünde eine Version mit `HOURLY` und ohne
   * Stundensatz — und die Abrechnung rechnete stillschweigend mit null. Ein
   * Vertrag, der null kostet, sieht in keiner Liste falsch aus.
   */
  .superRefine((werte, ctx) => {
    if (werte.pricingModel === 'HOURLY' && (werte.hourlyRate ?? 0) <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hourlyRate'],
        message: 'Bei Abrechnung nach Stunden ist ein Stundensatz erforderlich.',
      });
    }
    if (werte.pricingModel === 'UNIT_BASED') {
      if ((werte.unitPrice ?? 0) <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['unitPrice'],
          message: 'Bei mengenabhängiger Abrechnung ist ein Einzelpreis erforderlich.',
        });
      }
      if (!werte.unitLabel) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['unitLabel'],
          message: 'Bitte geben Sie die Einheit an (z. B. „m²" oder „Fenster").',
        });
      }
    }
    if (
      (werte.pricingModel === 'FIXED_PERIOD' || werte.pricingModel === 'FIXED_PER_VISIT') &&
      werte.baseAmount <= 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['baseAmount'],
        message: 'Bei Festpreis ist ein Betrag grösser als null erforderlich.',
      });
    }
    if (werte.renewalType === 'AUTOMATIC' && !werte.renewalPeriodMonths) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['renewalPeriodMonths'],
        message: 'Bei automatischer Verlängerung ist die Verlängerungsdauer erforderlich.',
      });
    }
  });

// ---------------------------------------------------------------------------
//  Leistungsumfang
// ---------------------------------------------------------------------------

export const contractServiceSchema = z.object({
  /**
   * Kennung einer bestehenden Position desselben Entwurfs. Mit ihr bleibt die
   * Zeile erhalten — samt ihrem Einsatzplan. Ohne sie entsteht eine neue.
   */
  id: optionalCuid,
  serviceId: optionalCuid,
  label: z.string().trim().min(2, 'Bitte geben Sie eine Bezeichnung an.').max(160),
  description: z.string().trim().max(2000).optional(),
  /**
   * Abgewiesen statt übernommen (2026-09-27, Phase 18). `Building` hat
   * keinen Anlegeweg und keine Organisation; ein Verweis darauf zeigte auf
   * eine mandantenlose Zeile, die niemand über die Anwendung pflegen kann.
   * Laut abgewiesen und nicht still verworfen: Wer das Feld schickt, soll
   * erfahren, dass es nichts bewirkt. Die Lage einer Leistung beschreibt
   * `zone`. Kommt ein Gebäudebestand mit eigenem Lebenszyklus, wird das Feld
   * wieder angenommen — geprüft gegen dessen Organisation und Kundschaft.
   */
  buildingId: z
    .never({ message: 'Gebäude lassen sich derzeit keiner Leistung zuordnen. Beschreiben Sie die Lage im Feld „Zone".' })
    .optional(),
  zone: z.string().trim().max(120).optional(),
  estimatedMinutes: z.number().int().min(5, 'Mindestens 5 Minuten.').max(1440).default(120),
  requiredCrewSize: z.number().int().min(1).max(50).default(1),
  requiredSkills: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  qualityRequirement: z.string().trim().max(2000).optional(),
  specialInstructions: z.string().trim().max(2000).optional(),
  materialsBy: z.enum(['PROVIDER', 'CUSTOMER']).default('PROVIDER'),
  quantity: z.number().min(0).max(9_999_999).optional(),
  position: z.number().int().min(0).max(999).default(0),
});

/**
 * Der Leistungsumfang wird als Ganzes geschickt — aber seit 2026-09-23 nicht
 * mehr als Ganzes **ersetzt**. Die Annahme von Wave 10, an den Zeilen eines
 * Entwurfs hänge nichts, stimmte nicht: Ein Versionsentwurf trägt die
 * kopierten Einsatzpläne seiner Vorgängerin, und das Löschen der Zeilen nahm
 * sie über die Kaskade mit. Wer einer Folgefassung eine Leistung hinzufügte,
 * verlor die Frequenz aller bestehenden. Deshalb: Positionen mit `id` bleiben
 * (und werden geändert), fehlende werden entfernt, neue angelegt.
 * Ist die Version aktiv oder gebunden, verweigert der Dienst die Änderung
 * ohnehin.
 */
export const contractServicesReplaceSchema = z.object({
  services: z.array(contractServiceSchema).max(100, 'Höchstens 100 Positionen je Version.'),
});

/** Rumpf von `POST /api/contracts`: Vertragskopf samt erster Version und optionalem Leistungsumfang. */
export const contractCreateRequestSchema = z.object({
  contract: contractCreateSchema,
  version: contractVersionSchema,
  services: z.array(contractServiceSchema).max(100).optional(),
});

/** Rumpf von `POST /api/contracts/{id}/versions`: eine neue Fassung, ohne `services` mit kopiertem Leistungsumfang. */
export const contractVersionCreateSchema = z.object({
  version: contractVersionSchema,
  services: z.array(contractServiceSchema).max(100).optional(),
});

// ---------------------------------------------------------------------------
//  Einsatzplan
// ---------------------------------------------------------------------------

/** Minuten seit Mitternacht, Ortszeit — siehe `ServiceSchedule` im Schema. */
const minutenImTag = z.number().int().min(0).max(1439);

export const serviceScheduleSchema = z
  .object({
    frequency: z.enum(['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL']).default('WEEKLY'),
    interval: z.number().int().min(1).max(52).default(1),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
    monthDay: z.number().int().min(1).max(31).optional(),
    startMinute: minutenImTag.default(360),
    endMinute: minutenImTag.default(600),
    effectiveFrom: dateOnlySchema,
    effectiveUntil: dateOnlySchema.optional(),
    holidayHandling: z.enum(['IGNORE', 'SKIP', 'MOVE_BEFORE', 'MOVE_AFTER']).default('SKIP'),
    active: z.boolean().default(true),
  })
  .superRefine((werte, ctx) => {
    if (werte.endMinute <= werte.startMinute) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endMinute'],
        message: 'Das Ende des Zeitfensters muss nach dem Beginn liegen.',
      });
    }
    // Wochenrhythmus ohne Wochentag ergibt keine Serie — er ergäbe gar nichts,
    // und zwar stillschweigend: Der Planer fände nie einen Termin.
    if ((werte.frequency === 'WEEKLY' || werte.frequency === 'BIWEEKLY') && werte.weekdays.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['weekdays'],
        message: 'Bitte wählen Sie mindestens einen Wochentag.',
      });
    }
    if (werte.effectiveUntil && werte.effectiveUntil < werte.effectiveFrom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['effectiveUntil'],
        message: 'Das Ende muss nach dem Beginn liegen.',
      });
    }
  });

export const scheduleExceptionSchema = z
  .object({
    kind: z.enum(['SKIP', 'MOVE', 'EXTRA']),
    originalDate: dateOnlySchema,
    newDate: dateOnlySchema.optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .superRefine((werte, ctx) => {
    if (werte.kind === 'MOVE' && !werte.newDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['newDate'],
        message: 'Beim Verschieben ist ein Ersatztermin erforderlich.',
      });
    }
  });

/**
 * Der Planungsauftrag.
 *
 * `bis` statt „Anzahl Termine": Der Planer arbeitet auf einem Zeithorizont,
 * nicht auf einer Stückzahl — sonst hinge die Zahl der erzeugten Einsätze an
 * der Frequenz, und „die nächsten 20" hiesse bei täglicher Reinigung drei
 * Wochen und bei monatlicher fast zwei Jahre.
 */
export const scheduleGenerateSchema = z.object({
  bis: dateOnlySchema,
  /** Nur planen und zurückmelden, nichts schreiben. */
  probelauf: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
//  Lebenslauf
// ---------------------------------------------------------------------------

export const contractActivateSchema = z.object({
  /**
   * Ohne Angabe gilt der Stichtag, den die Fassung trägt. Eine abweichende
   * Angabe nur an einer freien Fassung — an einer angenommenen steht der
   * Stichtag im unterschriebenen Dokument.
   */
  effectiveFrom: dateOnlySchema.optional(),
  note: z.string().trim().max(1000).optional(),
});

/**
 * Pfad `…/contracts/{id}/versions/{versionId}`.
 *
 * Stand bis 2026-09-23 zweimal wortgleich **in** den Routendateien — gegen
 * die Regel, dass jedes Schema hier liegt und damit auch in der OpenAPI-
 * Beschreibung dasselbe ist.
 */
export const contractVersionParams = z.object({ id: z.string().min(1), versionId: z.string().min(1) });

export const contractPauseSchema = z
  .object({
    pausedFrom: dateOnlySchema,
    pausedUntil: dateOnlySchema.optional(),
    reason: begruendung,
  })
  .refine((werte) => !werte.pausedUntil || werte.pausedUntil > werte.pausedFrom, {
    message: 'Das Ende der Pause muss nach ihrem Beginn liegen.',
    path: ['pausedUntil'],
  });

export const contractNoticeSchema = z.object({
  /**
   * Wer gekündigt hat. Eine Tatsache, keine Bewertung — das System beurteilt
   * nicht, ob die Kündigung wirksam ist.
   */
  noticeGivenBy: z.enum(['CUSTOMER', 'PROVIDER']),
  noticeGivenAt: dateOnlySchema.optional(),
  /**
   * Das gewünschte Wirkungsdatum. Ohne Angabe rechnet der Dienst es aus
   * Kündigungsfrist und Laufzeit — und meldet beides zurück, damit
   * nachvollziehbar bleibt, woher das Datum kommt.
   */
  terminationEffectiveAt: dateOnlySchema.optional(),
  reason: z.string().trim().max(2000).optional(),
});

export const contractRenewSchema = z.object({
  /** Ohne Angabe gilt die Verlängerungsdauer der aktiven Version. */
  months: z.number().int().min(1).max(120).optional(),
  reason: begruendung,
});

/** Rumpf von `POST /api/contracts/{id}/end`: die Begründung ist freiwillig. */
export const contractEndSchema = z.object({ reason: z.string().trim().max(2000).optional() });

/** Rumpf von `POST /api/contracts/{id}/cancel`: die Begründung ist freiwillig. */
export const contractCancelSchema = z.object({ reason: z.string().trim().max(2000).optional() });

// ---------------------------------------------------------------------------
//  Änderungsanträge
// ---------------------------------------------------------------------------

/** Pfad `…/contracts/{id}/amendments/{amendmentId}`. */
export const contractAmendmentParams = z.object({ id: z.string().min(1), amendmentId: z.string().min(1) });

export const contractAmendmentCreateSchema = z.object({
  type: z.enum(['SCOPE', 'PRICE', 'FREQUENCY', 'TERM', 'SLA', 'PAYMENT_TERMS', 'INDEXATION', 'OTHER']),
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().max(4000).optional(),
  reason: begruendung,
  effectiveFrom: dateOnlySchema,
});

export const contractAmendmentDecisionSchema = z.object({
  entscheidung: z.enum(['APPROVE', 'REJECT']),
  reason: z.string().trim().max(2000).optional(),
});

/**
 * Das Wirksamwerden eines freigegebenen Antrags.
 *
 * Es trägt die **vollständigen** neuen Konditionen, nicht eine Teilmenge.
 * Eine Vertragsversion, die aus „dem Vorgänger plus ein paar Feldern"
 * entstünde, wäre nur im Zusammenhang lesbar — und genau das soll eine
 * Version nicht sein.
 */
export const contractAmendmentApplySchema = z.object({
  version: contractVersionSchema,
  services: z.array(contractServiceSchema).max(100).optional(),
});

// ---------------------------------------------------------------------------
//  Preisanpassung
// ---------------------------------------------------------------------------

/** Pfad `…/contracts/{id}/price-adjustments/{adjustmentId}`. */
export const priceAdjustmentParams = z.object({ id: z.string().min(1), adjustmentId: z.string().min(1) });

export const priceAdjustmentCreateSchema = z
  .object({
    effectiveFrom: dateOnlySchema,
    reviewDueAt: dateOnlySchema.optional(),
    newAmount: moneySchema,
    percent: z.number().min(-100).max(1000).optional(),
    indexReference: z.string().trim().max(120).optional(),
    indexOldValue: z.number().min(0).max(999_999).optional(),
    indexNewValue: z.number().min(0).max(999_999).optional(),
    reason: begruendung,
  })
  /**
   * `oldAmount` fehlt hier mit Absicht: Der alte Betrag steht in der aktiven
   * Version, und ihn mitschicken zu lassen hiesse, dem Client zu erlauben,
   * die Vergangenheit zu behaupten.
   */
  .strict();

export const priceAdjustmentDecisionSchema = z.object({
  entscheidung: z.enum(['APPROVE', 'REJECT']),
  reason: z.string().trim().max(2000).optional(),
});

// ---------------------------------------------------------------------------
//  Abrechnung
// ---------------------------------------------------------------------------

/**
 * Die Rechnung einer Vertragsperiode auslösen.
 *
 * **Kein Zeitraum, nur ein Stichtag.** Der Zeitraum ergibt sich aus dem
 * Abrechnungszyklus der geltenden Vertragsversion; der Stichtag sagt bloss,
 * welche Periode gemeint ist. Liesse man ihn frei wählen, wären beliebig viele
 * sich überlappende „Perioden" fakturierbar — und der Schutz gegen
 * Doppelabrechnung hätte keinen Schlüssel mehr, an dem er greifen könnte.
 *
 * **Kein Betrag.** Was zu zahlen ist, rechnet der Server aus Version und
 * erbrachten Einsätzen. Dasselbe Prinzip wie bei der Preisberechnung des
 * Buchungsformulars.
 */
export const contractInvoiceSchema = z
  .object({
    /** Irgendein Tag in der gewünschten Periode. Ohne Angabe: die vorige. */
    stichtag: dateOnlySchema.optional(),
    /** true = sofort ausstellen; Nummer wird vergeben, der Beleg ist danach unveränderlich. */
    sofortAusstellen: z.boolean().default(false),
  })
  .strict();

export const contractBillingOverviewQuerySchema = z.object({
  perioden: z.coerce.number().int().min(1).max(36).default(6),
});

/** Abfrage von `GET /api/contracts/{id}/billing-basis`: der abzurechnende Zeitraum. */
export const contractBillingBasisQuerySchema = z.object({
  von: z.coerce.date(),
  bis: z.coerce.date(),
});

// ---------------------------------------------------------------------------
//  Abfragen
// ---------------------------------------------------------------------------

export const contractQuerySchema = z.object({
  status: z
    .enum(['DRAFT', 'IN_REVIEW', 'OFFERED', 'ACTIVE', 'PAUSED', 'NOTICE_GIVEN', 'ENDED', 'CANCELLED'])
    .optional(),
  customerId: z.string().cuid().optional(),
  q: z.string().trim().max(120).optional(),
  /** Verträge, deren Kündigungsfrist innerhalb von n Tagen abläuft. */
  fristInTagen: z.coerce.number().int().min(1).max(365).optional(),
  /** Verträge, die innerhalb von n Tagen enden. */
  endeInTagen: z.coerce.number().int().min(1).max(365).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
});

/** Abfrage von `GET /api/contracts/deadlines`: wie viele Tage im Voraus gewarnt wird. */
export const contractDeadlinesQuerySchema = z.object({ tage: z.coerce.number().int().min(1).max(365).default(45) });

export type ContractCreateInput = z.infer<typeof contractCreateSchema>;
export type ContractUpdateInput = z.infer<typeof contractUpdateSchema>;
export type ContractVersionInput = z.infer<typeof contractVersionSchema>;
export type ContractServiceInput = z.infer<typeof contractServiceSchema>;
export type ServiceScheduleInput = z.infer<typeof serviceScheduleSchema>;
export type ScheduleExceptionInput = z.infer<typeof scheduleExceptionSchema>;
export type ContractAmendmentCreateInput = z.infer<typeof contractAmendmentCreateSchema>;
export type PriceAdjustmentCreateInput = z.infer<typeof priceAdjustmentCreateSchema>;
export type ContractInvoiceInput = z.infer<typeof contractInvoiceSchema>;
