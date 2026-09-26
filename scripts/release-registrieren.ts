/**
 * Eine Clenaris-Version im Update Center eintragen.
 *
 *   npx tsx scripts/release-registrieren.ts release/manifest-1.1.0.json
 *
 * Das ist der **einzige** Weg, auf dem eine Version in die Tabelle `releases`
 * kommt. Kein Endpunkt nimmt eine Versionsbeschreibung an: Wer eine Version
 * beschreiben darf, muss Zugriff auf den Server haben — über das Dashboard
 * soll niemand eine „neue Version" erfinden können, deren Freigabe dann ein
 * Ausführer ernst nimmt.
 *
 * Gedacht für die Production-V2-Pipeline: Nach einem grünen Lauf der
 * Prüfstufe schreibt sie das Manifest (Änderungsprotokoll in
 * Administrationssprache, nicht die Commit-Liste) und trägt es mit diesem
 * Skript ein. Das Skript prüft gegen `releaseManifestSchema` und schreibt
 * nichts, was nicht besteht. Eine bereits eingetragene Nummer mit anderem
 * Inhalt wird abgelehnt — Versionen werden nicht umgeschrieben.
 *
 * Ausgeführt wird dadurch nichts. Das Skript schreibt Metadaten, sonst nichts.
 */

import Module from 'node:module';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from 'dotenv';

config();

/** `server-only` gibt es nur innerhalb von Next — siehe `scripts/server-only-stub.cjs`. */
const moduleWithResolver = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
const originalResolve = moduleWithResolver._resolveFilename;
moduleWithResolver._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'server-only') return join(__dirname, 'server-only-stub.cjs');
  return originalResolve.call(this, request, ...rest);
};

async function main() {
  const datei = process.argv[2];
  if (!datei) {
    console.error('Aufruf: npx tsx scripts/release-registrieren.ts <manifest.json>');
    process.exit(2);
  }

  const { releaseManifestSchema } = await import('../src/lib/validation/system');
  const { releaseEintragen } = await import('../src/server/services/release.service');
  const { prisma } = await import('../src/lib/db');

  let roh: unknown;
  try {
    roh = JSON.parse(readFileSync(resolve(datei), 'utf8'));
  } catch (error) {
    console.error(`Manifest nicht lesbar: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  const geprueft = releaseManifestSchema.safeParse(roh);
  if (!geprueft.success) {
    console.error('Manifest ungültig:');
    for (const fehler of geprueft.error.issues) console.error(`  ${fehler.path.join('.') || '(Wurzel)'}: ${fehler.message}`);
    process.exit(1);
  }

  try {
    const { angelegt, release } = await releaseEintragen(geprueft.data);
    console.log(angelegt ? `Version ${release.version} eingetragen.` : `Version ${release.version} war bereits identisch eingetragen.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
