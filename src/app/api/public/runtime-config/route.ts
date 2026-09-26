import { definePublicRoute } from '@/lib/api/handler';
import { ok } from '@/lib/api/response';
import { oeffentlicheKonfiguration } from '@/lib/laufzeit-konfiguration';

export const runtime = 'nodejs';
// Nie beim Bau vorrendern: Die Antwort ist die Konfiguration *dieser*
// Umgebung, nicht die der Maschine, auf der gebaut wurde (V2-1).
export const dynamic = 'force-dynamic';

/**
 * GET /api/public/runtime-config — was der Browser über diese Umgebung
 * wissen darf, und nichts sonst.
 *
 * Die Felder stehen einzeln in `PublicRuntimeConfigSchema`
 * (`src/lib/laufzeit-konfiguration.ts`); weder `process.env` noch ein Teil
 * davon wird durchgereicht. Nichts aus der Anfrage fliesst ein — weder Host
 * noch Abfrage noch Kopfzeilen: Die Antwort beschreibt die Server-Umgebung,
 * und nur die Server-Umgebung bestimmt sie.
 *
 * **Zwischenspeicher.** `no-cache`: Browser und Proxys dürfen die Antwort
 * halten, müssen aber vor jeder Verwendung nachfragen. Die Antwort ist klein,
 * und eine geänderte Konfiguration soll nicht erst nach Ablauf einer Frist
 * ankommen. Verschiedene Umgebungen haben verschiedene Hosts und damit
 * verschiedene Einträge in jedem Zwischenspeicher — eine Vermischung über
 * den Speicher ist ausgeschlossen, solange keine zwei Umgebungen denselben
 * Host teilen.
 */
export const GET = definePublicRoute({
  rateLimit: 'apiRead',
  handler: async () => ok(oeffentlicheKonfiguration(), { headers: { 'Cache-Control': 'no-cache' } }),
});
