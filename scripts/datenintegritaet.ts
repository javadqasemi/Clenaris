/**
 * Datenintegrität prüfen — nur lesend (Wave 24).
 *
 *   npx tsx scripts/datenintegritaet.ts [--json pfad]
 *   INTEGRITAET_DATABASE_URL=… npx tsx scripts/datenintegritaet.ts
 *
 * ---------------------------------------------------------------------------
 *  Wozu
 * ---------------------------------------------------------------------------
 *
 * Die Regeln dieses Projekts stehen an drei Orten: im Dienst (der sie beim
 * Schreiben einhält), in der Datenbank (Trigger, Teilindizes, Prüfbedingungen)
 * und in den Tests (die zeigen, dass beides greift). Was fehlte, war der Blick
 * auf den **Bestand**: Stimmen die gespeicherten Zahlen heute noch
 * miteinander überein — nach Migrationen, Handkorrekturen, Wiederherstellungen
 * und Fehlern, die es früher gab?
 *
 * Jede Prüfung ist eine Gleichung, die im Bestand gelten muss. Das Skript
 * ändert nichts; es zählt Abweichungen und nennt höchstens fünf Kennungen je
 * Prüfung — **keine** Namen, Beträge oder Adressen, damit die Ausgabe in ein
 * Ticket darf.
 *
 * Die erste Fassung fand sofort einen Produktfehler: Zahlung und Storno
 * rechneten den Saldo ohne Gutschriften (`saldoNeuBilden` im Rechnungsdienst).
 *
 * ---------------------------------------------------------------------------
 *  Fehler und Hinweise
 * ---------------------------------------------------------------------------
 *
 * `fehler` sind Verletzungen einer Regel, die der Code garantiert — Exit 1.
 * `hinweis` sind Befunde, die einen legitimen Grund haben können
 * (Altbestand vor einer Regel, Aufräumen in Testdaten) und angesehen werden
 * müssen, aber nichts beweisen. Eine Testdatenbank zeigt Hinweise, weil
 * Prüfreihen an den Triggern vorbei aufräumen; eine Produktionsdatenbank
 * sollte keine zeigen.
 */
// eslint-disable-next-line no-restricted-imports
import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'node:fs';

export interface Pruefung {
  schluessel: string;
  art: 'fehler' | 'hinweis';
  beschreibung: string;
  sql: string;
}

/*
  Jede Abfrage liefert Zeilen mit einer Spalte `id` (Kennung, keine
  Personendaten). Gezählt wird die Anzahl Zeilen.
*/
export const PRUEFUNGEN: Pruefung[] = [
  {
    schluessel: 'rechnung_brutto',
    art: 'fehler',
    beschreibung: 'Ausgestellte Rechnung: Brutto = Netto + MWST (auf den Rappen)',
    sql: `SELECT id FROM invoices
          WHERE status <> 'DRAFT' AND abs("grossTotal" - ("netTotal" + "vatAmount")) > 0.01`,
  },
  {
    schluessel: 'rechnung_bezahlt',
    art: 'fehler',
    beschreibung: 'Bezahlter Betrag = Summe der erfolgreichen Zahlungen',
    sql: `SELECT i.id FROM invoices i
          LEFT JOIN (SELECT "invoiceId", sum(amount) s FROM payments WHERE status = 'SUCCEEDED' GROUP BY 1) p ON p."invoiceId" = i.id
          WHERE i.status <> 'DRAFT' AND abs(i."paidAmount" - coalesce(p.s, 0)) > 0.01`,
  },
  {
    schluessel: 'rechnung_saldo',
    art: 'fehler',
    beschreibung: 'Offener Posten = max(0, Brutto − Zahlungen − Gutschriften); storniert/abgeschrieben: 0',
    sql: `SELECT i.id FROM invoices i
          LEFT JOIN (SELECT "invoiceId", sum(amount) s FROM payments WHERE status = 'SUCCEEDED' GROUP BY 1) p ON p."invoiceId" = i.id
          LEFT JOIN (SELECT "invoiceId", sum("grossTotal") s FROM credit_notes GROUP BY 1) g ON g."invoiceId" = i.id
          WHERE i.status <> 'DRAFT' AND abs(i.balance -
            CASE WHEN i.status IN ('CANCELLED', 'WRITTEN_OFF') THEN 0
                 ELSE greatest(0, i."grossTotal" - coalesce(p.s, 0) - coalesce(g.s, 0)) END) > 0.01`,
  },
  {
    schluessel: 'rechnung_status_bezahlt',
    art: 'fehler',
    beschreibung: '„Bezahlt" nur ohne offenen Posten (Toleranz 5 Rappen)',
    sql: `SELECT id FROM invoices WHERE status = 'PAID' AND balance > 0.05`,
  },
  {
    schluessel: 'gutschrift_obergrenze',
    art: 'fehler',
    beschreibung: 'Gutschriften auf eine Rechnung übersteigen nie deren Brutto',
    sql: `SELECT i.id FROM invoices i
          JOIN (SELECT "invoiceId", sum("grossTotal") s FROM credit_notes WHERE "invoiceId" IS NOT NULL GROUP BY 1) g ON g."invoiceId" = i.id
          WHERE g.s > i."grossTotal" + 0.01`,
  },
  {
    schluessel: 'nummern_doppelt',
    art: 'fehler',
    beschreibung: 'Keine Belegnummer doppelt (Rechnung, Gutschrift) je Organisation',
    sql: `SELECT min(id) AS id FROM (
            SELECT id, "organizationId", number FROM invoices
            UNION ALL SELECT id, "organizationId", number FROM credit_notes) b
          GROUP BY "organizationId", number HAVING count(*) > 1`,
  },
  {
    schluessel: 'nummern_ueber_zaehler',
    art: 'fehler',
    beschreibung: 'Keine Laufnummer über dem Zähler ihres Jahres (sonst vergäbe der Zähler sie ein zweites Mal)',
    sql: `WITH belege AS (
            SELECT id, "organizationId", 'invoice' AS scope, number FROM invoices WHERE number ~ '-[0-9]{4}-[0-9]{5}$'
            UNION ALL SELECT id, "organizationId", 'credit_note', number FROM credit_notes WHERE number ~ '-[0-9]{4}-[0-9]{5}$')
          SELECT b.id FROM belege b
          LEFT JOIN number_sequences n ON n."organizationId" = b."organizationId" AND n.scope = b.scope
            AND n.year = substring(b.number from '-([0-9]{4})-[0-9]{5}$')::int
          WHERE coalesce(n.current, 0) < substring(b.number from '-([0-9]{5})$')::int`,
  },
  {
    schluessel: 'nummern_luecken',
    art: 'hinweis',
    beschreibung: 'Lücken in den Laufnummern von Rechnungen und Gutschriften (Art. 957a OR) — in Testdaten erwartbar, in der Produktion zu klären',
    sql: `WITH belege AS (
            SELECT "organizationId", 'invoice' AS scope, number FROM invoices WHERE number ~ '-[0-9]{4}-[0-9]{5}$'
            UNION ALL SELECT "organizationId", 'credit_note', number FROM credit_notes WHERE number ~ '-[0-9]{4}-[0-9]{5}$'),
          vergeben AS (
            SELECT "organizationId", scope, substring(number from '-([0-9]{4})-[0-9]{5}$')::int AS jahr,
                   substring(number from '-([0-9]{5})$')::int AS lauf FROM belege)
          SELECT n."organizationId" || ':' || n.scope || ':' || n.year || ':' || g AS id
          FROM number_sequences n
          CROSS JOIN LATERAL generate_series(1, n.current) g
          WHERE n.scope IN ('invoice', 'credit_note')
            AND NOT EXISTS (SELECT 1 FROM vergeben v WHERE v."organizationId" = n."organizationId"
                            AND v.scope = n.scope AND v.jahr = n.year AND v.lauf = g)`,
  },
  {
    schluessel: 'lager_negativ',
    art: 'fehler',
    beschreibung: 'Kein Lagerbestand unter null (Bestand = Summe der Bewegungen)',
    sql: `SELECT "materialId" AS id FROM stock_movements GROUP BY "materialId" HAVING sum(quantity) < 0`,
  },
  {
    schluessel: 'mandant_bezug',
    art: 'fehler',
    beschreibung: 'Belege verweisen nur auf Kundschaft der eigenen Organisation',
    sql: `SELECT x.id FROM (
            SELECT id, "organizationId", "customerId" FROM invoices
            UNION ALL SELECT id, "organizationId", "customerId" FROM credit_notes
            UNION ALL SELECT id, "organizationId", "customerId" FROM quotes WHERE "customerId" IS NOT NULL
            UNION ALL SELECT id, "organizationId", "customerId" FROM jobs
            UNION ALL SELECT id, "organizationId", "customerId" FROM contracts
            UNION ALL SELECT id, "organizationId", "customerId" FROM complaints WHERE "customerId" IS NOT NULL
            UNION ALL SELECT id, "organizationId", "customerId" FROM site_visits WHERE "customerId" IS NOT NULL) x
          JOIN customers c ON c.id = x."customerId"
          WHERE c."organizationId" <> x."organizationId"`,
  },
  {
    schluessel: 'offerte_annahme',
    art: 'fehler',
    beschreibung: 'Abgeschlossene Offertannahme ⇒ Offerte angenommen (Signaturkern, Gate 4C)',
    sql: `SELECT r.id FROM signature_requests r JOIN quotes q ON q.id = r."quoteId"
          WHERE r.status = 'COMPLETED' AND q.status NOT IN ('ACCEPTED', 'CONVERTED')`,
  },
  {
    schluessel: 'zeit_freigabe_offen',
    art: 'fehler',
    beschreibung: 'Keine freigegebene Zeit ohne Ende',
    sql: `SELECT id FROM time_entries WHERE approved AND "endedAt" IS NULL`,
  },
  {
    schluessel: 'einsatz_materialaufwand',
    art: 'hinweis',
    beschreibung: 'Materialaufwand eines Einsatzes = Summe seiner Materialzeilen',
    sql: `SELECT j.id FROM jobs j
          LEFT JOIN (SELECT "jobId", sum(total) s FROM material_usages GROUP BY 1) m ON m."jobId" = j.id
          WHERE abs(j."materialCost" - coalesce(m.s, 0)) > 0.01`,
  },
  {
    schluessel: 'kundenwert',
    art: 'hinweis',
    beschreibung: 'Kundenwert = Summe der erfolgreichen Zahlungen (Altbestand und Seeds können abweichen)',
    sql: `SELECT c.id FROM customers c
          LEFT JOIN (
            SELECT coalesce(i."customerId", p."customerId") k, sum(p.amount) s
            FROM payments p LEFT JOIN invoices i ON i.id = p."invoiceId"
            WHERE p.status = 'SUCCEEDED' GROUP BY 1) z ON z.k = c.id
          WHERE abs(c."lifetimeValue" - coalesce(z.s, 0)) > 0.01`,
  },
];

function argument(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export interface Ergebnis {
  schluessel: string;
  art: Pruefung['art'];
  beschreibung: string;
  anzahl: number;
  beispiele: string[];
}

/** Alle Prüfungen gegen eine Verbindung — auch aus `tests/api/datenintegritaet.test.ts`. */
export async function pruefen(prisma: Pick<PrismaClient, '$queryRawUnsafe'>): Promise<Ergebnis[]> {
  const ergebnisse: Ergebnis[] = [];
  for (const p of PRUEFUNGEN) {
    const zeilen = await prisma.$queryRawUnsafe<{ id: string }[]>(p.sql);
    ergebnisse.push({
      schluessel: p.schluessel,
      art: p.art,
      beschreibung: p.beschreibung,
      anzahl: zeilen.length,
      beispiele: zeilen.slice(0, 5).map((z) => String(z.id)),
    });
  }
  return ergebnisse;
}

async function main(): Promise<void> {
  const url = process.env.INTEGRITAET_DATABASE_URL?.trim();
  const prisma = new PrismaClient(url ? { datasources: { db: { url } } } : undefined);
  let ergebnisse: Ergebnis[];
  try {
    ergebnisse = await pruefen(prisma);
  } finally {
    await prisma.$disconnect();
  }

  let fehler = 0;
  for (const e of ergebnisse) {
    const zeichen = e.anzahl === 0 ? '✓' : e.art === 'fehler' ? '✗' : '!';
    if (e.anzahl > 0 && e.art === 'fehler') fehler++;
    console.log(`${zeichen} ${e.schluessel.padEnd(26)} ${String(e.anzahl).padStart(6)}  ${e.beschreibung}`);
    if (e.anzahl > 0) console.log(`    z. B. ${e.beispiele.join(', ')}`);
  }
  const json = argument('json');
  if (json) writeFileSync(json, `${JSON.stringify(ergebnisse, null, 2)}\n`);
  console.log(fehler === 0 ? '\nKeine Regelverletzung.' : `\n${fehler} Prüfung(en) mit Regelverletzung.`);
  if (fehler > 0) process.exit(1);
}

if (process.argv[1] && /datenintegritaet\.(ts|js)$/.test(process.argv[1])) {
  main().catch((f) => {
    console.error(f instanceof Error ? f.message : f);
    process.exit(2);
  });
}
