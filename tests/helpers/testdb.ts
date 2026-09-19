/**
 * Die Regel „nimm die geteilte Instanz aus `@/lib/db`" gilt für die
 * Anwendung: Dort erschöpfte eine zweite Instanz im serverlosen Betrieb den
 * Verbindungspool. Diese Datei läuft im Prüfprozess, nicht im Server, und
 * muss ausdrücklich auf eine *andere* Adresse zeigen als `@/lib/db` — genau
 * darin besteht ihr Schutz. Die geteilte Instanz zu nehmen hiesse, gegen die
 * Entwicklungsdatenbank zu lesen.
 */
// eslint-disable-next-line no-restricted-imports
import { PrismaClient } from '@prisma/client';

import { databaseNameOf, istTestdatenbank } from '../../prisma/seed-guard';

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
 * Geschrieben wird hier nichts. Die Anwendung bleibt die einzige Stelle, die
 * Daten verändert.
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

  client = new PrismaClient({ datasources: { db: { url } } });
  return client;
}

export function testDbGrund(): string {
  return grund ?? 'unbekannt';
}

export async function testDbSchliessen(): Promise<void> {
  if (client) await client.$disconnect();
}
