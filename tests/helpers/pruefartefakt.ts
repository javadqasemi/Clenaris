import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  artefaktBeilageSchema,
  artefaktManifestSchema,
  MANIFEST_FORMAT,
  type ArtefaktBeilage,
  type ArtefaktManifest,
} from '../../src/lib/release/manifest';

/**
 * Prüfartefakte für die Release-Prüfungen (2026-09-30, Production-V2-Härtung).
 *
 * Identität der Instanz, Produktionsvorprüfung und Release-Ausführer lesen
 * alle dasselbe `RELEASE.json` (Format 2) beziehungsweise dessen Beilage. Die
 * Prüfungen bauen es hier an **einer** Stelle und parsen es gegen denselben
 * Vertrag wie die Anwendung: Ändert sich das Schema, scheitert der Aufbau
 * hier laut, statt dass drei Prüfdateien still ein veraltetes Manifest
 * schreiben, das die Anwendung dann aus dem falschen Grund abweist.
 *
 * Die Vorgaben beschreiben ein auslieferbares Artefakt (CI, `main`, Push,
 * mit Modulen, sauber, `.next`) mit der Version aus `package.json` — genau
 * das, was eine Instanz und die Vorprüfung als belegt annehmen. Jede Prüfung
 * verdirbt davon, was sie prüfen will.
 */

const WURZEL = join(__dirname, '..', '..');

/** Die Version, die in den Code eingebaut wird — das Manifest muss sie nennen. */
export const PAKET_VERSION = (JSON.parse(readFileSync(join(WURZEL, 'package.json'), 'utf8')) as { version: string }).version;

/** Ein erkennbar künstlicher Commit, aus einem Hash abgeleitet (siehe `webhooks.ts`). */
export const PRUEF_ARTEFAKT_COMMIT = createHash('sha1').update('clenaris-pruefartefakt').digest('hex');
export const PRUEF_BUILD_ID = 'pruefbau-identitaet-0001';

export function pruefManifest(ueber: Partial<ArtefaktManifest> = {}): ArtefaktManifest {
  return artefaktManifestSchema.parse({
    format: MANIFEST_FORMAT,
    anwendung: 'clenaris',
    version: PAKET_VERSION,
    commit: PRUEF_ARTEFAKT_COMMIT,
    unsauber: false,
    buildId: PRUEF_BUILD_ID,
    distDir: '.next',
    quelleZeitUtc: '2026-09-30T10:00:00.000Z',
    node: 'v22.23.2',
    npm: '10.9.0',
    plattform: 'linux-x64',
    next: '15.5.26',
    sperrdateiSha256: 'a'.repeat(64),
    seitenUrl: null,
    reactKorrektur: 'geprueft',
    mitModulen: true,
    migrationen: ['20260926100000_versionsverwaltung', '20260927190100_release_ausfuehrung'],
    ci: { lauf: '4242', versuch: '1', ereignis: 'push', ref: 'refs/heads/main', repository: 'beispiel/clenaris' },
    auslieferbar: true,
    ...ueber,
  });
}

/** Die Beilage zu einem Archiv — Prüfsumme und Grösse aus den echten Bytes. */
export function pruefBeilage(archiv: Buffer, ueber: Partial<ArtefaktBeilage> = {}): ArtefaktBeilage {
  const { archivSha256, archivGroesseBytes, erstelltUtc, archivNormalisiert, ...manifest } = ueber;
  return artefaktBeilageSchema.parse({
    ...pruefManifest(manifest),
    archivSha256: archivSha256 ?? createHash('sha256').update(archiv).digest('hex'),
    archivGroesseBytes: archivGroesseBytes ?? archiv.length,
    erstelltUtc: erstelltUtc ?? '2026-09-30T10:05:00.000Z',
    archivNormalisiert: archivNormalisiert ?? true,
  });
}

/**
 * Ein Instanzverzeichnis mit `RELEASE.json` und `<distDir>/BUILD_ID`.
 *
 * `manifest: null` lässt `RELEASE.json` weg, ein String wird wörtlich
 * geschrieben (für unlesbare Dateien), alles andere als JSON. `buildId: null`
 * lässt die Bau-Kennung weg.
 */
export function pruefVerzeichnis(o: { manifest?: unknown; buildId?: string | null; distDir?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'clenaris-identitaet-'));
  const manifest = o.manifest === undefined ? pruefManifest() : o.manifest;
  if (manifest !== null) {
    writeFileSync(join(dir, 'RELEASE.json'), typeof manifest === 'string' ? manifest : `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const buildId = o.buildId === undefined ? PRUEF_BUILD_ID : o.buildId;
  if (buildId !== null) {
    mkdirSync(join(dir, o.distDir ?? '.next'), { recursive: true });
    writeFileSync(join(dir, o.distDir ?? '.next', 'BUILD_ID'), buildId);
  }
  return dir;
}
