/**
 * Eine Clenaris-Version im Update Center eintragen.
 *
 *   npx tsx scripts/release-registrieren.ts release/manifest-1.1.0.json --artefakt release/clenaris-<sha12>.json
 *
 * Das ist der **einzige** Weg, auf dem eine Version in die Tabelle `releases`
 * kommt. Kein Endpunkt nimmt eine Versionsbeschreibung an: Wer eine Version
 * beschreiben darf, muss Zugriff auf den Server haben — über das Dashboard
 * soll niemand eine „neue Version" erfinden können, deren Freigabe dann ein
 * Ausführer ernst nimmt.
 *
 * Gedacht für die Production-V2-Pipeline: Nach einem grünen Lauf der
 * Prüfstufe schreibt ein Mensch das Manifest (Änderungsprotokoll in
 * Administrationssprache, nicht die Commit-Liste) und trägt es mit diesem
 * Skript zusammen mit der **Beilage des Artefakts** ein. Eine bereits
 * eingetragene Nummer mit anderem Inhalt wird abgelehnt — Versionen werden
 * nicht umgeschrieben.
 *
 * ---------------------------------------------------------------------------
 *  Was aus der Beilage kommt, und warum (2026-09-30)
 * ---------------------------------------------------------------------------
 *
 * Commit, Prüfsumme und Grösse des Archivs standen bis hierher im von Hand
 * geschriebenen Manifest — ein Tippfehler dort hiess ein Release, dessen
 * Prüfsumme kein Artefakt je trifft, oder schlimmer: dessen Commit ein
 * anderer ist als der, den das Archiv trägt. Jetzt kommen sie aus der
 * Beilage, die `scripts/release-artefakt.ts` neben dem Archiv ablegt und die
 * gegen denselben Vertrag geparst wird wie auf dem Server
 * (`artefaktBeilageSchema`, Format 2). Das Skript weist ab:
 *
 *  - eine Beilage, die den Vertrag nicht erfüllt;
 *  - eine Probe (`auslieferbar: false`, keine CI-Herkunft, oder die Regel
 *    `auslieferbarNach` nicht erfüllt) — was nie ausgeliefert werden darf,
 *    soll im Update Center auch nicht zur Freigabe stehen;
 *  - eine abweichende Version: Das Manifest beschreibt 1.2.0, das Artefakt
 *    ist 1.1.9 — dann beschreibt es das falsche Artefakt;
 *  - Commit, Prüfsumme oder Grösse im Manifest, die der Beilage
 *    widersprechen (fehlen dürfen sie; dann gilt die Beilage);
 *  - Migrationen im Manifest, die das Artefakt nicht enthält: Die
 *    Beschreibung versprach dem Betrieb ein Schema, das nie ankommt.
 *
 * Ausgeführt wird dadurch nichts. Das Skript schreibt Metadaten, sonst nichts.
 */

import Module from 'node:module';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from 'dotenv';

import { artefaktBeilageSchema, auslieferbarNach, type ArtefaktBeilage } from '../src/lib/release/manifest';
import type { ReleaseManifest } from '../src/lib/validation/system';

/**
 * Manifest und Beilage zusammenführen — rein, ohne Datenbank, damit die
 * Ablehnungsgründe ohne Server prüfbar sind (`tests/api/release-center.test.ts`).
 * Gibt entweder das vollständige Manifest oder die Liste der Gründe zurück.
 */
export function mitBeilageZusammenfuehren(
  manifest: ReleaseManifest,
  beilage: ArtefaktBeilage,
): { ok: true; manifest: ReleaseManifest } | { ok: false; gruende: string[] } {
  const gruende: string[] = [];
  if (!beilage.auslieferbar || !beilage.ci) {
    gruende.push('Die Beilage beschreibt eine Probe (auslieferbar=false oder ohne CI-Herkunft) — eine Probe wird nicht registriert.');
  } else if (!auslieferbarNach(beilage)) {
    gruende.push('Die Beilage nennt sich auslieferbar, erfüllt die Regel aber nicht (Bau aus der CI auf main, mit Modulen, sauber, .next).');
  }
  if (manifest.version !== beilage.version) {
    gruende.push(`Das Manifest beschreibt Version ${manifest.version}, das Artefakt ist ${beilage.version}.`);
  }
  if (manifest.commit !== null && manifest.commit !== beilage.commit) {
    gruende.push(`Das Manifest nennt Commit ${manifest.commit.slice(0, 12)}, das Artefakt ${beilage.commit.slice(0, 12)}.`);
  }
  if (manifest.artifactSha256 !== null && manifest.artifactSha256 !== beilage.archivSha256) {
    gruende.push('Das Manifest nennt eine andere Artefakt-Prüfsumme als die Beilage.');
  }
  if (manifest.artifactSizeBytes !== null && manifest.artifactSizeBytes !== beilage.archivGroesseBytes) {
    gruende.push(`Das Manifest nennt ${manifest.artifactSizeBytes} Bytes, das Archiv hat ${beilage.archivGroesseBytes}.`);
  }
  const fehlend = manifest.migrations.filter((m) => !beilage.migrationen.includes(m));
  if (fehlend.length > 0) {
    gruende.push(`Migrationen im Manifest, die das Artefakt nicht enthält: ${fehlend.join(', ')}.`);
  }
  if (gruende.length > 0) return { ok: false, gruende };
  return {
    ok: true,
    manifest: {
      ...manifest,
      commit: beilage.commit,
      artifactSha256: beilage.archivSha256,
      artifactSizeBytes: beilage.archivGroesseBytes,
    },
  };
}

function jsonLesen(datei: string, was: string): unknown {
  try {
    return JSON.parse(readFileSync(resolve(datei), 'utf8'));
  } catch (error) {
    console.error(`${was} nicht lesbar: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

async function main() {
  const datei = process.argv[2];
  const i = process.argv.indexOf('--artefakt');
  const beilageDatei = i >= 0 ? process.argv[i + 1] : undefined;
  if (!datei || datei.startsWith('--') || !beilageDatei) {
    console.error('Aufruf: npx tsx scripts/release-registrieren.ts <manifest.json> --artefakt <beilage.json>');
    process.exit(2);
  }

  /** `server-only` gibt es nur innerhalb von Next — siehe `scripts/server-only-stub.cjs`. */
  const moduleWithResolver = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const originalResolve = moduleWithResolver._resolveFilename;
  moduleWithResolver._resolveFilename = function (request: string, ...rest: unknown[]) {
    if (request === 'server-only') return join(__dirname, 'server-only-stub.cjs');
    return originalResolve.call(this, request, ...rest);
  };
  config();

  const { releaseManifestSchema } = await import('../src/lib/validation/system');

  const geprueft = releaseManifestSchema.safeParse(jsonLesen(datei, 'Manifest'));
  if (!geprueft.success) {
    console.error('Manifest ungültig:');
    for (const fehler of geprueft.error.issues) console.error(`  ${fehler.path.join('.') || '(Wurzel)'}: ${fehler.message}`);
    process.exit(1);
  }
  const beilage = artefaktBeilageSchema.safeParse(jsonLesen(beilageDatei, 'Beilage'));
  if (!beilage.success) {
    console.error('Beilage des Artefakts ungültig (verlangt: Format 2, scripts/release-artefakt.ts):');
    for (const fehler of beilage.error.issues) console.error(`  ${fehler.path.join('.') || '(Wurzel)'}: ${fehler.message}`);
    process.exit(1);
  }
  const zusammen = mitBeilageZusammenfuehren(geprueft.data, beilage.data);
  if (!zusammen.ok) {
    console.error('Nicht registriert:');
    for (const grund of zusammen.gruende) console.error(`  ${grund}`);
    process.exit(1);
  }

  const { releaseEintragen } = await import('../src/server/services/release.service');
  const { prisma } = await import('../src/lib/db');
  try {
    const { angelegt, release } = await releaseEintragen(zusammen.manifest);
    console.log(
      angelegt
        ? `Version ${release.version} eingetragen (Commit ${beilage.data.commit.slice(0, 12)}, Artefakt ${beilage.data.archivSha256.slice(0, 12)}…).`
        : `Version ${release.version} war bereits identisch eingetragen.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && /release-registrieren\.(ts|js)$/.test(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
