import 'server-only';

import type { CronRunStatus, Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { recordSecurityEvent } from '@/lib/security/record';
import type { SecurityEventKind } from '@/lib/security/events';
import { freitextSchwaerzen, wertSchwaerzen } from '@/lib/sensitive-fields';

import { notifyStaff } from './notification.service';

const log = logger('cron');

/**
 * Überwachung der geplanten Läufe (RB-014).
 *
 * ---------------------------------------------------------------------------
 *  Der Befund
 * ---------------------------------------------------------------------------
 *
 * `/api/cron/hourly` und `/api/cron/daily` antworteten mit 200, auch wenn jede
 * Teilaufgabe gescheitert war; ein `curl -f` in der Crontab schlug nie an.
 * Ob ein Lauf überhaupt stattfand, stand nirgends ausser in einer Logzeile.
 * Auf diesen Läufen hängen der Abschluss von Signaturvorgängen, die
 * Nachprüfung von Dateien, die Serienplanung der Verträge und die
 * Automatisierungen — fällt einer aus, merkt es niemand.
 *
 * ---------------------------------------------------------------------------
 *  Was hier entsteht
 * ---------------------------------------------------------------------------
 *
 *  • **Ein Protokoll je Lauf** (`CronRun`): Beginn, Ende, Dauer, gelungene
 *    und gescheiterte Teilaufgaben, eine Zusammenfassung je Teilaufgabe.
 *  • **Ein Zustand je Auftrag** (`cronZustand`): letzter Erfolg, letzter
 *    Fehler, Dauer, nächster erwarteter Lauf, Fehler in Folge, überfällig.
 *  • **Alarme** über das Sicherheitsprotokoll, eine Benachrichtigung an die
 *    Personen mit `security:read` und — falls eingerichtet — einen Webhook
 *    (`ALERT_WEBHOOK_URL`). Ausgelöst bei Fehlern, bei drei Fehlern in Folge,
 *    bei einem Lauf nahe an seiner Zeitgrenze und bei einem ausgebliebenen
 *    Lauf.
 *
 * **Ausgebliebene Läufe** lassen sich von innen nur halb erkennen: Der
 * stündliche Lauf prüft den täglichen und umgekehrt. Bleiben **beide** aus,
 * meldet niemand etwas — dafür gibt es `/api/cron/status` (mit
 * `CRON_SECRET`), das ein Überwachungsdienst von aussen abfragt und das mit
 * 503 antwortet, sobald ein Auftrag überfällig ist oder wiederholt scheitert.
 * Welcher Dienst das ist, ist eine Betriebsentscheidung (`docs/OBSERVABILITY.md`).
 *
 * **Keine Geheimnisse, keine Personendaten** in Protokoll und Alarm: Die
 * Zusammenfassungen laufen durch `wertSchwaerzen`, Fehlermeldungen durch
 * `freitextSchwaerzen` und werden gekürzt. Der Webhook bekommt Art, Auftrag,
 * Zeitpunkt und Zahlen — keine Rohdaten.
 */

export interface CronPlan {
  /** Erwarteter Abstand zwischen zwei Läufen. */
  intervallMinuten: number;
  /** `maxDuration` der Route in Millisekunden. */
  zeitgrenzeMs: number;
  /** Ab wann ein Lauf als ausgeblieben gilt. */
  ueberfaelligNachMinuten: number;
}

export const CRON_PLAENE: Readonly<Record<string, CronPlan>> = {
  hourly: { intervallMinuten: 60, zeitgrenzeMs: 120_000, ueberfaelligNachMinuten: 150 },
  daily: { intervallMinuten: 24 * 60, zeitgrenzeMs: 300_000, ueberfaelligNachMinuten: 26 * 60 },
};

/** Ab so vielen Fehlern in Folge wird aus einer Warnung ein Alarm. */
export const FEHLER_IN_FOLGE_ALARM = 3;

export interface Teilaufgabe {
  name: string;
  lauf: () => Promise<unknown>;
}

export interface CronErgebnis {
  runId: string;
  status: CronRunStatus;
  durationMs: number;
  processed: number;
  failed: number;
  fehlgeschlagen: string[];
  zusammenfassung: Record<string, unknown>;
}

/**
 * Einen Auftrag mit Protokoll ausführen.
 *
 * Die Teilaufgaben laufen nebeneinander (`Promise.allSettled`) — eine, die
 * scheitert, hält die anderen nicht auf. Das Protokoll entsteht **vor** dem
 * ersten Schritt, damit auch ein Lauf, der mittendrin abbricht, als RUNNING
 * sichtbar bleibt und nicht verschwindet.
 */
export async function mitUeberwachung(params: {
  organizationId: string;
  job: string;
  aufgaben: Teilaufgabe[];
}): Promise<CronErgebnis> {
  const plan = CRON_PLAENE[params.job];
  const beginn = Date.now();
  const lauf = await prisma.cronRun.create({
    data: { organizationId: params.organizationId, job: params.job, status: 'RUNNING' },
    select: { id: true },
  });

  const ergebnisse = await Promise.allSettled(params.aufgaben.map((a) => a.lauf()));
  const zusammenfassung: Record<string, unknown> = {};
  const fehlgeschlagen: string[] = [];

  ergebnisse.forEach((ergebnis, index) => {
    const name = params.aufgaben[index]!.name;
    if (ergebnis.status === 'fulfilled') {
      zusammenfassung[name] = wertSchwaerzen(ergebnis.value ?? null);
    } else {
      fehlgeschlagen.push(name);
      zusammenfassung[name] = { fehler: kurzeMeldung(ergebnis.reason) };
      log.error('Teilaufgabe fehlgeschlagen', { job: params.job, task: name, error: ergebnis.reason });
    }
  });

  const durationMs = Date.now() - beginn;
  const processed = params.aufgaben.length - fehlgeschlagen.length;
  const status: CronRunStatus =
    fehlgeschlagen.length === 0 ? 'SUCCESS' : processed === 0 ? 'FAILED' : 'PARTIAL';

  await prisma.cronRun.update({
    where: { id: lauf.id },
    data: {
      status,
      finishedAt: new Date(),
      durationMs,
      processed,
      failed: fehlgeschlagen.length,
      details: zusammenfassung as Prisma.InputJsonValue,
      error: fehlgeschlagen.length > 0 ? `Gescheitert: ${fehlgeschlagen.join(', ')}` : null,
    },
  });

  try {
    await alarmeNachLauf({ organizationId: params.organizationId, job: params.job, status, durationMs, fehlgeschlagen, plan });
  } catch (fehler) {
    // Ein Alarm, der scheitert, darf den Lauf nicht nachträglich rot machen.
    log.error('Alarmprüfung nach dem Lauf gescheitert', { job: params.job, error: fehler });
  }

  return { runId: lauf.id, status, durationMs, processed, failed: fehlgeschlagen.length, fehlgeschlagen, zusammenfassung };
}

function kurzeMeldung(grund: unknown): string {
  const text = grund instanceof Error ? grund.message : String(grund);
  return freitextSchwaerzen(text).slice(0, 300);
}

async function alarmeNachLauf(params: {
  organizationId: string;
  job: string;
  status: CronRunStatus;
  durationMs: number;
  fehlgeschlagen: string[];
  plan?: CronPlan;
}): Promise<void> {
  if (params.status !== 'SUCCESS') {
    const zuletzt = await prisma.cronRun.findMany({
      where: { organizationId: params.organizationId, job: params.job, status: { not: 'RUNNING' } },
      orderBy: { startedAt: 'desc' },
      take: FEHLER_IN_FOLGE_ALARM,
      select: { status: true },
    });
    const inFolge = zuletzt.length === FEHLER_IN_FOLGE_ALARM && zuletzt.every((r) => r.status !== 'SUCCESS');
    await alarmieren({
      organizationId: params.organizationId,
      art: inFolge ? 'CRON_FAILED_REPEATEDLY' : 'CRON_FAILED',
      job: params.job,
      zusammenfassung: inFolge
        ? `Auftrag „${params.job}" scheitert zum ${FEHLER_IN_FOLGE_ALARM}. Mal in Folge (${params.fehlgeschlagen.join(', ')})`
        : `Auftrag „${params.job}": ${params.fehlgeschlagen.length} Teilaufgabe(n) gescheitert (${params.fehlgeschlagen.join(', ')})`,
      kontext: { status: params.status, fehlgeschlagen: params.fehlgeschlagen },
      benachrichtigen: inFolge,
    });
  }

  if (params.plan && params.durationMs > params.plan.zeitgrenzeMs * 0.8) {
    await alarmieren({
      organizationId: params.organizationId,
      art: 'CRON_SLOW',
      job: params.job,
      zusammenfassung: `Auftrag „${params.job}" brauchte ${Math.round(params.durationMs / 1000)} s von höchstens ${Math.round(params.plan.zeitgrenzeMs / 1000)} s`,
      kontext: { durationMs: params.durationMs, zeitgrenzeMs: params.plan.zeitgrenzeMs },
      benachrichtigen: false,
    });
  }

  // Der jeweils andere Auftrag: ausgeblieben?
  for (const [anderer] of Object.entries(CRON_PLAENE)) {
    if (anderer === params.job) continue;
    await pruefeAusgeblieben(params.organizationId, anderer);
  }
}

/**
 * Ist ein Auftrag ausgeblieben? Alarm höchstens einmal je Überfälligkeit —
 * sonst meldete jeder stündliche Lauf denselben ausgebliebenen Nachtlauf.
 */
export async function pruefeAusgeblieben(organizationId: string, job: string, jetzt = new Date()): Promise<boolean> {
  const plan = CRON_PLAENE[job];
  if (!plan) return false;
  const letzter = await prisma.cronRun.findFirst({
    where: { organizationId, job },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true },
  });
  // Noch nie gelaufen: Nach einer frischen Einrichtung ist das kein Alarm,
  // sondern der Normalfall bis zum ersten Lauf.
  if (!letzter) return false;
  const faellig = letzter.startedAt.getTime() + plan.ueberfaelligNachMinuten * 60_000;
  if (jetzt.getTime() <= faellig) return false;

  const schonGemeldet = await prisma.securityEvent.count({
    where: {
      organizationId,
      kind: 'CRON_MISSED',
      occurredAt: { gt: letzter.startedAt },
      context: { path: ['job'], equals: job },
    },
  });
  if (schonGemeldet === 0) {
    await alarmieren({
      organizationId,
      art: 'CRON_MISSED',
      job,
      zusammenfassung: `Auftrag „${job}" ist ausgeblieben — letzter Lauf ${letzter.startedAt.toISOString()}`,
      kontext: { letzterLauf: letzter.startedAt.toISOString() },
      benachrichtigen: true,
    });
  }
  return true;
}

/**
 * Der Alarm-Haken: Sicherheitsprotokoll, Benachrichtigung, Webhook.
 *
 * Jeder Weg einzeln geschluckt: Ein Webhook, der nicht antwortet, darf die
 * Benachrichtigung nicht verhindern, und keiner der drei darf den Lauf
 * scheitern lassen.
 */
async function alarmieren(params: {
  organizationId: string;
  art: SecurityEventKind;
  job: string;
  zusammenfassung: string;
  kontext: Record<string, unknown>;
  benachrichtigen: boolean;
}): Promise<void> {
  await recordSecurityEvent({
    organizationId: params.organizationId,
    kind: params.art,
    summary: params.zusammenfassung,
    context: { job: params.job, ...params.kontext },
  });

  if (params.benachrichtigen) {
    await notifyStaff({
      organizationId: params.organizationId,
      title: 'Geplanter Lauf braucht Aufmerksamkeit',
      body: params.zusammenfassung,
      link: '/admin/sicherheit',
      permission: 'security:read',
    }).catch((fehler) => log.error('Benachrichtigung zum Alarm gescheitert', { error: fehler }));
  }

  await webhookSenden({
    art: params.art,
    job: params.job,
    zusammenfassung: params.zusammenfassung,
    zeitpunkt: new Date().toISOString(),
  });
}

/**
 * Optionaler Alarm-Webhook (`ALERT_WEBHOOK_URL`) — etwa ein Kanal im
 * Teamchat oder ein Bereitschaftsdienst.
 *
 * Nur HTTPS, fünf Sekunden Zeitgrenze, kein Folgen von Umleitungen. Der Rumpf
 * enthält Art, Auftrag, Satz und Zeitpunkt — nichts, was nicht auch in der
 * Übersicht des Sicherheitszentrums stünde.
 */
async function webhookSenden(nutzlast: { art: string; job: string; zusammenfassung: string; zeitpunkt: string }): Promise<void> {
  const url = process.env.ALERT_WEBHOOK_URL?.trim();
  if (!url) return;
  if (!url.startsWith('https://')) {
    log.warn('ALERT_WEBHOOK_URL ist nicht HTTPS — Alarm nicht gesendet');
    return;
  }
  try {
    const antwort = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quelle: 'clenaris', ...nutzlast }),
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
    });
    if (!antwort.ok) log.warn('Alarm-Webhook antwortete nicht mit Erfolg', { status: antwort.status });
  } catch (fehler) {
    log.warn('Alarm-Webhook nicht erreichbar', { error: fehler });
  }
}

export interface CronZustand {
  job: string;
  intervallMinuten: number;
  letzterLauf: Date | null;
  letzterStatus: CronRunStatus | null;
  letzterErfolg: Date | null;
  letzterFehler: Date | null;
  letzteDauerMs: number | null;
  verarbeitet: number | null;
  fehlgeschlagen: number | null;
  naechsterErwartet: Date | null;
  fehlerInFolge: number;
  ueberfaellig: boolean;
  /** Ein Lauf steht seit mehr als seiner Zeitgrenze auf RUNNING — abgebrochen. */
  haengt: boolean;
}

/** Der Zustand aller Aufträge — für das Sicherheitszentrum und `/api/cron/status`. */
export async function cronZustand(organizationId: string, jetzt = new Date()): Promise<CronZustand[]> {
  const zustaende: CronZustand[] = [];
  for (const [job, plan] of Object.entries(CRON_PLAENE)) {
    const letzte = await prisma.cronRun.findMany({
      where: { organizationId, job },
      orderBy: { startedAt: 'desc' },
      take: 20,
      select: { status: true, startedAt: true, finishedAt: true, durationMs: true, processed: true, failed: true },
    });
    const abgeschlossen = letzte.filter((r) => r.status !== 'RUNNING');
    const erster = letzte[0] ?? null;
    let fehlerInFolge = 0;
    for (const r of abgeschlossen) {
      if (r.status === 'SUCCESS') break;
      fehlerInFolge += 1;
    }
    const letzterErfolg = abgeschlossen.find((r) => r.status === 'SUCCESS')?.startedAt ?? null;
    const letzterFehler = abgeschlossen.find((r) => r.status !== 'SUCCESS')?.startedAt ?? null;
    const zuletzt = abgeschlossen[0] ?? null;

    zustaende.push({
      job,
      intervallMinuten: plan.intervallMinuten,
      letzterLauf: erster?.startedAt ?? null,
      letzterStatus: erster?.status ?? null,
      letzterErfolg,
      letzterFehler,
      letzteDauerMs: zuletzt?.durationMs ?? null,
      verarbeitet: zuletzt?.processed ?? null,
      fehlgeschlagen: zuletzt?.failed ?? null,
      naechsterErwartet: erster ? new Date(erster.startedAt.getTime() + plan.intervallMinuten * 60_000) : null,
      fehlerInFolge,
      ueberfaellig: erster ? jetzt.getTime() > erster.startedAt.getTime() + plan.ueberfaelligNachMinuten * 60_000 : false,
      haengt: erster?.status === 'RUNNING' && jetzt.getTime() - erster.startedAt.getTime() > plan.zeitgrenzeMs,
    });
  }
  return zustaende;
}

/** Braucht der Betrieb eine Antwort? Grundlage des Statuscodes von `/api/cron/status`. */
export function zustandIstGesund(zustaende: CronZustand[]): boolean {
  return zustaende.every((z) => !z.ueberfaellig && !z.haengt && z.fehlerInFolge < FEHLER_IN_FOLGE_ALARM);
}
