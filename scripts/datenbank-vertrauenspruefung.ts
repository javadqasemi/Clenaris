/**
 * Vertrauensprüfung einer wiederhergestellten Datenbank — nur lesend, nur auf
 * einer Kopie.
 *
 *   npx tsx scripts/datenbank-vertrauenspruefung.ts --seit 2026-08-31
 *   … --bericht pruefung.json          zusätzlich als Datei
 *   … --bestaetigen <datenbankname>    wenn der Name keine Kopie ausweist
 *
 * ---------------------------------------------------------------------------
 *  Wozu — und was „Sicherung geprüft" nicht heisst
 * ---------------------------------------------------------------------------
 *
 * Die Produktionsdatenbank lief auf einem Server, der als nicht
 * vertrauenswürdig gilt (Notfallauftrag 2026-09-27), und auf dem die
 * Verwaltung mit veröffentlichten Passwörtern anmeldbar war.
 * `scripts/db-restore-verify.ts` beweist, dass eine Sicherung sich
 * **wiederherstellen** lässt — Struktur, Zeilenzahlen, `pg_restore` ohne
 * Fehler. Das ist die strukturelle Gültigkeit. Ob die **Daten** stimmen, sagt
 * es nicht: Ein Angreifer mit Verwaltungskonto hinterlässt eine vollkommen
 * gültige Sicherung — mit einem zusätzlichen Administrator, einem
 * umgeleiteten Webhook, einer Erstattung an sich selbst.
 *
 * Dieses Skript beantwortet die zweite Frage, so weit ein Skript das kann:
 * Es listet, was nach einem Einbruch anders aussähe, und markiert es als
 * AUFFÄLLIG (Handlung nötig) oder PRÜFEN (von einer Person durchzusehen). Es
 * entscheidet nichts und ändert nichts. Die Freigabe der Daten für V2 ist
 * eine Entscheidung der Betreiberin auf Grundlage dieses Berichts
 * (`docs/NOTFALL_WIEDERHERSTELLUNG.md`, Datenübernahme).
 *
 * ---------------------------------------------------------------------------
 *  Schranken
 * ---------------------------------------------------------------------------
 *
 *   • **Nur lesend.** Ausschliesslich `SELECT` — und die Verbindung wird mit
 *     `default_transaction_read_only` geöffnet, sodass auch ein Fehler in
 *     diesem Skript nichts schreiben kann.
 *   • **Nur auf einer Kopie.** Der Datenbankname muss sie als
 *     Wiederherstellung ausweisen (`restore`, `wiederherstellung`, `pruef`,
 *     `validierung`, `forensik`) — sonst verlangt das Skript
 *     `--bestaetigen <name>`. Nie gegen die laufende Produktion und nie auf
 *     dem alten Server.
 *   • **Keine Geheimnisse in der Ausgabe.** Konten erscheinen mit Kennung,
 *     Rolle und Zeitstempeln; E-Mail-Adressen nur für Konten mit
 *     Verwaltungsrolle, weil genau die geprüft werden müssen.
 */

import { writeFileSync } from 'node:fs';

// eslint-disable-next-line no-restricted-imports

import { OEFFENTLICHE_DEMO_ADRESSEN, OEFFENTLICHE_PASSWOERTER } from '../src/lib/auth/oeffentliche-zugangsdaten';
import { erzeugePrismaClient } from '../src/lib/prisma-client';
import { fremdeErweiterungen, livePruefen, registerLesen, registerZusammenfassung, schemaAusAdresse } from './security/datenbank-schranken';

type Stufe = 'AUFFAELLIG' | 'PRUEFEN' | 'OK';

interface Abschnitt {
  titel: string;
  stufe: Stufe;
  zusammenfassung: string;
  zeilen: Record<string, unknown>[];
}

function argument(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Die Adresse mit `default_transaction_read_only=on` — lesend auf Verbindungsebene. */
function nurLesendeAdresse(url: string): string {
  const u = new URL(url);
  const vorhandene = u.searchParams.get('options');
  const zusatz = '-c default_transaction_read_only=on';
  u.searchParams.set('options', vorhandene ? `${vorhandene} ${zusatz}` : zusatz);
  return u.toString();
}

const KOPIE = /(restore|wiederherstell|pruef|validier|forensik)/i;

async function main(): Promise<void> {
  const seitRoh = argument('--seit');
  if (!seitRoh) throw new Error('--seit <ISO-Datum> fehlt — Beginn des Verdachtszeitraums (etwa die Inbetriebnahme des alten Servers).');
  const seit = new Date(seitRoh);
  if (Number.isNaN(seit.getTime())) throw new Error('--seit ist kein gültiges Datum.');
  const roh = process.env.DATABASE_URL;
  if (!roh) throw new Error('DATABASE_URL fehlt.');

  const prisma = erzeugePrismaClient({ url: nurLesendeAdresse(roh) });
  const abschnitte: Abschnitt[] = [];
  const neu = { gte: seit };

  try {
    const [{ db, nurlesend }] = await prisma.$queryRaw<{ db: string; nurlesend: string }[]>`
      SELECT current_database() AS db, current_setting('default_transaction_read_only') AS nurlesend`;
    if (nurlesend !== 'on') throw new Error('Die Verbindung ist nicht nur lesend — abgebrochen.');
    if (!KOPIE.test(db) && argument('--bestaetigen') !== db) {
      throw new Error(`„${db}" weist sich nicht als Wiederherstellungskopie aus. Nur auf einer Kopie prüfen — oder --bestaetigen ${db}.`);
    }
    console.log(`Datenbank: ${db} (nur lesend) · Verdachtszeitraum ab ${seit.toISOString().slice(0, 10)}\n`);

    // --- 1. Organisationen ----------------------------------------------------
    const organisationen = await prisma.organization.findMany({ select: { id: true, slug: true, createdAt: true } });
    abschnitte.push({
      titel: 'Organisationen',
      stufe: organisationen.length === 1 ? 'OK' : 'AUFFAELLIG',
      zusammenfassung: `${organisationen.length} Organisation(en) — erwartet ist genau eine.`,
      zeilen: organisationen,
    });

    // --- 2. Konten mit Verwaltungsrolle ---------------------------------------
    const { verify } = await import('@node-rs/argon2');
    const verwaltung = await prisma.user.findMany({
      where: { role: { in: ['SUPER_ADMIN', 'ADMIN', 'MANAGER'] } },
      select: {
        id: true, email: true, role: true, status: true, deletedAt: true, createdAt: true, lastLoginAt: true,
        lastLoginIp: true, passwordChangedAt: true, twoFactorEnabled: true, twoFactorConfirmedAt: true, passwordHash: true, organizationId: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    const kontenZeilen: Record<string, unknown>[] = [];
    let kontenAuffaellig = 0;
    for (const k of verwaltung) {
      const gruende: string[] = [];
      if (k.createdAt >= seit) gruende.push('im Verdachtszeitraum angelegt');
      if (k.twoFactorConfirmedAt && k.twoFactorConfirmedAt >= seit) gruende.push('Zweitfaktor im Verdachtszeitraum eingerichtet');
      if (OEFFENTLICHE_DEMO_ADRESSEN.includes(k.email.toLowerCase())) gruende.push('öffentliche Demoadresse');
      if (k.passwordHash) {
        for (const pw of OEFFENTLICHE_PASSWOERTER) {
          if (await verify(k.passwordHash, pw).catch(() => false)) {
            gruende.push('öffentlich bekanntes Passwort');
            break;
          }
        }
      }
      if (gruende.some((g) => g !== 'öffentliche Demoadresse')) kontenAuffaellig++;
      const { passwordHash: _h, ...ohneHash } = k;
      kontenZeilen.push({ ...ohneHash, befund: gruende.join('; ') || '—' });
    }
    abschnitte.push({
      titel: 'Konten mit Verwaltungsrolle',
      stufe: kontenAuffaellig > 0 ? 'AUFFAELLIG' : 'PRUEFEN',
      zusammenfassung: `${verwaltung.length} Konto/Konten, ${kontenAuffaellig} mit Befund. Jedes einzelne ist einer bekannten Person zuzuordnen.`,
      zeilen: kontenZeilen,
    });

    // --- 3. Rechte- und Rollenwechsel ------------------------------------------
    const rechte = await prisma.auditLog.findMany({
      where: { action: 'PERMISSION_CHANGE', createdAt: neu },
      select: { createdAt: true, userId: true, entity: true, entityId: true, summary: true, ip: true },
      orderBy: { createdAt: 'asc' },
    });
    abschnitte.push({
      titel: 'Rechte- und Rollenwechsel (Prüfprotokoll)',
      stufe: rechte.length > 0 ? 'PRUEFEN' : 'OK',
      zusammenfassung: `${rechte.length} Eintrag/Einträge im Verdachtszeitraum.`,
      zeilen: rechte,
    });

    // --- 4. Anmeldungen der Verwaltung nach Adresse ---------------------------
    const anmeldungen = await prisma.$queryRaw<{ ip: string | null; konten: bigint; anzahl: bigint; erste: Date; letzte: Date }[]>`
      SELECT e."ip", count(DISTINCT e."userId") AS konten, count(*) AS anzahl, min(e."occurredAt") AS erste, max(e."occurredAt") AS letzte
      FROM "security_events" e JOIN "users" u ON u."id" = e."userId"
      WHERE e."kind" = 'LOGIN_SUCCEEDED' AND e."occurredAt" >= ${seit} AND u."role" IN ('SUPER_ADMIN', 'ADMIN', 'MANAGER')
      GROUP BY e."ip" ORDER BY anzahl DESC`;
    abschnitte.push({
      titel: 'Erfolgreiche Anmeldungen der Verwaltung, nach Adresse',
      stufe: anmeldungen.length > 0 ? 'PRUEFEN' : 'OK',
      zusammenfassung: `${anmeldungen.length} Adresse(n). Jede unbekannte Adresse ist ein möglicher Zugriff mit veröffentlichten Zugangsdaten.`,
      zeilen: anmeldungen.map((a) => ({ ...a, konten: Number(a.konten), anzahl: Number(a.anzahl) })),
    });

    // --- 5. Zugriffstoken und Einmal-Links ------------------------------------
    const links = await prisma.$queryRaw<{ purpose: string; anzahl: bigint }[]>`
      SELECT "purpose"::text AS purpose, count(*) AS anzahl FROM "public_access_tokens"
      WHERE "createdAt" >= ${seit} GROUP BY "purpose" ORDER BY anzahl DESC`;
    const einmal = await prisma.$queryRaw<{ purpose: string; anzahl: bigint; adressen: bigint }[]>`
      SELECT "purpose", count(*) AS anzahl, count(DISTINCT "email") AS adressen FROM "verification_tokens"
      WHERE "createdAt" >= ${seit} AND "purpose" IN ('PASSWORD_RESET', 'MAGIC_LINK', 'INVITE') GROUP BY "purpose"`;
    abschnitte.push({
      titel: 'Ausgestellte Links im Verdachtszeitraum',
      stufe: 'PRUEFEN',
      zusammenfassung: 'Kundenlinks je Zweck und Einmal-Links (Passwort, Magic Link, Einladung). Einladungen und Passwort-Links auf unbekannte Adressen sind auffällig.',
      zeilen: [...links.map((l) => ({ art: 'Kundenlink', ...l, anzahl: Number(l.anzahl) })), ...einmal.map((e) => ({ art: 'Einmal-Link', ...e, anzahl: Number(e.anzahl), adressen: Number(e.adressen) }))],
    });

    // --- 6. Zahlungen und Erstattungen ----------------------------------------
    const zahlungen = await prisma.payment.findMany({
      where: {
        createdAt: neu,
        OR: [{ refundedAmount: { gt: 0 } }, { status: { in: ['REFUNDED', 'PARTIALLY_REFUNDED'] } }, { invoiceId: null }, { provider: 'manual' }],
      },
      select: { id: true, createdAt: true, amount: true, refundedAmount: true, status: true, provider: true, method: true, invoiceId: true, customerId: true },
      orderBy: { createdAt: 'asc' },
    });
    abschnitte.push({
      titel: 'Erstattungen, manuelle und rechnungslose Zahlungen',
      stufe: zahlungen.length > 0 ? 'PRUEFEN' : 'OK',
      zusammenfassung: `${zahlungen.length} Zahlung(en) — gegen Kontoauszug und Stripe-Dashboard abgleichen.`,
      zeilen: zahlungen.map((z) => ({ ...z, amount: z.amount.toString(), refundedAmount: z.refundedAmount.toString() })),
    });

    // --- 7. Dateien -------------------------------------------------------------
    const dateien = await prisma.$queryRaw<{ id: string; path: string; mimeType: string; sizeBytes: number; createdAt: Date }[]>`
      SELECT "id", "path", "mimeType", "sizeBytes", "createdAt" FROM "stored_files"
      WHERE "createdAt" >= ${seit}
        AND ("mimeType" NOT IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'text/csv',
                                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                                'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
             OR "path" ~* '\\.(sh|js|mjs|php|py|pl|elf|so|exe|bin|html?|svg)$'
             OR "path" LIKE '%..%')
      ORDER BY "createdAt"`;
    const ungeprueft = await prisma.$queryRaw<{ scanStatus: string; provenance: string; anzahl: bigint }[]>`
      SELECT "scanStatus"::text AS "scanStatus", "provenance"::text AS provenance, count(*) AS anzahl
      FROM "file_assets" WHERE "scanStatus" <> 'CLEAN' GROUP BY 1, 2`;
    abschnitte.push({
      titel: 'Ungewöhnliche Dateien und ungeprüfte Bestände',
      stufe: dateien.length > 0 ? 'AUFFAELLIG' : 'PRUEFEN',
      zusammenfassung: `${dateien.length} Ablage(n) mit ungewöhnlichem Typ, Namen oder Pfad im Verdachtszeitraum; ungeprüfte Bestände je Status. Keine Datei wird vor einer Prüfung mit einem echten Scanner freigegeben.`,
      zeilen: [...dateien, ...ungeprueft.map((u) => ({ ...u, anzahl: Number(u.anzahl) }))],
    });

    // --- 8. Automationen und Webhook-Ziele ------------------------------------
    const automationen = await prisma.automation.findMany({
      select: { id: true, name: true, trigger: true, active: true, createdAt: true, updatedAt: true, actions: { select: { type: true, config: true } } },
    });
    const erlaubt = (process.env.AUTOMATION_WEBHOOK_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
    const autoZeilen = automationen
      .map((a) => {
        const ziele = a.actions
          .filter((x) => x.type === 'WEBHOOK')
          .map((x) => {
            const url = (x.config as { url?: unknown } | null)?.url;
            try {
              return typeof url === 'string' ? new URL(url).hostname.toLowerCase() : '(ohne Ziel)';
            } catch {
              return '(ungültiges Ziel)';
            }
          });
        const fremd = ziele.filter((h) => !erlaubt.includes(h));
        const befund = [
          a.createdAt >= seit ? 'im Verdachtszeitraum angelegt' : null,
          a.updatedAt >= seit ? 'im Verdachtszeitraum geändert' : null,
          fremd.length > 0 ? `Webhook-Ziel ausserhalb AUTOMATION_WEBHOOK_HOSTS: ${fremd.join(', ')}` : null,
        ].filter(Boolean);
        return { id: a.id, name: a.name, trigger: a.trigger, aktiv: a.active, webhookZiele: ziele.join(', ') || '—', befund: befund.join('; ') || '—' };
      })
      .filter((z) => z.befund !== '—' || z.webhookZiele !== '—');
    abschnitte.push({
      titel: 'Automationen und Webhook-Ziele',
      stufe: autoZeilen.some((z) => z.befund.includes('Webhook-Ziel')) ? 'AUFFAELLIG' : autoZeilen.length > 0 ? 'PRUEFEN' : 'OK',
      zusammenfassung: `${autoZeilen.length} Automation(en) mit Webhook oder Änderung im Verdachtszeitraum. Ein Webhook ist der bequemste Weg, Daten dauerhaft abzuleiten.`,
      zeilen: autoZeilen,
    });

    // --- 9. Aktualisierungsaufträge -------------------------------------------
    const auftraege = await prisma.releaseRequest.findMany({
      where: { OR: [{ createdAt: neu }, { updatedAt: neu }] },
      select: { id: true, status: true, fromVersion: true, toVersion: true, approvedById: true, executorId: true, environment: true, createdAt: true },
    });
    abschnitte.push({
      titel: 'Aktualisierungsaufträge (Update Center)',
      stufe: auftraege.length > 0 ? 'PRUEFEN' : 'OK',
      zusammenfassung: `${auftraege.length} Auftrag/Aufträge im Verdachtszeitraum — ein übernommenes Verwaltungskonto kann Termine setzen.`,
      zeilen: auftraege,
    });

    // --- 10. Löschungen und Lücken im Prüfprotokoll ---------------------------
    const loeschungen = await prisma.$queryRaw<{ entity: string; anzahl: bigint }[]>`
      SELECT "entity", count(*) AS anzahl FROM "audit_logs" WHERE "action" = 'DELETE' AND "createdAt" >= ${seit}
      GROUP BY "entity" ORDER BY anzahl DESC`;
    const tage = await prisma.$queryRaw<{ tag: Date; anzahl: bigint }[]>`
      SELECT date_trunc('day', "createdAt" AT TIME ZONE 'Europe/Zurich') AS tag, count(*) AS anzahl
      FROM "audit_logs" WHERE "createdAt" >= ${seit} GROUP BY 1 ORDER BY 1`;
    const luecken: string[] = [];
    for (let i = 1; i < tage.length; i++) {
      const abstand = (tage[i]!.tag.getTime() - tage[i - 1]!.tag.getTime()) / 86_400_000;
      if (abstand > 3) luecken.push(`${tage[i - 1]!.tag.toISOString().slice(0, 10)} → ${tage[i]!.tag.toISOString().slice(0, 10)}`);
    }
    abschnitte.push({
      titel: 'Löschungen und Lücken im Prüfprotokoll',
      stufe: luecken.length > 0 ? 'AUFFAELLIG' : 'PRUEFEN',
      zusammenfassung: `${loeschungen.reduce((s, l) => s + Number(l.anzahl), 0)} Löschung(en); ${luecken.length} Lücke(n) von mehr als drei Tagen ohne Eintrag${luecken.length ? `: ${luecken.join(', ')}` : ''}.`,
      zeilen: loeschungen.map((l) => ({ ...l, anzahl: Number(l.anzahl) })),
    });

    // --- 11. Datenbankebene: Rollen, Erweiterungen, Funktionen, Trigger -------
    /**
     * Wer Zugriff auf den Host hatte, braucht die Anwendung nicht: Eine
     * zusätzliche Datenbankrolle, eine Erweiterung wie `dblink` oder eine
     * Funktion, die bei jedem INSERT Daten hinausschreibt, überlebt jede
     * Anwendungsprüfung — und reist mit einem vollständigen `pg_dump` mit.
     */
    const rollen = await prisma.$queryRaw<{ rolname: string; rolsuper: boolean; rolcanlogin: boolean }[]>`
      SELECT rolname, rolsuper, rolcanlogin FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY rolname`;
    const erweiterungen = await prisma.$queryRaw<{ extname: string }[]>`SELECT extname FROM pg_extension ORDER BY extname`;
    const ereignisTrigger = await prisma.$queryRaw<{ evtname: string }[]>`SELECT evtname FROM pg_event_trigger`;
    const trigger = await prisma.$queryRaw<{ tgname: string; tabelle: string }[]>`
      SELECT t.tgname, c.relname AS tabelle FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal ORDER BY t.tgname`;
    const schranken = registerLesen();
    const fremdeTrigger = trigger.filter((t) => !schranken.trigger.includes(t.tgname));
    /*
      Erlaubt sind die Grundliste **und** die Erweiterungen, die das Register
      als Träger einer Schranke nennt (seit 2026-09-30). Bis dahin fehlte
      `btree_gist` in der Grundliste, obwohl zwei Migrationen sie anlegen —
      jede ordnungsgemäss migrierte Kopie wurde deshalb als AUFFÄLLIG
      gemeldet. Die Regel steht in `fremdeErweiterungen`
      (`scripts/security/datenbank-schranken.ts`), wo die Prüfreihe sie
      gegen eine frisch migrierte Datenbank hält; dieses Skript selbst
      läuft nur gegen Wiederherstellungskopien und hat keine eigene Prüfung.
    */
    const erweiterungNamen = new Set(fremdeErweiterungen(erweiterungen.map((e) => e.extname), schranken));
    const fremdeErweiterungenListe = erweiterungen.filter((e) => erweiterungNamen.has(e.extname));
    abschnitte.push({
      titel: 'Datenbankebene: Rollen, Erweiterungen, Trigger',
      stufe: fremdeTrigger.length > 0 || fremdeErweiterungenListe.length > 0 || ereignisTrigger.length > 0 ? 'AUFFAELLIG' : 'PRUEFEN',
      zusammenfassung: `${rollen.length} Rolle(n) (jede einer bekannten Verwendung zuordnen), ${fremdeErweiterungenListe.length} unerwartete Erweiterung(en), ${fremdeTrigger.length} Trigger ausserhalb security/datenbank-schranken.json, ${ereignisTrigger.length} Ereignistrigger.`,
      zeilen: [
        ...rollen.map((r) => ({ art: 'Rolle', ...r })),
        ...fremdeErweiterungenListe.map((e) => ({ art: 'Erweiterung', ...e })),
        ...fremdeTrigger.map((t) => ({ art: 'Trigger', ...t })),
        ...ereignisTrigger.map((e) => ({ art: 'Ereignistrigger', ...e })),
      ],
    });

    // --- 12. Schranken: vorhanden und wirksam? --------------------------------
    /**
     * Abschnitt 11 fragt, was **zu viel** da ist. Ebenso verräterisch ist, was
     * fehlt oder abgeschaltet wurde: Wer die Datenbankrolle der Anwendung oder
     * den Host hatte, kann mit `ALTER TABLE audit_logs DISABLE TRIGGER …` das
     * Prüfprotokoll wieder änderbar machen, eine Spur löschen und den Trigger
     * stehen lassen — dem Namen nach vorhanden, in der Wirkung weg. Leiser
     * noch: die Triggerfunktion durch ein `RETURN COALESCE(NEW, OLD)`
     * ersetzen; Trigger und Schalter bleiben unberührt, nur der Rumpf ist
     * ein anderer. Dieselbe Prüfung wie das Datenbanktor
     * (`scripts/datenbank-schranken.ts`) — Bindung der Trigger, Prüfsumme
     * jedes Funktionsrumpfs —, nur lesend über die Kataloge.
     */
    const schrankenBefunde = (await livePruefen(prisma, schranken, schemaAusAdresse(roh))).filter((b) => b.schwere === 'blockierend');
    abschnitte.push({
      titel: 'Datenbankschranken: vorhanden und wirksam',
      stufe: schrankenBefunde.length > 0 ? 'AUFFAELLIG' : 'OK',
      zusammenfassung:
        schrankenBefunde.length > 0
          ? `${schrankenBefunde.length} Schranke(n) aus security/datenbank-schranken.json fehlen, sind abgeschaltet, ungültig, nicht validiert oder umgebaut (Trigger anders gebunden, Funktionsrumpf geändert) — vor einer Übernahme klären, wann und von wem.`
          : `Jede Schranke aus security/datenbank-schranken.json ist vorhanden und wirksam (${registerZusammenfassung(schranken)}).`,
      zeilen: schrankenBefunde.map((b) => ({ art: b.art, name: b.name, befund: b.titel })),
    });
  } finally {
    await prisma.$disconnect();
  }

  // --- Ausgabe -----------------------------------------------------------------
  const zeichen: Record<Stufe, string> = { AUFFAELLIG: '✗', PRUEFEN: '?', OK: '✓' };
  for (const a of abschnitte) {
    console.log(`${zeichen[a.stufe]} ${a.stufe.padEnd(10)} ${a.titel}\n  ${a.zusammenfassung}`);
    for (const z of a.zeilen.slice(0, 50)) console.log(`    ${JSON.stringify(z)}`);
    if (a.zeilen.length > 50) console.log(`    … ${a.zeilen.length - 50} weitere (--bericht)`);
    console.log('');
  }
  const bericht = argument('--bericht');
  if (bericht) {
    writeFileSync(bericht, JSON.stringify({ erstellt: new Date().toISOString(), seit: seit.toISOString(), abschnitte }, null, 2));
    console.log(`Bericht: ${bericht}`);
  }
  const auffaellig = abschnitte.filter((a) => a.stufe === 'AUFFAELLIG').length;
  console.log(
    auffaellig > 0
      ? `${auffaellig} Abschnitt(e) AUFFÄLLIG — vor einer Übernahme nach V2 klären.`
      : 'Nichts AUFFÄLLIG. Die Abschnitte PRÜFEN verlangen trotzdem eine Durchsicht durch eine Person.',
  );
  process.exit(auffaellig > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(`Vertrauensprüfung abgebrochen: ${error instanceof Error ? error.message : 'unbekannter Fehler'}`);
  process.exit(2);
});
