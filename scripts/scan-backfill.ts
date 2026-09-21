/**
 * Altbestand nachprüfen.
 *
 *   npx tsx scripts/scan-backfill.ts --probe          nur zählen, nichts ändern
 *   npx tsx scripts/scan-backfill.ts --anzahl 200     höchstens 200 Dateien
 *   npx tsx scripts/scan-backfill.ts                  alles Offene
 *
 * ---------------------------------------------------------------------------
 *  Wofür das da ist
 * ---------------------------------------------------------------------------
 *
 * Die Migration `…_datei_schadsoftware_pruefung` markiert jede zum
 * Migrationszeitpunkt vorhandene Datei als `LEGACY_UNSCANNED` mit Zustand
 * `PENDING`. Das ist eine ehrliche Aussage — niemand weiss, was in diesen
 * Dateien steht — und sie hat eine Folge: Der Altbestand ist nicht mehr
 * auslieferbar.
 *
 * Dieser Lauf holt die Prüfung nach. Er liest die Bytes erneut, gibt sie an
 * den eingerichteten Prüfer und schreibt den Zustand fort. Danach sind die
 * sauberen Dateien wieder erreichbar, und die anderen liegen in Quarantäne —
 * wo sie hingehören.
 *
 * ---------------------------------------------------------------------------
 *  Eigenschaften
 * ---------------------------------------------------------------------------
 *
 *  • **Wiederholbar.** `scanFileAsset` beansprucht jede Datei über einen
 *    bedingten Zustandswechsel; zwei gleichzeitige Läufe stören sich nicht.
 *    Ein abgebrochener Lauf lässt sich einfach neu starten.
 *  • **Nur lesend am Speicher.** Es werden keine Bytes verändert, keine
 *    Dateien verschoben und keine gelöscht.
 *  • **Ohne Prüfer tut er nichts Gutes.** Ist keiner eingerichtet, endet
 *    jede Datei in `ERROR/NO_SCANNER`. Der Lauf sagt das vorher und bricht ab.
 *  • **Abgebremst.** Zwischen den Dateien eine kurze Pause, damit ein
 *    Nachlauf über zehntausend Dateien den Prüfer nicht in die Knie zwingt
 *    und die laufende Anwendung nicht verdrängt.
 */
import Module from 'node:module';
import { join } from 'node:path';
import type { Prisma } from '@prisma/client';
import { config } from 'dotenv';

config();

/**
 * `server-only` gibt es nur innerhalb von Next. Die Auflösung wird vor dem
 * ersten Dienst-Import auf eine leere Datei umgebogen — dasselbe Muster wie
 * in `scripts/backfill-kpi.ts`.
 */
const moduleWithResolver = Module as unknown as {
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};
const originalResolve = moduleWithResolver._resolveFilename;
moduleWithResolver._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'server-only') return join(__dirname, 'server-only-stub.cjs');
  return originalResolve.call(this, request, ...rest);
};

const argumente = process.argv.slice(2);
const nurProbe = argumente.includes('--probe');
const anzahlIndex = argumente.indexOf('--anzahl');
const grenze =
  anzahlIndex >= 0 ? Number.parseInt(argumente[anzahlIndex + 1] ?? '', 10) : Number.POSITIVE_INFINITY;

const PAUSE_MS = 50;
const schlafe = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Was offen ist.
 *
 * `SYSTEM_GENERATED` und `TRUSTED_IMPORT` sind ausgenommen — sie durchlaufen
 * den Prüfablauf gar nicht, ihr `PENDING` heisst „war nie drin". Sie hier
 * mitzunehmen hiesse, den Prüfer mit unseren eigenen Rechnungs-PDF zu
 * beschäftigen.
 */
const OFFEN: Prisma.FileAssetWhereInput = {
  provenance: { in: ['LEGACY_UNSCANNED', 'USER_UPLOAD'] },
  scanStatus: { in: ['PENDING', 'ERROR'] },
};

async function main() {
  // Erst nach dem Umbiegen der Auflösung importieren.
  const { prisma } = await import('../src/lib/db');
  const { scanFileAsset } = await import('../src/server/services/file.service');
  const { getScanner } = await import('../src/lib/security/malware');

  const offen = await prisma.fileAsset.count({ where: OFFEN });
  const gesamt = await prisma.fileAsset.count();

  console.log('');
  console.log('  Dateien gesamt        :', gesamt);
  console.log('  davon offen           :', offen);

  const nachZustand = await prisma.fileAsset.groupBy({ by: ['scanStatus'], _count: true });
  for (const zeile of nachZustand) {
    console.log(`    ${String(zeile.scanStatus).padEnd(14)} ${zeile._count}`);
  }

  if (nurProbe) {
    console.log('\n  --probe: nichts geändert.\n');
    return;
  }

  if (offen === 0) {
    console.log('\n  Nichts zu tun.\n');
    return;
  }

  const scanner = getScanner();
  if (!scanner) {
    console.error(
      '\n  Kein Schadsoftwareprüfer eingerichtet (CLAMAV_HOST).\n' +
        '  Ohne Prüfer endet jede Datei in ERROR/NO_SCANNER — das bringt nichts.\n' +
        '  Abgebrochen.\n',
    );
    process.exitCode = 1;
    return;
  }

  const zustand = await scanner.health();
  if (!zustand.erreichbar) {
    console.error(`\n  Prüfer „${scanner.name}" nicht erreichbar (${zustand.grund ?? '—'}). Abgebrochen.\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n  Prüfer: ${scanner.name} — ${(await scanner.version()) ?? 'Fassung unbekannt'}\n`);

  const zaehler = { CLEAN: 0, INFECTED: 0, ERROR: 0, QUARANTINED: 0, UEBERSPRUNGEN: 0 };
  let bearbeitet = 0;
  let cursor: string | undefined;

  while (bearbeitet < grenze) {
    const stapel = await prisma.fileAsset.findMany({
      where: OFFEN,
      select: { id: true, filename: true },
      orderBy: { id: 'asc' },
      take: 50,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (stapel.length === 0) break;
    cursor = stapel[stapel.length - 1].id;

    for (const datei of stapel) {
      if (bearbeitet >= grenze) break;
      const ergebnis = await scanFileAsset(datei.id);
      zaehler[ergebnis.status] += 1;
      bearbeitet += 1;
      if (ergebnis.status === 'INFECTED' || ergebnis.status === 'QUARANTINED') {
        // Der Dateiname, nicht der Inhalt und nicht der Pfad.
        console.log(`    ! ${ergebnis.status.padEnd(12)} ${datei.filename}`);
      }
      await schlafe(PAUSE_MS);
    }
    console.log(`  … ${bearbeitet} bearbeitet`);
  }

  console.log('\n  Ergebnis:');
  for (const [k, v] of Object.entries(zaehler)) console.log(`    ${k.padEnd(14)} ${v}`);
  const rest = await prisma.fileAsset.count({ where: OFFEN });
  console.log(`\n  Noch offen: ${rest}`);
  if (rest > 0) console.log('  Erneut starten — ERROR-Fälle werden bis zur Versuchsgrenze wiederholt.');
  console.log('');
}

main()
  .catch((fehler) => {
    console.error(fehler);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { prisma } = await import('../src/lib/db');
    await prisma.$disconnect();
  });
