import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Strukturelle Grundlinie (2026-09-29, M1 der Release-Kandidaten-Prüfung).
 *
 * ---------------------------------------------------------------------------
 *  Warum neben der Merkmalsprüfung
 * ---------------------------------------------------------------------------
 *
 * `feature-integrity.ts` ist eine Heuristik und blockiert deshalb nichts
 * (Begründung dort). Das hatte eine Nebenwirkung: Auch ein **sicherer**
 * Rückschritt lief als Hinweis durch. Verschwindet ein Endpunkt, fällt eine
 * Berechtigung aus dem Katalog, wird eine Migration gelöscht oder zeigt ein
 * Navigationseintrag auf eine Seite, die es nicht mehr gibt, dann ist das
 * keine Vermutung über den Quelltext, sondern eine Tatsache — und in einer
 * Freigabe fast immer ein Unfall (eine verlorene Datei beim Zusammenführen,
 * ein zu breites Löschen beim Aufräumen).
 *
 * Diese Datei hält die Tatsachen fest und vergleicht sie mit der
 * eingecheckten Grundlinie `security/struktur-grundlinie.json`:
 *
 *   • **Endpunkte** — jede exportierte Methode je `route.ts` („POST /api/quotes").
 *   • **Berechtigungen** — der Katalog `PERMISSIONS`.
 *   • **Migrationen** — die Verzeichnisnamen unter `prisma/migrations`.
 *     Eine angewendete Migration aus dem Repository zu entfernen bricht jede
 *     frische Datenbank und `migrate deploy` in Produktion.
 *   • **Navigationsziele** — jeder `href` der drei Bereichslayouts muss auf
 *     eine vorhandene Seite zeigen. Das braucht keine Grundlinie.
 *
 * **Hinzukommen ist frei, Wegfallen blockiert.** Wer etwas absichtlich
 * entfernt, schreibt die Grundlinie neu (`--grundlinie-schreiben`) — im
 * selben Commit, sichtbar in der Durchsicht als entfernte Zeile. Ein stilles
 * Verschwinden ist damit ausgeschlossen, ein gewolltes kostet eine Zeile.
 *
 * Die Vergleichsfunktion ist rein und in `tests/api/strukturgrundlinie.test.ts`
 * direkt geprüft; das Einlesen bleibt hier.
 */

export interface Struktur {
  endpunkte: string[];
  berechtigungen: string[];
  migrationen: string[];
}

export interface Strukturbefund {
  /** Blockierend: fehlt gegenüber der Grundlinie oder zeigt ins Leere. */
  fehler: string[];
  /** Nicht blockierend: neu gegenüber der Grundlinie (Grundlinie nachziehen). */
  neu: string[];
}

const METHODEN = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

function dateienUnter(verzeichnis: string, name: string): string[] {
  const treffer: string[] = [];
  const gehe = (ordner: string) => {
    for (const eintrag of readdirSync(ordner)) {
      const voll = join(ordner, eintrag);
      if (statSync(voll).isDirectory()) gehe(voll);
      else if (eintrag === name) treffer.push(voll);
    }
  };
  if (existsSync(verzeichnis)) gehe(verzeichnis);
  return treffer;
}

/** `src/app/api/quotes/[id]/route.ts` → `/api/quotes/[id]`. */
function routenpfad(wurzel: string, datei: string): string {
  return `/${relative(join(wurzel, 'src', 'app'), datei).split(sep).join('/')}`.replace(/\/route\.ts$/, '');
}

export function strukturLesen(wurzel: string): Struktur {
  const endpunkte: string[] = [];
  for (const datei of dateienUnter(join(wurzel, 'src', 'app', 'api'), 'route.ts')) {
    const inhalt = readFileSync(datei, 'utf8');
    const pfad = routenpfad(wurzel, datei);
    for (const methode of METHODEN) {
      if (new RegExp(`export\\s+(?:const|async\\s+function|function)\\s+${methode}\\b`).test(inhalt)) endpunkte.push(`${methode} ${pfad}`);
    }
  }

  // Nur der Block des Katalogs — `PERMISSION_META` weiter unten nennt dieselben Namen noch einmal.
  const katalog = readFileSync(join(wurzel, 'src', 'lib', 'auth', 'permissions.ts'), 'utf8');
  const anfang = katalog.indexOf('export const PERMISSIONS = [');
  const ende = katalog.indexOf('] as const', anfang);
  if (anfang < 0 || ende < 0) throw new Error('Berechtigungskatalog `PERMISSIONS = [ … ] as const` nicht gefunden.');
  const berechtigungen = [...katalog.slice(anfang, ende).matchAll(/'([a-z_]+:[a-z_]+)'/g)].map((m) => m[1]!);

  const migrationsordner = join(wurzel, 'prisma', 'migrations');
  const migrationen = readdirSync(migrationsordner).filter((n) => statSync(join(migrationsordner, n)).isDirectory());

  return {
    endpunkte: [...new Set(endpunkte)].sort(),
    berechtigungen: [...new Set(berechtigungen)].sort(),
    migrationen: migrationen.sort(),
  };
}

/**
 * Alle Seitenrouten als Muster: Routengruppen `(…)` fallen weg, dynamische
 * Segmente `[id]` passen auf jedes Segment.
 */
function seitenmuster(wurzel: string): RegExp[] {
  return dateienUnter(join(wurzel, 'src', 'app'), 'page.tsx').map((datei) => {
    const segmente = relative(join(wurzel, 'src', 'app'), datei)
      .split(sep)
      .slice(0, -1)
      .filter((s) => !/^\(.*\)$/.test(s));
    const quelle = segmente
      .map((s) => (/^\[\[?\.\.\./.test(s) ? '.*' : /^\[.*\]$/.test(s) ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/');
    return new RegExp(`^/${quelle}$`);
  });
}

/** Navigationsziele der drei Bereiche, jeweils mit Datei. */
export function navigationszieleLesen(wurzel: string): { ziel: string; datei: string }[] {
  const layouts = ['admin', 'portal', 'konto'].map((b) => join(wurzel, 'src', 'app', '(app)', b, 'layout.tsx'));
  const ziele: { ziel: string; datei: string }[] = [];
  for (const datei of layouts) {
    const inhalt = readFileSync(datei, 'utf8');
    for (const m of inhalt.matchAll(/href:\s*'(\/[^'?#]*)/g)) ziele.push({ ziel: m[1]!, datei: relative(wurzel, datei).split(sep).join('/') });
  }
  return ziele;
}

export function strukturVergleichen(
  grundlinie: Struktur,
  aktuell: Struktur,
  navigation: { ziel: string; datei: string }[] = [],
  seiten: RegExp[] = [],
): Strukturbefund {
  const fehler: string[] = [];
  const neu: string[] = [];
  const art: [keyof Struktur, string][] = [
    ['endpunkte', 'Endpunkt'],
    ['berechtigungen', 'Berechtigung'],
    ['migrationen', 'Migration'],
  ];
  for (const [schluessel, name] of art) {
    const jetzt = new Set(aktuell[schluessel]);
    const vorher = new Set(grundlinie[schluessel]);
    for (const e of grundlinie[schluessel]) if (!jetzt.has(e)) fehler.push(`${name} fehlt gegenüber der Grundlinie: ${e}`);
    for (const e of aktuell[schluessel]) if (!vorher.has(e)) neu.push(`${name} neu: ${e}`);
  }
  for (const { ziel, datei } of navigation) {
    if (!seiten.some((s) => s.test(ziel))) fehler.push(`Navigationsziel ohne Seite: ${ziel} (${datei})`);
  }
  return { fehler, neu };
}

export function strukturPruefen(wurzel: string, grundlinienDatei: string): Strukturbefund & { aktuell: Struktur } {
  const aktuell = strukturLesen(wurzel);
  if (!existsSync(grundlinienDatei)) {
    return { fehler: [`Grundlinie ${relative(wurzel, grundlinienDatei)} fehlt — ohne sie ist kein Rückschritt erkennbar.`], neu: [], aktuell };
  }
  const grundlinie = JSON.parse(readFileSync(grundlinienDatei, 'utf8')) as Struktur;
  return { ...strukturVergleichen(grundlinie, aktuell, navigationszieleLesen(wurzel), seitenmuster(wurzel)), aktuell };
}
