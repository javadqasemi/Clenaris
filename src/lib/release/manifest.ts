import { z } from 'zod';

/**
 * Der Vertrag des Release-Artefakts — `RELEASE.json`, Format 2 (2026-09-30).
 *
 * **Eine Datei, vier Leser.** Das Artefakt entsteht in `scripts/release-artefakt.ts`,
 * und vier Stellen verlassen sich danach auf seinen Inhalt: die Aktivierung
 * auf dem Server (`deploy/v2/release-aktivieren.sh`), die Produktions-
 * vorprüfung, der Release-Ausführer (`scripts/release-ausfuehrer.ts`) und die
 * laufende Instanz selbst, die ihre Identität aus dieser Datei liest
 * (`src/lib/release/identitaet.ts`, `/api/health`). Format 1 hatte keinen
 * gemeinsamen Vertrag: Jeder Leser prüfte, was ihm gerade wichtig war, und der
 * Ausführer las die Version gar nicht. Ein Artefakt, das in einem Leser
 * „gültig" und im nächsten „unbekannt" ist, beweist nichts — deshalb steht die
 * Form genau einmal hier, und jeder Leser parst gegen dieses Schema.
 *
 * **Warum kein `server-only`:** Die Skripte (Packen, Ausführer, Vorprüfung,
 * Rücksprung) laufen ausserhalb von Next und importieren diese Datei direkt.
 * Sie enthält nur Formen und Regeln, keine Geheimnisse und keinen Zugriff.
 *
 * **Identität, nicht Beschriftung.** Der Commit (40 Hexzeichen, nie ein
 * Kürzel) ist die unveränderliche technische Identität; die Versionsnummer
 * aus `package.json` ist die menschliche Bezeichnung derselben Fassung. Beide
 * reisen im Artefakt, damit weder das Release Center noch der Server eine
 * davon aus einer Umgebungsvariable glauben muss (früher: `APP_VERSION`, von
 * pm2 gesetzt — ein Artefakt A konnte so behaupten, B zu sein).
 */

/** Genau 40 Hexzeichen — ein Kürzel wäre mehrdeutig und passt nicht zum Artefaktnamen. */
export const COMMIT_MUSTER = /^[0-9a-f]{40}$/;
export const SHA256_MUSTER = /^[0-9a-f]{64}$/;
/** Semantische Version wie in `src/lib/version.ts` — ohne führendes `v`. */
export const SEMVER_MUSTER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;
/** Name eines Migrationsverzeichnisses: Zeitstempel und Kleinbuchstaben-Bezeichnung. */
export const MIGRATION_MUSTER = /^\d{14}_[a-z0-9_]+$/;

export const MANIFEST_FORMAT = 2;

/**
 * Herkunft aus der CI. `null` heisst: örtlich gepackt — und damit eine Probe,
 * nie eine Auslieferung. Die Werte stammen aus den `GITHUB_*`-Variablen des
 * Laufs, der gebaut und geprüft hat; der Ausführer vergleicht sie mit dem
 * Lauf, aus dem er das Artefakt geladen hat.
 */
export const ciHerkunftSchema = z
  .object({
    lauf: z.string().regex(/^\d{1,20}$/),
    versuch: z.string().regex(/^\d{1,6}$/),
    ereignis: z.string().regex(/^[a-z_]{1,40}$/),
    ref: z.string().min(1).max(200),
    repository: z.string().regex(/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/),
  })
  .strict();

export const artefaktManifestSchema = z
  .object({
    format: z.literal(MANIFEST_FORMAT),
    anwendung: z.literal('clenaris'),
    version: z.string().regex(SEMVER_MUSTER),
    commit: z.string().regex(COMMIT_MUSTER),
    unsauber: z.boolean(),
    buildId: z.string().min(1).max(200),
    distDir: z.string().min(1).max(100),
    /** Zeitpunkt des Commits (nicht des Packens) — deterministisch für denselben Stand. */
    quelleZeitUtc: z.string().datetime(),
    node: z.string().min(1).max(40),
    npm: z.string().min(1).max(40),
    plattform: z.string().min(1).max(60),
    next: z.string().min(1).max(40),
    sperrdateiSha256: z.string().regex(SHA256_MUSTER),
    seitenUrl: z.string().max(300).nullable(),
    reactKorrektur: z.literal('geprueft'),
    mitModulen: z.boolean(),
    /** Alle Migrationsverzeichnisse, sortiert — Abgleich mit Release Center und Datenbank. */
    migrationen: z.array(z.string().regex(MIGRATION_MUSTER)).max(2000),
    ci: ciHerkunftSchema.nullable(),
    auslieferbar: z.boolean(),
  })
  .strict();

export type ArtefaktManifest = z.infer<typeof artefaktManifestSchema>;
export type CiHerkunft = z.infer<typeof ciHerkunftSchema>;

/**
 * Die Beilage neben dem Archiv (`clenaris-<sha12>.json`): das Manifest plus,
 * was erst nach dem Packen feststeht. Die Prüfsumme kann nicht *im* Archiv
 * stehen, dessen Summe sie ist.
 */
export const artefaktBeilageSchema = artefaktManifestSchema
  .extend({
    archivSha256: z.string().regex(SHA256_MUSTER),
    archivGroesseBytes: z.number().int().positive(),
    /** Zeitpunkt des Packens — nur zur Nachvollziehbarkeit, nie ein Vergleichswert. */
    erstelltUtc: z.string().datetime(),
    /** Ob das Archiv normalisiert gepackt wurde (GNU tar: Reihenfolge, Zeiten, Besitzer). */
    archivNormalisiert: z.boolean(),
  })
  .strict();

export type ArtefaktBeilage = z.infer<typeof artefaktBeilageSchema>;

/**
 * Wann ein Artefakt ausgeliefert werden darf — eine Regel für Packen,
 * Aktivierung, Vorprüfung und Ausführer.
 *
 * Nur ein Bau aus der CI, auf `main`, durch einen Push oder einen von Hand
 * ausgelösten Lauf **auf `main`**: Ein Pull-Request-Lauf baut den
 * Zusammenführungs-Commit, der nie auf `main` stand; ein örtlicher Bau hat
 * keine geprüfte Herkunft. Dazu vollständig (mit Modulen), aus einem sauberen
 * Baum und aus `.next` — `start:built` liest `.next`, ein umgeleitetes
 * Bauverzeichnis wäre eine zweite, ungeprüfte Konfiguration.
 */
export function auslieferbarNach(m: Pick<ArtefaktManifest, 'mitModulen' | 'unsauber' | 'distDir' | 'ci'>): boolean {
  if (!m.mitModulen || m.unsauber || m.distDir !== '.next' || !m.ci) return false;
  if (m.ci.ref !== 'refs/heads/main') return false;
  return m.ci.ereignis === 'push' || m.ci.ereignis === 'workflow_dispatch';
}
