import { defineRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { kennzahlen } from '@/lib/observability/metrics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/metrics — was dieser Prozess gerade gesehen hat.
 *
 * ---------------------------------------------------------------------------
 *  Warum angemeldet und nicht offen
 * ---------------------------------------------------------------------------
 *
 * Die übliche Bauart eines Kennzahlenendpunkts ist: offen, dafür nur im
 * internen Netz erreichbar. Das setzt ein internes Netz voraus, und in dieser
 * Betriebsform gibt es keines — die Anwendung liegt hinter einem Reverse
 * Proxy am offenen Internet.
 *
 * Offen wäre er eine Auskunft über den Betrieb: wie viele Anfragen, welche
 * Endpunkte, wie viele Fehler, wie lange dauert was. Das ist harmlos klingende
 * Aufklärung mit konkretem Nutzen für jemanden, der einen Angriff plant — er
 * sieht in Echtzeit, ob er auffällt.
 *
 * Deshalb `security:read`, dieselbe Berechtigung wie für das
 * Sicherheitszentrum und mit derselben Begründung: Wer den Betrieb beobachten
 * darf, ist die Systemverantwortung.
 *
 * ---------------------------------------------------------------------------
 *  Was die Antwort nicht enthält
 * ---------------------------------------------------------------------------
 *
 * Keine Pfade mit Datensatzkennungen — die Reihen laufen über **Vorlagen**
 * (`/api/jobs/:id`). Keine Benutzer, keine Adressen, keine Nutzlasten. Eine
 * Kennzahl beantwortet „wie oft und wie lange", nie „von wem".
 *
 * ---------------------------------------------------------------------------
 *  Die Grenzen stehen in der Antwort
 * ---------------------------------------------------------------------------
 *
 * `prozessId` und `prozessStartzeit` sind nicht Beiwerk: Die Zahlen gelten je
 * Prozess und überleben keinen Neustart. Wer zwei Antworten vergleicht, soll
 * an diesen beiden Feldern sehen, ob sie überhaupt vergleichbar sind — statt
 * einen Rückgang zu deuten, der nur eine Auslieferung war.
 */
export const GET = defineRoute({
  permissions: ['security:read'],
  rateLimit: 'apiRead',
  handler: async () =>
    ok(kennzahlen(), {
      // Zwischengespeicherte Kennzahlen sind keine Kennzahlen.
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    }),
});
