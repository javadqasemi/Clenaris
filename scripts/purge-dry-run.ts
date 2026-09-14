/**
 * Datenbereinigung zur Probe — führt aus und rollt zurück.
 *
 *   npx tsx scripts/purge-dry-run.ts                          # alle Bereiche
 *   npx tsx scripts/purge-dry-run.ts finanzen auftraege       # nur diese
 *   npx tsx scripts/purge-dry-run.ts --nummernkreise          # mit Rücksetzen
 *
 * Warum es dieses Skript gibt: Ein echter Lauf leert den Bestand, und genau
 * deshalb lässt sich der Löschpfad nicht gegen die laufende Anwendung prüfen.
 * Hier läuft `runPurge` selbst — dieselben Löschschritte in derselben
 * Reihenfolge, derselbe Protokolleintrag, dasselbe Zurücksetzen der
 * Nummernkreise — in einer Transaktion, die am Ende zurückgerollt wird.
 *
 * Was das findet: einen falsch geschriebenen Modellnamen, eine ungültige
 * `where`-Bedingung und vor allem eine Fremdschlüsselsperre, die sonst erst
 * im Betrieb zuschlüge. Es schreibt nichts; der Bestand bleibt unverändert.
 */

import Module from 'node:module';
import { join } from 'node:path';
import { config } from 'dotenv';

config();

/** `server-only` gibt es nur innerhalb von Next — siehe `scripts/server-only-stub.cjs`. */
const moduleWithResolver = Module as unknown as {
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};
const originalResolve = moduleWithResolver._resolveFilename;
moduleWithResolver._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'server-only') return join(__dirname, 'server-only-stub.cjs');
  return originalResolve.call(this, request, ...rest);
};

async function main() {
  const { PURGE_AREAS, runPurge } = await import('../src/server/services/purge.service');
  const { getOrganizationId } = await import('../src/server/services/organization.service');
  const { prisma } = await import('../src/lib/db');

  const args = process.argv.slice(2);
  const resetSequences = args.includes('--nummernkreise');
  const wanted = args.filter((arg) => !arg.startsWith('--'));

  const keys = PURGE_AREAS.map((area) => area.key);
  const unknown = wanted.filter((arg) => !keys.includes(arg as (typeof keys)[number]));
  if (unknown.length > 0) {
    console.error(`Unbekannte Bereiche: ${unknown.join(', ')}\nErlaubt: ${keys.join(', ')}`);
    process.exit(1);
  }
  const areas = wanted.length ? (wanted as typeof keys) : keys;

  const organizationId = await getOrganizationId();
  // Ein Konto, das im echten Lauf ausgenommen bliebe — dieselbe Bedingung wie
  // dort, damit die Probe die echten Mengen zeigt.
  const actor = await prisma.user.findFirstOrThrow({
    where: { organizationId, role: 'SUPER_ADMIN' },
    select: { id: true, email: true },
  });

  console.log(
    `⏳  Probelauf als ${actor.email} — ${areas.length} Bereiche` +
      `${resetSequences ? ', Nummernkreise werden zurückgesetzt' : ''}. Wird zurückgerollt.\n`,
  );

  const before = await prisma.auditLog.count({ where: { organizationId } });

  try {
    const results = await runPurge({
      organizationId,
      actorId: actor.id,
      areas,
      resetSequences,
      ip: null,
      userAgent: 'purge-dry-run',
      dryRun: true,
    });

    for (const area of results) {
      console.log(`  ${area.label}`);
      for (const entry of area.deleted) {
        console.log(`    ✓ ${String(entry.count).padStart(5)}  ${entry.label}`);
      }
      if (area.sequencesReset.length > 0) {
        console.log(`    ↺ Nummernkreise: ${area.sequencesReset.join(', ')}`);
      }
    }

    // Der Beweis, dass wirklich nichts geschrieben wurde: Das Protokoll
    // bekommt je Bereich einen Eintrag — nach dem Rücksprung keinen einzigen.
    const after = await prisma.auditLog.count({ where: { organizationId } });
    if (after !== before) {
      console.error(`\n✗  Rücksprung unvollständig: ${after - before} Protokolleinträge blieben stehen.`);
      process.exit(1);
    }

    const total = results.reduce((sum, area) => sum + area.total, 0);
    console.log(`\n✅  ${total} Datensätze durchgespielt, alle Schritte laufen. Zurückgerollt.`);
  } catch (error) {
    console.error('\n✗  Probelauf fehlgeschlagen:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
