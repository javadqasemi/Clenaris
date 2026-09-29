import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma-Konfiguration (seit Prisma 7, 2026-09-29).
 *
 * Bis Prisma 6 standen Verbindung und Seed an zwei anderen Stellen:
 * `url`/`directUrl` im `datasource`-Block von `schema.prisma` und
 * `prisma.seed` in `package.json`. Prisma 7 liest beides nur noch hier, und
 * die Kommandozeile lädt `.env` nicht mehr selbst — deshalb `dotenv/config`
 * ganz oben.
 *
 * **Welche Adresse die Kommandozeile bekommt.** Migrationen liefen bisher über
 * `DIRECT_URL` (am Pooler vorbei: PgBouncer im Transaktionsmodus verträgt die
 * Sperren von `migrate` nicht), alles andere über `DATABASE_URL`. Die
 * Kommandozeile braucht nur noch eine Adresse, und für sie gilt dieselbe
 * Überlegung wie vorher für Migrationen: `DIRECT_URL`, sonst `DATABASE_URL`.
 * Wo beide gleich sind (örtlich, Prüfreihe, `verify`), ändert sich nichts.
 *
 * **Ohne Adresse kein Fehler.** `prisma generate` braucht keine Datenbank und
 * läuft in CI und im Bau ohne Umgebung; `env()` aus `prisma/config` würfe
 * dann. Fehlt die Adresse bei `migrate`, meldet Prisma das selbst.
 *
 * Die Laufzeit liest diese Datei nicht: Der Client verbindet sich über den
 * Treiberadapter in `src/lib/prisma-client.ts`.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DIRECT_URL || process.env.DATABASE_URL || undefined,
  },
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
});
