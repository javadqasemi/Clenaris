import { z } from 'zod';

import { COMMIT_MUSTER, SEMVER_MUSTER } from '../release/manifest';

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
    /**
     * Genau 40 Hexzeichen (seit 2026-09-30) — vorher genügten 7. Ein Kürzel
     * ist mehrdeutig, passt nicht zum Artefaktnamen und liesse sich nie mit
     * dem Commit vergleichen, den die laufende Instanz aus `RELEASE.json`
     * belegt; der Ausführer hätte „erfolgreich" nie bestätigen können.
     * `release-registrieren.ts` nimmt den Wert ohnehin aus der Beilage des
     * Artefakts; hier steht die Regel für jeden anderen Weg in die Tabelle.
     */
    commit: z.string().trim().regex(COMMIT_MUSTER, 'Commit als 40 Hexadezimalzeichen, kein Kürzel.').nullable().default(null),
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

// ---------------------------------------------------------------------------
//  Release-Ausführer (2026-09-27) — `/api/cron/release-auftraege`
// ---------------------------------------------------------------------------

const UMGEBUNGEN = ['production', 'staging', 'preview', 'test'] as const;

/** Welche Umgebung fragt — die Instanz vergleicht mit ihrer eigenen. */
export const releaseAuftraegeQuery = z
  .object({
    umgebung: z.enum(UMGEBUNGEN),
  })
  .strict();

const ausfuehrungsSchluessel = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{16,120}$/, 'Ausführungsschlüssel: 16–120 Zeichen aus Buchstaben, Ziffern, . _ : -');

/**
 * Einen fälligen Auftrag übernehmen.
 *
 * Der Ausführer meldet, was er **gemessen** hat: die Prüfsumme des
 * heruntergeladenen Artefakts, Commit und Version aus dessen Beilage und die
 * Adresse des CI-Laufs, aus dem es stammt. Die Anwendung vergleicht alle
 * drei mit dem Release; eine Übernahme „auf Treu und Glauben" gibt es nicht.
 *
 * **Commit und Zielversion sind Pflicht** (seit 2026-09-30). Vorher verglich
 * die Anwendung nur die Prüfsumme — die bewies, dass das Archiv das
 * registrierte ist, aber nicht, dass der Ausführer es als *diese* Fassung
 * gelesen hat. Ein Ausführer, der die Beilage gar nicht öffnete, konnte ein
 * richtiges Archiv unter falscher Erwartung übernehmen und danach gegen den
 * falschen Commit prüfen. Jetzt muss er sagen, was er gelesen hat, und die
 * Anwendung weist jede Abweichung mit 422 ab.
 */
export const releaseUebernahmeSchema = z
  .object({
    auftragId: z.string().cuid(),
    umgebung: z.enum(UMGEBUNGEN),
    ausfuehrer: z.string().regex(/^[a-z0-9][a-z0-9._/-]{2,79}$/, 'Kennung des Ausführers: 3–80 Zeichen, klein.'),
    ausfuehrungsSchluessel,
    artefaktSha256: z.string().regex(/^[0-9a-f]{64}$/, 'SHA-256 als 64 Hexadezimalzeichen.'),
    commit: z.string().regex(COMMIT_MUSTER, 'Commit als 40 Hexadezimalzeichen, kein Kürzel.'),
    zielVersion: z.string().regex(SEMVER_MUSTER, 'Zielversion als MAJOR.MINOR.PATCH, etwa 1.2.0.'),
    ciNachweis: z.string().url().max(300).refine((u) => u.startsWith('https://'), 'Nachweis als https-Adresse.'),
  })
  .strict();

/**
 * Was die Aktivierung auf dem Server berichtet hat — der Ausgangscode von
 * `deploy/v2/release-aktivieren.sh`, in Worten (Vertrag C3):
 *
 *  | Wert                 | Code | Bedeutung |
 *  |----------------------|------|-----------|
 *  | `AKTIV`              | 0    | umgeschaltet, gesund, Identität bestätigt |
 *  | `NICHT_UMGESCHALTET` | 10   | vor dem Umschalten gescheitert, nichts geändert |
 *  | `GESPERRT`           | 11   | eine andere Aktivierung hält die Sperre |
 *  | `ZURUECK`            | 20   | umgeschaltet, ungesund, alte Fassung wiederhergestellt |
 *  | `UNKLAR`             | 30 oder kein Code | der Zustand ist nicht bekannt |
 *  | `NICHT_VERBUNDEN`    | 255  | der Server war nicht erreichbar (SSH) |
 *
 * Der Wert steht im Prüfprotokoll. Er entscheidet **nicht** über das
 * Ergebnis — das tut die Identität der antwortenden Instanz —, aber ohne ihn
 * wüsste später niemand, ob ein FAILED „nichts geändert" oder „Zustand
 * unbekannt" hiess.
 */
export const AKTIVIERUNGEN = ['AKTIV', 'ZURUECK', 'NICHT_UMGESCHALTET', 'GESPERRT', 'UNKLAR', 'NICHT_VERBUNDEN'] as const;
export type Aktivierung = (typeof AKTIVIERUNGEN)[number];

/**
 * Ergebnis einer Ausführung melden.
 *
 * **`laufendeVersion` gibt es nicht mehr** (seit 2026-09-30). Bis dahin
 * meldete der Ausführer, welche Version die Instanz nach dem Umschalten
 * genannt habe, und die Anwendung glaubte ihm. Jetzt prüft die Anwendung
 * selbst: SUCCEEDED gilt nur, wenn die **antwortende Instanz** ihre Identität
 * belegt und genau Commit und Version des Release nennt; ROLLED_BACK nur,
 * wenn sie belegt die Ausgangsversion und einen anderen Commit nennt
 * (`release-ausfuehrung.service.ts`). Ein Feld, das der Ausführer füllen
 * kann, beweist nichts, was die Instanz nicht selbst belegen kann.
 *
 * Erfolg und Rücksprung müssen zur gemeldeten Aktivierung passen: Ein
 * „erfolgreich" nach „ZURUECK" ist ein Fehler im Ausführer, kein Zustand.
 */
export const releaseErgebnisSchema = z
  .object({
    auftragId: z.string().cuid(),
    ausfuehrungsSchluessel,
    ergebnis: z.enum(['SUCCEEDED', 'FAILED', 'ROLLED_BACK']),
    aktivierung: z.enum(AKTIVIERUNGEN),
    meldung: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine((e) => e.ergebnis !== 'SUCCEEDED' || e.aktivierung === 'AKTIV', {
    message: '„Erfolgreich" verlangt die Aktivierung AKTIV.',
    path: ['aktivierung'],
  })
  .refine((e) => e.ergebnis !== 'ROLLED_BACK' || e.aktivierung === 'ZURUECK', {
    message: '„Zurückgesetzt" verlangt die Aktivierung ZURUECK.',
    path: ['aktivierung'],
  });

export type ReleaseUebernahme = z.infer<typeof releaseUebernahmeSchema>;
export type ReleaseErgebnis = z.infer<typeof releaseErgebnisSchema>;
