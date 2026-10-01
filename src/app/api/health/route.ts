import { definePublicRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { laufendeIdentitaet } from '@/lib/release/identitaet';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = logger('health');

/**
 * GET /api/health — Betriebsbereitschaft.
 *
 * Wofür: Der Health Check nach jeder Auslieferung, die Überwachung und der
 * vorgelagerte Load Balancer. Die Frage, die er beantwortet, ist nicht «läuft
 * der Node-Prozess» — das sähe man auch an einer beliebigen Seite —, sondern
 * «kann diese Instanz Anfragen *bedienen*». Der Unterschied ist die Datenbank:
 * Ein Prozess mit unerreichbarer Datenbank antwortet auf jeder Seite mit 500
 * und muss aus der Auslieferung genommen werden. Deshalb gehört die
 * Datenbankprüfung hierher, und deshalb ist die Antwort bei einem Fehler 503
 * und nicht 200 mit einem Feld `status: "fehler"`. Ein Health Check, dessen
 * Aussage im Rumpf statt im Statuscode steht, wird von jedem Load Balancer
 * und jedem `curl -f` falsch gelesen.
 *
 * `SELECT 1` statt einer echten Abfrage: Der Zweck ist, Verbindung und Pool zu
 * prüfen, nicht die Daten. Eine Zählung auf einer wachsenden Tabelle würde den
 * Check mit den Jahren langsamer machen, bis er selbst zum Ausfallgrund wird.
 *
 * Die Zahl der angewandten Migrationen beweist, dass das Schema zur
 * ausgelieferten Fassung passt: Nach `prisma migrate deploy` steigt sie, und
 * eine Instanz, die nach der Auslieferung eine kleinere Zahl meldet, läuft
 * gegen eine andere Datenbank als angenommen.
 *
 * **Welcher Stand läuft — belegt, nicht behauptet** (seit 2026-09-30). Bis
 * dahin stand hier als `version` der Wert von `APP_VERSION`, den pm2 beim
 * Umschalten setzte; ein Verzeichnis A, gestartet mit `APP_VERSION=<B>`,
 * meldete sich als B, und die Aktivierung hielt das für den Beweis, dass B
 * läuft. Jetzt kommen die Angaben aus der Identität der Instanz
 * (`release/identitaet.ts`: `RELEASE.json` und `BUILD_ID` im Verzeichnis des
 * Prozesses):
 *
 *  - `version`: der Commit (40 Hexzeichen) — **nur**, wenn die Identität
 *    belegt ist, sonst `null`. Der Name bleibt, weil Aktivierung und
 *    Überwachung genau dieses Feld mit dem Commit des Artefakts vergleichen;
 *    was sich ändert, ist, dass er nicht mehr erfunden werden kann.
 *  - `buildId`: die `BUILD_ID` des Baus, aus dem die Instanz ausliefert —
 *    in jedem Zustand, sofern lesbar. Die Aktivierung vergleicht sie mit der
 *    Build-ID im Manifest des Archivs, das sie gerade eingeschaltet hat.
 *  - `release`: die semantische Version, nur wenn belegt.
 *  - `identitaet`: `belegt`, `ohne-manifest`, `widerspruechlich` oder
 *    `ungueltig`. Gesund im Sinn der Aktivierung ist eine neue Fassung erst,
 *    wenn hier `belegt` steht **und** Commit und Build-ID stimmen.
 *
 * Der Statuscode hängt bewusst **nicht** an der Identität: Er beantwortet
 * „kann diese Instanz Anfragen bedienen", und das kann ein Entwicklungs-
 * oder Prüfserver ohne Manifest sehr wohl. Welche Fassung bedient, ist eine
 * zweite Frage mit eigenem Feld. Der Grund einer fehlenden Belegung geht
 * nicht hinaus — er nennt Dateien und Bauverzeichnisse, und der Endpunkt ist
 * unangemeldet; die Sicherheitszentrale zeigt ihn der Systemverantwortung.
 *
 * Kein Rate-Limit-Ausschluss: 300 Anfragen pro Minute reichen für jede
 * Überwachung (das sind fünf pro Sekunde), decken die Prüfschleife der
 * Auslieferung ab und begrenzen trotzdem, was ein Fremder über diesen
 * unangemeldeten Endpunkt an Datenbankverbindungen auslösen kann.
 */
export const GET = definePublicRoute({
  rateLimit: 'apiRead',
  handler: async () => {
    const startedAt = Date.now();

    let databaseOk = false;
    let migrations: number | null = null;

    try {
      await prisma.$queryRaw`SELECT 1`;
      databaseOk = true;

      const rows = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count
        FROM "_prisma_migrations"
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      `;
      migrations = Number(rows[0]?.count ?? 0);
    } catch (error) {
      // Der Grund gehört ins Protokoll, nicht in die Antwort: Der Endpunkt ist
      // unangemeldet erreichbar, und eine Postgres-Fehlermeldung nennt Host,
      // Benutzer und Datenbanknamen.
      log.error('Health Check fehlgeschlagen', { error });
    }

    const identitaet = laufendeIdentitaet();
    const body = {
      status: databaseOk ? ('ok' as const) : ('fehler' as const),
      datenbank: databaseOk ? ('ok' as const) : ('nicht erreichbar' as const),
      migrationen: migrations,
      /** Der belegte Commit — beantwortet «welcher Stand läuft gerade?». Unbelegt: `null`. */
      version: identitaet.belegt ? identitaet.commit : null,
      buildId: identitaet.buildId,
      release: identitaet.belegt ? identitaet.version : null,
      identitaet: identitaet.zustand,
      umgebung: process.env.NODE_ENV ?? 'unbekannt',
      laufzeitSekunden: Math.round(process.uptime()),
      dauerMs: Date.now() - startedAt,
      zeit: new Date().toISOString(),
    };

    return ok(body, {
      status: databaseOk ? 200 : 503,
      // Ein zwischengespeicherter Health Check ist schlimmer als keiner: Er
      // meldet «gesund» weiter, während die Instanz längst steht.
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  },
});
