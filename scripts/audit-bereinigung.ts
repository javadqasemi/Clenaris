/**
 * Altbestand im Prüfprotokoll nachträglich schwärzen — **standardmässig nur zählen**.
 *
 *   npx tsx scripts/audit-bereinigung.ts                 # Trockenlauf: was wäre betroffen?
 *   npx tsx scripts/audit-bereinigung.ts --anwenden      # schreibt, nach ausdrücklicher Freigabe
 *
 * ---------------------------------------------------------------------------
 *  Wozu
 * ---------------------------------------------------------------------------
 *
 * Bis zum 2026-09-23 schrieb `updateEmployee` Lohn, Geburtsdatum,
 * Notfallkontakt, Wohnadresse und interne Notizen im Klartext nach
 * `audit_logs.changes` (RB-010). Die Schwärzung greift seither für neue
 * Einträge; die alten stehen noch da. Dieses Skript wendet **dieselbe** Regel
 * (`src/lib/sensitive-fields.ts`) auf den Bestand an.
 *
 * ---------------------------------------------------------------------------
 *  Warum der Trockenlauf die Vorgabe ist
 * ---------------------------------------------------------------------------
 *
 * Das Prüfprotokoll ist der Beleg. Es zu ändern ist ein Eingriff in einen
 * Beleg, und der gehört entschieden, nicht nebenbei ausgeführt:
 *
 *  • **Vorher sichern.** Ein `pg_dump` der Tabelle, verschlüsselt abgelegt
 *    (`scripts/db-backup.ts`), damit die Bereinigung selbst nachweisbar bleibt.
 *  • **Nur `changes` wird angefasst.** Wer, wann, welche Entität, welche
 *    Handlung und die Zusammenfassung bleiben unverändert — bis auf die
 *    Freitext-Schwärzung von IBAN/AHV/JWT in `summary`.
 *  • **Die Bereinigung wird selbst protokolliert** — ein Eintrag mit der
 *    Zahl der geschwärzten Zeilen, ohne Inhalte.
 *  • **In der Produktion nur nach Freigabe** durch die Verantwortlichen für
 *    Datenschutz; `--anwenden` ohne diese Freigabe ist ein Verstoss gegen die
 *    Betriebsanleitung (`docs/KEY_MANAGEMENT.md` §3.5), nicht gegen das Skript.
 *
 * Idempotent: Ein zweiter Lauf findet nichts mehr, weil geschwärzte Werte
 * geschwärzt bleiben.
 */

import type { Prisma } from '@prisma/client';
import { config } from 'dotenv';

import { freitextSchwaerzen, wertSchwaerzen } from '../src/lib/sensitive-fields';
import { erzeugePrismaClient } from '../src/lib/prisma-client';

config();

const anwenden = process.argv.includes('--anwenden');
const SEITE = 500;

async function main(): Promise<void> {
  const prisma = erzeugePrismaClient();
  let geprueft = 0;
  let betroffen = 0;
  const jeEntitaet = new Map<string, number>();

  try {
    let cursor: string | undefined;
    for (;;) {
      const zeilen = await prisma.auditLog.findMany({
        take: SEITE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
        select: { id: true, entity: true, changes: true, summary: true, organizationId: true },
      });
      if (zeilen.length === 0) break;

      for (const zeile of zeilen) {
        geprueft += 1;
        const neueAenderungen =
          zeile.changes === null ? null : wertSchwaerzen(zeile.changes, zeile.entity);
        const neueZusammenfassung = zeile.summary === null ? null : freitextSchwaerzen(zeile.summary);
        const geaendert =
          JSON.stringify(neueAenderungen) !== JSON.stringify(zeile.changes) ||
          neueZusammenfassung !== zeile.summary;
        if (!geaendert) continue;

        betroffen += 1;
        jeEntitaet.set(zeile.entity, (jeEntitaet.get(zeile.entity) ?? 0) + 1);
        if (anwenden) {
          await prisma.auditLog.update({
            where: { id: zeile.id },
            data: {
              changes: (neueAenderungen ?? undefined) as Prisma.InputJsonValue | undefined,
              summary: neueZusammenfassung,
            },
          });
        }
      }
      cursor = zeilen[zeilen.length - 1]!.id;
    }

    console.log('');
    console.log(`  Geprüfte Einträge : ${geprueft}`);
    console.log(`  Betroffen         : ${betroffen}`);
    for (const [entitaet, anzahl] of [...jeEntitaet].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${entitaet.padEnd(24)} ${anzahl}`);
    }
    console.log('');
    if (!anwenden) {
      console.log('  Trockenlauf — nichts geschrieben. Mit --anwenden wird geschwärzt (vorher sichern).');
      return;
    }

    if (betroffen > 0) {
      // Über den Slug wie `getOrganizationId()` — „die erste" trifft bei mehr als einer Organisation die falsche.
      const organisation = await prisma.organization.findFirst({
        where: { slug: process.env.ORGANIZATION_SLUG ?? 'clenaris' },
        select: { id: true },
      });
      if (organisation) {
        await prisma.auditLog.create({
          data: {
            organizationId: organisation.id,
            action: 'UPDATE',
            entity: 'AuditLog',
            summary: `Altbestand nachträglich geschwärzt: ${betroffen} Einträge (RB-010)`,
            changes: Object.fromEntries(jeEntitaet),
          },
        });
      }
    }
    console.log(`  ✓ ${betroffen} Einträge geschwärzt.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((fehler) => {
  console.error(fehler);
  process.exit(1);
});
