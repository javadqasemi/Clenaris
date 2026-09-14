/**
 * Kennzahl-Snapshots rückwärts füllen.
 *
 *   npx tsx scripts/backfill-kpi.ts --months 24
 *
 * Nach der Migration ist das Cockpit leer, und ein Verlauf mit einem einzigen
 * Punkt überzeugt niemanden, das Modul weiter zu benutzen. Dieses Skript
 * rechnet die vergangenen Perioden nach und schreibt sie endgültig
 * (`provisional = false`). Es gehört ins Projekt, nicht als einmaliger
 * Handgriff — beim nächsten Kennzahlzuwachs wird es wieder gebraucht.
 *
 * Bestehende endgültige Snapshots werden überschrieben (`force`): Wer das
 * Skript ausführt, will den Verlauf aus dem heutigen Datenbestand — das ist
 * die bewusste Ausnahme von der Regel, dass Festgeschriebenes nicht mehr
 * angefasst wird.
 */

import Module from 'node:module';
import { join } from 'node:path';
import { config } from 'dotenv';

config();

/**
 * `server-only` gibt es nur innerhalb von Next. Die Auflösung wird vor dem
 * ersten Dienst-Import auf eine leere Datei umgebogen — siehe
 * `scripts/server-only-stub.cjs`.
 */
const moduleWithResolver = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
const originalResolve = moduleWithResolver._resolveFilename;
moduleWithResolver._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'server-only') return join(__dirname, 'server-only-stub.cjs');
  return originalResolve.call(this, request, ...rest);
};

async function main() {
  const args = process.argv.slice(2);
  const monthsIndex = args.indexOf('--months');
  const months = monthsIndex >= 0 ? Number(args[monthsIndex + 1]) : 24;
  if (!Number.isFinite(months) || months < 1 || months > 120) {
    console.error('Bitte --months zwischen 1 und 120 angeben.');
    process.exit(1);
  }

  // Erst nach dem Laden der Umgebung importieren — die Dienste lesen
  // DATABASE_URL beim Start. `server-only` ist unter tsx ein leeres Modul.
  const { getOrganizationId } = await import('../src/server/services/organization.service');
  const { backfillKpi } = await import('../src/server/services/kpi.service');
  const { snapshotHealth } = await import('../src/server/services/health.service');
  const { syncAllAutomaticKeyResults } = await import('../src/server/services/objective.service');
  const { prisma } = await import('../src/lib/db');

  const organizationId = await getOrganizationId();
  console.log(`⏳  Rechne ${months} Monate zurück …`);
  const started = Date.now();
  const summary = await backfillKpi(organizationId, months);
  console.log(`✓ ${summary.written} Snapshots geschrieben, ${summary.noValue} ohne Wert (leerer Nenner)`);
  if (summary.missingCalculators.length) console.warn(`⚠ Ohne Rechner: ${summary.missingCalculators.join(', ')}`);
  if (summary.failures.length) {
    console.warn(`⚠ ${summary.failures.length} Fehler:`);
    for (const failure of summary.failures.slice(0, 10)) console.warn(`   ${failure.key}: ${failure.error}`);
  }

  const keyResults = await syncAllAutomaticKeyResults(organizationId);
  console.log(`✓ ${keyResults} automatische Schlüsselergebnisse nachgeführt`);

  const health = await snapshotHealth(organizationId);
  console.log(health.score === null ? '– Gesundheitswert noch nicht berechenbar (Zielwerte fehlen)' : `✓ Gesundheitswert ${health.score}/100`);
  console.log(`Fertig in ${Math.round((Date.now() - started) / 1000)} s.`);
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error('❌  Rückwärtsfüllung fehlgeschlagen:', error);
  process.exit(1);
});
