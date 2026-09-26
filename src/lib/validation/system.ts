import { z } from 'zod';

/**
 * Datenbereinigung — endgültiges Löschen ganzer Datenbereiche.
 *
 * Die Bereichsschlüssel stehen hier und nicht im Dienst, weil Formular und
 * Endpunkt dieselbe Liste brauchen: das Formular baut daraus die Auswahl,
 * der Endpunkt weist alles andere als 422 zurück. Beschriftung, Reihenfolge
 * und die eigentlichen Löschschritte gehören dem Dienst (`purge.service.ts`).
 */
export const PURGE_AREA_KEYS = [
  'finanzen',
  'auftraege',
  'crm',
  'kommunikation',
  'website',
  'fuehrung',
  'personal',
] as const;

export type PurgeAreaKey = (typeof PURGE_AREA_KEYS)[number];

/**
 * Der Satz, den die Systemverantwortung eintippen muss. Kein Häkchen, keine
 * Rückfrage im Dialog — ein Häkchen setzt man aus Gewohnheit, einen Satz
 * tippt man mit Absicht.
 */
export const PURGE_CONFIRMATION = 'ALLES LÖSCHEN';

export const purgeSchema = z.object({
  bereiche: z
    .array(z.enum(PURGE_AREA_KEYS))
    .min(1, 'Wählen Sie mindestens einen Bereich.')
    .transform((areas) => [...new Set(areas)]),
  bestaetigung: z
    .string()
    .trim()
    .refine((value) => value === PURGE_CONFIRMATION, {
      message: `Zur Bestätigung muss genau «${PURGE_CONFIRMATION}» eingegeben werden.`,
    }),
  /**
   * Nummernkreise der geleerten Bereiche neu beginnen lassen. Vor dem
   * Livegang gewollt (die erste echte Rechnung soll 00001 heissen), im
   * laufenden Betrieb nicht — Art. 957a OR verlangt eine lückenlose Folge.
   */
  nummernkreiseZuruecksetzen: z.boolean().default(false),
});

export type PurgeInput = z.infer<typeof purgeSchema>;

// ---------------------------------------------------------------------------
//  Versionsverwaltung (Produktsprint 2026-09-26)
// ---------------------------------------------------------------------------

const textListe = z.array(z.string().trim().min(1).max(500)).max(100).default([]);

/**
 * Beschreibung einer Version, wie sie das Release-Werkzeug einträgt
 * (`scripts/release-registrieren.ts`). Kein Endpunkt nimmt sie an: Wer eine
 * Version beschreiben darf, hat Zugriff auf den Server — über das Dashboard
 * soll niemand eine „neue Version" erfinden können, die dann freigegeben
 * wird.
 */
export const releaseManifestSchema = z
  .object({
    version: z
      .string()
      .trim()
      .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'Version als MAJOR.MINOR.PATCH, etwa 1.2.0.'),
    releasedAt: z.string().datetime({ offset: true }),
    kind: z.enum(['PATCH', 'MINOR', 'MAJOR', 'SECURITY']),
    securitySeverity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).nullable().default(null),
    summary: z.string().trim().min(10).max(2000),
    features: textListe,
    fixes: textListe,
    securityFixes: textListe,
    uiChanges: textListe,
    migrations: z.array(z.string().trim().regex(/^\d{14}_[a-z0-9_]+$/, 'Migrationsname wie im Ordner prisma/migrations.')).max(100).default([]),
    breakingChanges: textListe,
    manualActions: textListe,
    expectedDowntimeMinutes: z.number().int().min(0).max(24 * 60).nullable().default(null),
    rollbackAvailable: z.boolean().default(true),
    ciStatus: z.enum(['PASSED', 'FAILED', 'PENDING']).default('PENDING'),
    compatibility: z.string().trim().max(2000).nullable().default(null),
    commit: z.string().trim().regex(/^[0-9a-f]{7,40}$/).nullable().default(null),
    artifactSha256: z.string().trim().regex(/^[0-9a-f]{64}$/).nullable().default(null),
    artifactSizeBytes: z.number().int().min(0).nullable().default(null),
  })
  .strict()
  .refine((m) => m.kind !== 'SECURITY' || m.securitySeverity !== null, {
    message: 'Eine Sicherheitsversion nennt ihre Schwere.',
    path: ['securitySeverity'],
  })
  .refine((m) => m.kind !== 'SECURITY' || m.securityFixes.length > 0, {
    message: 'Eine Sicherheitsversion nennt mindestens eine Sicherheitskorrektur.',
    path: ['securityFixes'],
  });

export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

/** Termin setzen oder verschieben. */
export const releaseScheduleSchema = z
  .object({
    scheduledFor: z.string().datetime({ offset: true, message: 'Zeitpunkt als ISO-Datum mit Zeitzone.' }),
  })
  .strict();

/** Termin stornieren — der Grund steht im Protokoll, nicht nur ein Zeitstempel. */
export const releaseCancelSchema = z
  .object({
    grund: z.string().trim().max(500).optional(),
  })
  .strict();

/** „Nicht jetzt" — zurückstellen um eine Anzahl Tage. */
export const releaseDeferSchema = z
  .object({
    tage: z.number().int().min(1).max(90).default(7),
  })
  .strict();
