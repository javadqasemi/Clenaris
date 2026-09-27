/**
 * Erzwungener Widerruf aller Sitzungen — für die Umschaltung auf Production V2.
 *
 *   npx tsx scripts/sitzungen-widerrufen.ts                              Bestandsaufnahme (schreibt nichts)
 *   npx tsx scripts/sitzungen-widerrufen.ts --ausfuehren --bestaetigen <datenbankname>
 *   … --ausfuehren --bestaetigen <db> --oeffentliche-links               zusätzlich alle Kundenlinks
 *
 * ---------------------------------------------------------------------------
 *  Wozu
 * ---------------------------------------------------------------------------
 *
 * Auf dem alten Server waren Verwaltungskonten mit veröffentlichten
 * Passwörtern anmeldbar (Notfallauftrag 2026-09-27). Wer das genutzt hat,
 * hält womöglich noch eine Sitzung — ein Refresh-Token lebt bis zu 30 Tage —
 * oder einen Link zum Zurücksetzen eines Passworts, den er sich selbst
 * geschickt hat. Die Datenbank wandert nach Prüfung auf V2; diese Sitzungen
 * und Links dürfen nicht mitwandern.
 *
 * Was widerrufen wird (`--ausfuehren`):
 *
 *   • **Zugangstoken** (JWT, 15 Minuten): `User.sessionsRevokedAt = jetzt` für
 *     jedes Konto. `getSession` weist jedes vorher ausgestellte Token ab
 *     (`kontoPruefen` in `src/lib/auth/session.ts`) — sofort, nicht erst nach
 *     Ablauf. Derselbe Mechanismus wie `revokeAllSessions`, nur für alle.
 *   • **Refresh-Token**: `revokedAt = jetzt` für jedes offene Token.
 *   • **Einmal-Links** aus `verification_tokens` (Passwort zurücksetzen,
 *     Einladung, E-Mail-Bestätigung, Magic Link): `usedAt = jetzt`.
 *   • **Unterzeichnungscodes** (`signature_otp_challenges`): entwertet.
 *
 * Was **nicht** ohne ausdrückliche Angabe widerrufen wird:
 *
 *   • **Kundenlinks** (`public_access_tokens`: Offerte, Rechnung, Buchung,
 *     Unterzeichnung). Ihr Widerruf trifft die Kundschaft, nicht den
 *     Angreifer, und neue Links müssen neu versendet werden. Das ist eine
 *     Betriebsentscheidung (`--oeffentliche-links`), keine Voreinstellung.
 *   • **Zweiter Faktor.** Ein eingeschleustes TOTP-Geheimnis überlebt einen
 *     Sitzungswiderruf. Die Bestandsaufnahme listet deshalb jedes Konto, das
 *     seinen zweiten Faktor im Verdachtszeitraum (`--seit <ISO-Datum>`)
 *     bestätigt hat; zurückgesetzt wird er je Konto im Sicherheitszentrum
 *     (`resetTwoFactorFor`), nach Rücksprache mit der Person.
 *   • **Gemerkte Geräte** gibt es nicht: `rememberMe` wird am Server nicht
 *     ausgewertet (Stand 2026-09-27) — nichts zu widerrufen.
 *
 * Der Zwischenschein der Zwei-Faktor-Anmeldung (`clenaris_mfa`, 5 Minuten)
 * und alle Zugangstoken hängen zusätzlich an `JWT_SECRET`. Auf V2 wird er neu
 * erzeugt (Rotationsmatrix in `docs/NOTFALL_WIEDERHERSTELLUNG.md`) — das
 * entwertet jedes Token kryptografisch, unabhängig von dieser Datenbank.
 *
 * ---------------------------------------------------------------------------
 *  Schranken
 * ---------------------------------------------------------------------------
 *
 * Ohne `--ausfuehren` schreibt das Skript nichts. Mit `--ausfuehren` verlangt
 * es `--bestaetigen <name>` mit genau dem Namen der verbundenen Datenbank —
 * ein Widerruf gegen die falsche Datenbank meldet die ganze Belegschaft ab.
 * Alles geschieht in einer Transaktion und mit einem Eintrag im
 * Prüfprotokoll je Organisation. Auf dem alten Server wird es **nie**
 * ausgeführt — er ist Beweismaterial.
 */

// eslint-disable-next-line no-restricted-imports
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function argument(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const ausfuehren = process.argv.includes('--ausfuehren');
  const links = process.argv.includes('--oeffentliche-links');
  const seitRoh = argument('--seit');
  const seit = seitRoh ? new Date(seitRoh) : null;
  if (seitRoh && Number.isNaN(seit!.getTime())) throw new Error('--seit erwartet ein ISO-Datum, etwa 2026-09-01.');

  const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
  const jetzt = new Date();

  const bestand = {
    konten: await prisma.user.count({ where: { deletedAt: null } }),
    refreshOffen: await prisma.refreshToken.count({ where: { revokedAt: null, expiresAt: { gt: jetzt } } }),
    einmalLinksOffen: await prisma.verificationToken.count({ where: { usedAt: null, expiresAt: { gt: jetzt } } }),
    otpOffen: await prisma.signatureOtpChallenge.count({ where: { usedAt: null, invalidatedAt: null, expiresAt: { gt: jetzt } } }),
    kundenlinksOffen: await prisma.publicAccessToken.count({ where: { revokedAt: null, expiresAt: { gt: jetzt } } }),
    geraeteSperren: await prisma.deviceHandoffSession.count({ where: { status: 'ACTIVE' } }),
  };
  const zweitfaktor = await prisma.user.findMany({
    where: { twoFactorEnabled: true, deletedAt: null, ...(seit ? { twoFactorConfirmedAt: { gte: seit } } : {}) },
    select: { id: true, role: true, twoFactorConfirmedAt: true },
    orderBy: { twoFactorConfirmedAt: 'desc' },
  });

  console.log(`Datenbank                         : ${db}`);
  console.log(`Konten                            : ${bestand.konten}`);
  console.log(`Offene Refresh-Token              : ${bestand.refreshOffen}`);
  console.log(`Offene Einmal-Links               : ${bestand.einmalLinksOffen}`);
  console.log(`Offene Unterzeichnungscodes       : ${bestand.otpOffen}`);
  console.log(`Offene Kundenlinks                : ${bestand.kundenlinksOffen}${links ? ' (werden widerrufen)' : ' (bleiben — --oeffentliche-links)'}`);
  console.log(`Aktive Gerätesperren              : ${bestand.geraeteSperren} (enden mit der Sitzung; Freigabe nur per Passwort)`);
  console.log(`Zweiter Faktor${seit ? ` seit ${seit.toISOString().slice(0, 10)}` : ' (alle)'}${' '.repeat(seit ? 5 : 13)}: ${zweitfaktor.length} Konto/Konten`);
  for (const k of zweitfaktor) console.log(`    ${k.id}  ${k.role.padEnd(12)} bestätigt ${k.twoFactorConfirmedAt?.toISOString() ?? '—'}`);

  if (!ausfuehren) {
    console.log('\nBestandsaufnahme — nichts geschrieben. Ausführen: --ausfuehren --bestaetigen <datenbankname>');
    return;
  }
  if (argument('--bestaetigen') !== db) {
    console.error(`\n❌  --bestaetigen muss genau „${db}" lauten. Nichts geschrieben.`);
    process.exit(1);
  }

  const organisationen = await prisma.organization.findMany({ select: { id: true } });
  const ergebnis = await prisma.$transaction(async (tx) => {
    const konten = await tx.user.updateMany({ data: { sessionsRevokedAt: jetzt } });
    const refresh = await tx.refreshToken.updateMany({ where: { revokedAt: null }, data: { revokedAt: jetzt } });
    const einmal = await tx.verificationToken.updateMany({ where: { usedAt: null }, data: { usedAt: jetzt } });
    const otp = await tx.signatureOtpChallenge.updateMany({ where: { usedAt: null, invalidatedAt: null }, data: { invalidatedAt: jetzt } });
    const kunden = links
      ? await tx.publicAccessToken.updateMany({ where: { revokedAt: null }, data: { revokedAt: jetzt } })
      : { count: 0 };
    for (const org of organisationen) {
      await tx.auditLog.create({
        data: {
          organizationId: org.id,
          action: 'PERMISSION_CHANGE',
          entity: 'Sitzungswiderruf',
          summary: `Erzwungener Widerruf aller Sitzungen (Umschaltung V2): ${konten.count} Konten, ${refresh.count} Refresh-Token, ${einmal.count} Einmal-Links, ${otp.count} Codes, ${kunden.count} Kundenlinks`,
          changes: { werkzeug: 'scripts/sitzungen-widerrufen.ts', kundenlinks: links },
        },
      });
    }
    return { konten: konten.count, refresh: refresh.count, einmal: einmal.count, otp: otp.count, kunden: kunden.count };
  });

  console.log(
    `\n✓  Widerrufen: ${ergebnis.konten} Konten (Zugangstoken), ${ergebnis.refresh} Refresh-Token, ${ergebnis.einmal} Einmal-Links, ${ergebnis.otp} Codes, ${ergebnis.kunden} Kundenlinks.`,
  );
  console.log('   Nächste Schritte: JWT_SECRET neu (Rotationsmatrix), Zweitfaktor-Liste oben mit den Personen klären.');
}

main()
  .catch((error: unknown) => {
    console.error('Sitzungswiderruf abgebrochen:', error instanceof Error ? error.message : 'unbekannter Fehler');
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
