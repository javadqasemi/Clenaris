import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import pg from 'pg';

import { erzeugePrismaClient } from '../../src/lib/prisma-client';
import { data, post, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { testDb, testDbAdresse, testDbGrund } from '../helpers/testdb';

/**
 * Zeitpunkte landen richtig in der Datenbank (seit Prisma 7, 2026-09-29).
 *
 * Der Treiberadapter von Prisma 7 schreibt Zeitpunkte als UTC-Ziffern ohne
 * Versatz und setzt beim Lesen jeden Versatz auf `+00:00` — er verlangt eine
 * Sitzung in UTC. Der Datenbankserver dieser Umgebung steht auf
 * `Europe/Berlin`. Ohne `TimeZone=UTC` in `src/lib/prisma-client.ts` lag
 * jeder geschriebene Zeitpunkt zwei Stunden zu früh in der Datenbank; in
 * JavaScript fiel das nicht auf, weil der Adapter beim Lesen denselben Fehler
 * zurückrechnete. Aufgefallen ist es an einem Trigger, der nur in der
 * Datenbank vergleicht: Sofort ausgestellte Rechnungen scheiterten mit
 * „Die Positionen einer ausgestellten Rechnung sind unveränderlich".
 *
 * Deshalb misst der erste Fall **am Prisma-Client vorbei**, mit `pg`
 * unmittelbar und in der Datenbank selbst (`now() - "createdAt"`) — was der
 * Client falsch schreibt, liest er genauso falsch zurück. Der zweite Fall
 * prüft die Ursache auch dort, wo der Datenbankserver ohnehin in UTC läuft
 * (CI) und der erste deshalb nichts sehen könnte.
 */

let jars: Record<AccountName, string>;
const SKU = `PRUEF-ZEIT-${Date.now()}`;

async function aufraeumen() {
  await testDb()?.material.deleteMany({ where: { sku: SKU } });
}

describe('Zeitpunkte in der Datenbank', () => {
  before(async () => {
    await requireServer();
    jars = await loginAll();
    await aufraeumen();
  });
  after(aufraeumen);

  it('ein soeben über die Anwendung geschriebener Zeitpunkt ist in der Datenbank Sekunden alt, nicht Stunden', async () => {
    const adresse = testDbAdresse();
    assert.ok(adresse, `kein Zugang zur Testdatenbank: ${testDbGrund()}`);

    const angelegt = await post<{ data: { id: string } }>('/api/materials', { sku: SKU, name: 'Prüfreihe Zeitpunkt', unit: 'l' }, { jar: jars.admin });
    assert.equal(angelegt.status, 201, JSON.stringify(angelegt.payload));

    const roh = new pg.Client({ connectionString: adresse });
    await roh.connect();
    try {
      const zeile = await roh.query<{ alter: number; sitzung: string }>(
        `SELECT EXTRACT(EPOCH FROM now() - "createdAt")::float AS alter, current_setting('TimeZone') AS sitzung FROM materials WHERE id = $1`,
        [data(angelegt).id],
      );
      assert.equal(zeile.rowCount, 1);
      const { alter, sitzung } = zeile.rows[0]!;
      assert.ok(
        alter > -5 && alter < 120,
        `„createdAt" liegt ${Math.round(alter)} s vor now() (Serverzeitzone ${sitzung}) — erwartet: Sekunden`,
      );
    } finally {
      await roh.end();
    }
  });

  it('jeder Prisma-Client der Anwendung arbeitet in einer UTC-Sitzung', async () => {
    const adresse = testDbAdresse();
    assert.ok(adresse, `kein Zugang zur Testdatenbank: ${testDbGrund()}`);
    const client = erzeugePrismaClient({ url: adresse });
    try {
      const [zeile] = await client.$queryRawUnsafe<{ TimeZone: string }[]>('SHOW TimeZone');
      assert.equal(zeile?.TimeZone, 'UTC');
    } finally {
      await client.$disconnect();
    }
  });
});
