import { defineCronRoute } from '@/lib/api/handler';
import { cleanupExpiredTokens } from '@/server/services/auth.service';
import { generateRecurringBookings } from '@/server/services/booking.service';
import { processOverdueInvoices } from '@/server/services/invoice.service';
import { processExpiringQuotes } from '@/server/services/quote.service';
import { getOrganizationId } from '@/server/services/organization.service';
import {
  createFollowUpTasks,
  requestReviews,
  sendBirthdayGreetings,
  sendTaskReminders,
} from '@/server/services/automation.service';
import { runFuehrungNightly } from '@/server/services/fuehrung.service';
import { runSignatureNightly } from '@/server/services/signature.service';
import { runScanNachlauf } from '@/server/services/file.service';
import { runDueAutomations } from '@/server/services/automation-engine.service';
import { runContractScheduling } from '@/server/services/contract-schedule.service';
import { mitUeberwachung } from '@/server/services/cron-monitor.service';
import { purgeTrafficEvents } from '@/server/services/traffic.service';
import { purgeExpiredUploads } from '@/lib/storage';
import { logger } from '@/lib/logger';

const log = logger('cron/daily');

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/daily — einmal täglich um 06:00 Uhr (siehe vercel.json).
 *
 * Architekturentscheid: Ein Endpunkt für alle Tagesaufgaben statt sechs
 * einzelner Cron-Einträge. Die Aufgaben sind kurz, laufen **nebeneinander**
 * (`Promise.allSettled`; bis 2026-09-23 stand hier fälschlich „sequenziell")
 * und teilen sich denselben Kontext; ein einziger Lauf ist einfacher zu
 * überwachen und günstiger.
 *
 * Jede Teilaufgabe ist gekapselt: schlägt eine fehl, laufen die übrigen
 * trotzdem. Das Ergebnis meldet, was gelungen ist und was nicht — und seit
 * RB-014 auch der Statuscode: 500, sobald eine Teilaufgabe gescheitert ist,
 * dazu ein `CronRun` mit Dauer und Zusammenfassung.
 */
export const GET = defineCronRoute({
  handler: async () => {
    const organizationId = await getOrganizationId();
    const startedAt = Date.now();

    /**
     * Aufgabe und Bezeichnung stehen **zusammen** in einem Eintrag.
     *
     * Vorher waren es zwei Listen — ein Feld mit Versprechen und eines mit
     * Bezeichnungen —, die über den Index zusammenfanden. Sie waren
     * auseinandergelaufen: elf Läufe, zehn Bezeichnungen. Der letzte
     * (`runSignatureNightly`) landete damit unter dem Schlüssel `undefined`,
     * und wäre er gescheitert, hätte die Antwort eine fehlgeschlagene Aufgabe
     * namens „undefined" gemeldet.
     *
     * Der Fehler war unsichtbar, weil er nichts kaputtmacht — er nimmt nur
     * die Auskunft weg, und zwar ausgerechnet über den Lauf, der Vorgänge
     * abschliesst. Mit einem Eintrag je Aufgabe kann das nicht mehr
     * auseinanderlaufen.
     */
    const aufgaben: { name: string; lauf: () => Promise<unknown> }[] = [
      { name: 'recurringBookings', lauf: () => generateRecurringBookings(organizationId) },
      { name: 'overdueInvoices', lauf: () => processOverdueInvoices(organizationId) },
      { name: 'expiringQuotes', lauf: () => processExpiringQuotes(organizationId) },
      { name: 'reviewRequests', lauf: () => requestReviews(organizationId) },
      { name: 'birthdays', lauf: () => sendBirthdayGreetings(organizationId) },
      { name: 'followUpTasks', lauf: () => createFollowUpTasks(organizationId) },
      { name: 'taskReminders', lauf: () => sendTaskReminders() },
      { name: 'tokenCleanup', lauf: () => cleanupExpiredTokens() },
      // Angeforderte, aber nie beschriebene Upload-Adressen. Sie entstehen bei
      // jedem abgebrochenen Upload und wären sonst Zeilen, die niemand je
      // wieder anfasst.
      { name: 'uploadCleanup', lauf: () => purgeExpiredUploads() },
      // Unternehmensführung: Kennzahl-Snapshots, Gesundheitswert, fällige
      // Prüfungen, ablaufende Dokumente, fällige Berichte — in dieser
      // Reihenfolge, weil die Berichte die frischen Snapshots brauchen.
      { name: 'fuehrung', lauf: () => runFuehrungNightly(organizationId) },
      // Unterzeichnung: abgelaufene Vorgänge schliessen, hängengebliebene
      // Abschlüsse nachholen, verbrauchte Codes bereinigen.
      { name: 'signatur', lauf: () => runSignatureNightly(organizationId) },
      /**
       * Dateien, die keinen Befund haben — Altbestand aus der Zeit vor der
       * Schadsoftwareprüfung und Fälle, bei denen der Prüfer beim Abschluss
       * nicht erreichbar war. Sie sind gesperrt, bis ein Lauf sie freigibt;
       * ohne diesen Lauf blieben sie es für immer, und der Nachlauf von Hand
       * (`scripts/scan-backfill.ts`) wäre die einzige Abhilfe.
       */
      { name: 'dateipruefung', lauf: () => runScanNachlauf(organizationId) },
      /**
       * Fällige Automatisierungen — auch hier, nicht nur stündlich. Läuft der
       * stündliche Takt aus irgendeinem Grund nicht, holt der nächtliche auf,
       * statt dass ein Rückstau bis zum nächsten Eingriff liegen bleibt.
       */
      { name: 'automatisierungen', lauf: () => runDueAutomations({ organizationId, limit: 500 }) },
      /**
       * Serienplanung der Verträge — Einsätze für die nächsten sechzig Tage.
       *
       * Der Lauf ist idempotent bis in die Datenbank hinein
       * (`jobs_serientermin_einmal`), also unbedenklich, wenn er zweimal
       * läuft oder nach einem Abbruch wiederholt wird. Er setzt auch Verträge
       * fort, deren vereinbarte Pause abgelaufen ist.
       * Umgekehrt ist er die einzige Stelle, an der die Einsätze eines
       * laufenden Vertrags von selbst entstehen: Ohne ihn stünde ein Vertrag
       * aktiv in der Liste, und niemand käme putzen.
       *
       * Ein Fehler an einem einzelnen Vertrag beendet den Lauf nicht — er
       * wird gezählt und protokolliert, und die übrigen Verträge werden
       * trotzdem geplant.
       */
      { name: 'vertragsplanung', lauf: () => runContractScheduling(organizationId) },
      /**
       * Besuchsmessung: Ereignisse älter als 13 Monate löschen.
       *
       * Die Frist steht in der Datenschutzerklärung; ohne diesen Lauf wäre
       * sie ein Versprechen, das niemand einlöst. Idempotent — ein zweiter
       * Lauf am selben Tag findet nichts mehr.
       */
      { name: 'besuchsmessung', lauf: () => purgeTrafficEvents(organizationId) },
    ];

    const ergebnis = await mitUeberwachung({ organizationId, job: 'daily', aufgaben });

    log.info('Lauf abgeschlossen', {
      durationMs: Date.now() - startedAt,
      failures: ergebnis.failed,
    });

    return Response.json(
      {
        ok: ergebnis.status === 'SUCCESS',
        runId: ergebnis.runId,
        status: ergebnis.status,
        durationMs: ergebnis.durationMs,
        failures: ergebnis.fehlgeschlagen,
        summary: ergebnis.zusammenfassung,
      },
      { status: ergebnis.status === 'SUCCESS' ? 200 : 500 },
    );
  },
});
