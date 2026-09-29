/**
 * Die Regel „nimm die geteilte Instanz aus `@/lib/db`" gilt für die
 * Anwendung: Dort erschöpfte eine zweite Instanz im serverlosen Betrieb den
 * Verbindungspool. Diese Datei läuft im Prüfprozess, nicht im Server, und
 * muss ausdrücklich auf eine *andere* Adresse zeigen als `@/lib/db` — genau
 * darin besteht ihr Schutz. Die geteilte Instanz zu nehmen hiesse, gegen die
 * Entwicklungsdatenbank zu lesen.
 */
// eslint-disable-next-line no-restricted-imports
import { type PrismaClient } from '@prisma/client';

import { databaseNameOf, istTestdatenbank } from '../../prisma/seed-guard';
import { erzeugePrismaClient } from '../../src/lib/prisma-client';

/**
 * Lesender Zugriff auf die Testdatenbank — nur wo HTTP nicht ausreicht.
 *
 * **Warum es das überhaupt gibt.** Die Prüfreihe fährt die Anwendung
 * grundsätzlich über echtes HTTP an; das ist der Entscheid aus
 * `tests/README.md` und er bleibt. Eine Frage lässt sich so aber nicht
 * stellen: „Öffnet der Link, den `sendQuote` tatsächlich verschickt hat, die
 * Offertseite?" Der rohe Token steht nur in der E-Mail, und in der Datenbank
 * liegt allein sein SHA-256-Hash — genau so soll es sein.
 *
 * Über diesen Zugang kann die Prüfreihe den Hash des soeben ausgestellten
 * Tokens nachschlagen und damit beweisen, dass Versand und Auflösung
 * zusammenpassen. Das ist der Test, der in Gate 1 gefehlt hat und wegen
 * dessen Fehlen jede versendete Offerte auf eine 404-Seite führte.
 *
 * **Die Namensprüfung ist nicht verhandelbar.** Sie nimmt dieselbe Funktion
 * wie `prisma/seed-guard.ts` und `scripts/setup-test-db.ts`. Zeigt die
 * Adresse nicht auf eine erkennbare Testdatenbank, verweigert dieser Zugang
 * den Dienst — lieber übersprungene Prüfungen als eine Prüfreihe, die in die
 * Entwicklungsdatenbank greift.
 *
 * Geschäftsdaten schreibt hier niemand; die Anwendung bleibt die einzige
 * Stelle, die sie verändert. Die zwei Ausnahmen sind benannt und eng: das
 * Aufräumen an den Unveränderlichkeitstriggern vorbei
 * (`schutzfreiAufraeumen`) und die **fremde Organisation** als Gegenüber
 * für Mandantenprüfungen (`fremdeOrganisation`) — beides lässt sich über
 * HTTP nicht herstellen, weil die Anwendung genau das verhindert.
 */

function testUrl(): string | null {
  const explizit = process.env.TEST_DATABASE_URL;
  if (explizit) return explizit;

  const entwicklung = process.env.DATABASE_URL;
  if (!entwicklung) return null;

  // Dieselbe Ableitung wie in `scripts/setup-test-db.ts`: derselbe Server,
  // derselbe Benutzer, Name mit angehängtem `_test`.
  try {
    const url = new URL(entwicklung);
    const name = url.pathname.replace(/^\//, '');
    if (name.endsWith('_test')) return entwicklung;
    url.pathname = `/${name}_test`;
    return url.toString();
  } catch {
    return null;
  }
}

let client: PrismaClient | null = null;
let geprueft = false;
let grund: string | null = null;

/**
 * Der Zugang — oder `null`, wenn keine erkennbare Testdatenbank vorliegt.
 *
 * Aufrufer überspringen ihre Prüfung dann, statt zu scheitern: Ein Lauf ohne
 * Datenbankzugang ist eine unvollständige Prüfreihe, kein Produktfehler.
 */
export function testDb(): PrismaClient | null {
  if (geprueft) return client;
  geprueft = true;

  const url = testUrl();
  if (!url) {
    grund = 'Weder TEST_DATABASE_URL noch DATABASE_URL gesetzt.';
    return null;
  }

  const name = databaseNameOf(url);
  if (!istTestdatenbank(name)) {
    grund = `„${name}" sieht nicht nach einer Testdatenbank aus — kein Zugriff.`;
    return null;
  }

  client = erzeugePrismaClient({ url });
  return client;
}

/**
 * Die Adresse der Testdatenbank — mit derselben Namensprüfung wie `testDb()`,
 * sonst `null`. Für Prüfungen, die bewusst **am Prisma-Client vorbei** messen
 * (`datenbank-zeit.test.ts`): Was der Client falsch schreibt, liest er oft
 * genauso falsch zurück.
 */
export function testDbAdresse(): string | null {
  const url = testUrl();
  return url && istTestdatenbank(databaseNameOf(url)) ? url : null;
}

export function testDbGrund(): string {
  return grund ?? 'unbekannt';
}

export async function testDbSchliessen(): Promise<void> {
  if (client) await client.$disconnect();
}

/**
 * Aufräumen an den Unveränderlichkeitstriggern vorbei — **nur** in der
 * Testdatenbank, **nur** zum Entfernen von Prüfbestand.
 *
 * Veröffentlichte Lohnabrechnungen, abgeschlossene Lohnausweise und benutzte
 * Satzversionen verweigert die Datenbank zu Recht jede Änderung und
 * Löschung (Migration `20260923130000_lohn_ausbau`). Eine Prüfung, die eine
 * solche Abrechnung erzeugt, soll den Bestand trotzdem nicht Lauf für Lauf
 * wachsen lassen.
 *
 * `SET LOCAL session_replication_role = 'replica'` schaltet Trigger für genau
 * diese eine Transaktion ab und verlangt eine privilegierte Datenbankrolle —
 * die Testdatenbank läuft lokal und in der CI unter einer solchen. Die
 * Anwendung tut das nie; der Name `testDb()` davor ist die Sperre, dass es
 * nie gegen eine andere Datenbank läuft.
 */
type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

export const FREMDE_ORGANISATION_SLUG = 'pruef-fremde-organisation';

/**
 * Die Organisation, die die Anwendung auflöst — über denselben Slug wie
 * `getOrganizationId()`, nie über „die erste".
 *
 * `findFirst()` ohne Bedingung war richtig, solange es nur eine Organisation
 * gab. Mit der fremden Prüforganisation (`fremdeOrganisation`) traf es die
 * falsche — genau der Fehler, den die fremde Organisation sichtbar machen
 * soll, nur diesmal in der Prüfreihe selbst.
 */
export async function eigeneOrganisationId(): Promise<string | null> {
  const db = testDb();
  if (!db) return null;
  const org = await db.organization.findUnique({
    where: { slug: process.env.ORGANIZATION_SLUG ?? 'clenaris' },
    select: { id: true },
  });
  return org?.id ?? null;
}

/**
 * Eine zweite Organisation in der Testdatenbank — das Gegenüber, an dem sich
 * Mandantentrennung überhaupt erst zeigen lässt.
 *
 * Clenaris ist einmandantig betrieben, aber mehrmandantig modelliert: Jede
 * Abfrage soll nach `organizationId` filtern. Mit nur einer Organisation im
 * Bestand ist ein fehlender Filter unsichtbar — jede Zeile gehört ja „uns".
 * Legt eine Prüfung Daten unter dieser fremden Organisation an und die
 * Anwendung zeigt oder verrechnet sie, fehlt der Filter.
 *
 * Idempotent (`upsert` auf den Slug); die Anwendung selbst findet diese
 * Organisation nie, weil `getOrganizationId()` einen festen Slug auflöst.
 */
export async function fremdeOrganisation(): Promise<string | null> {
  const db = testDb();
  if (!db) return null;
  const org = await db.organization.upsert({
    where: { slug: FREMDE_ORGANISATION_SLUG },
    create: {
      slug: FREMDE_ORGANISATION_SLUG,
      name: 'Fremde Prüforganisation',
      email: 'fremd@example.ch',
      street: 'Fremdweg',
      streetNo: '1',
      postalCode: '3000',
      city: 'Bern',
    },
    update: {},
    select: { id: true },
  });
  return org.id;
}

/**
 * Veröffentlichte Abrechnungen samt allem, was an ihnen hängt, entfernen.
 *
 * **Warum jede Tabelle einzeln.** Unter `session_replication_role = 'replica'`
 * feuern auch die Fremdschlüssel-Trigger nicht — `ON DELETE CASCADE` greift
 * dann nicht, und die Zeilen einer gelöschten Abrechnung blieben verwaist
 * zurück. Deshalb: Zeilen, Positionsverknüpfung, PDF-Registrierung und
 * Ablage ausdrücklich, dann die Abrechnung.
 */
export async function lohnBelegeEntfernen(tx: Tx, payslipIds: string[]): Promise<void> {
  const ids = payslipIds.filter(Boolean);
  if (ids.length === 0) return;
  const abrechnungen = await tx.payslip.findMany({ where: { id: { in: ids } }, select: { pdfFileId: true } });
  const assetIds = abrechnungen.map((a) => a.pdfFileId).filter((x): x is string => Boolean(x));
  const assets = await tx.fileAsset.findMany({ where: { id: { in: assetIds } }, select: { storedFileId: true } });
  await tx.payslipLine.deleteMany({ where: { payslipId: { in: ids } } });
  await tx.payrollItem.deleteMany({ where: { payslipId: { in: ids } } });
  await tx.fileAsset.deleteMany({ where: { id: { in: assetIds } } });
  const stored = assets.map((a) => a.storedFileId).filter((x): x is string => Boolean(x));
  if (stored.length > 0) await tx.storedFile.deleteMany({ where: { id: { in: stored } } });
  await tx.payslip.deleteMany({ where: { id: { in: ids } } });
}

export async function schutzfreiAufraeumen(
  aufraeumen: (tx: Tx) => Promise<unknown>,
): Promise<void> {
  const db = testDb();
  if (!db) return;
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    await aufraeumen(tx);
  });
}
