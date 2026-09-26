import 'server-only';

import type { Prisma, SecurityReportSource, SecurityReportStatus } from '@prisma/client';

import { prisma } from '@/lib/db';
import { recordSecurityEvent } from '@/lib/security/record';
import type { SecurityReportInput } from '@/lib/validation/security-report';

/**
 * Sicherheitsberichte von ausserhalb (Sicherheitsautomation, 2026-09-26).
 *
 * ---------------------------------------------------------------------------
 *  Was hier geschieht — und was nicht
 * ---------------------------------------------------------------------------
 *
 * Gespeichert und gelesen. Nichts wird ausgeführt: keine Prüfung gestartet,
 * kein Programm aufgerufen, keine Datei gelesen. Die Prüfungen laufen im CI,
 * auf dem Überwachungsrechner oder auf dem Server als geplanter Auftrag und
 * **melden** hierher (`POST /api/cron/security-report`).
 *
 * ---------------------------------------------------------------------------
 *  Frische
 * ---------------------------------------------------------------------------
 *
 * Ein grüner Bericht von vor drei Wochen ist keine Aussage über heute. Jede
 * Quelle hat deshalb eine erwartete Taktung; ist der letzte Bericht älter,
 * zeigt die Zentrale „ausgeblieben" statt des alten Status. Ein Überwachungs-
 * rechner, der verstummt, sieht sonst genau aus wie einer, der nichts findet.
 */

/** Ab wann ein Bericht als ausgeblieben gilt — die Taktung plus Spielraum. */
export const ERWARTET_ALLE_STUNDEN: Record<SecurityReportSource, number> = {
  EXTERNAL_MONITOR: 2, // alle 5–15 Minuten erwartet
  BACKUP: 26, // täglich
  HOST_INTEGRITY: 26, // täglich
  DEPENDENCY_CHECK: 26, // täglich
  ZAP_BASELINE: 24 * 8, // wöchentlich
  SECURITY_CHECK: 24 * 8, // je Freigabe, spätestens wöchentlich
};

export const QUELLE_LABEL: Record<SecurityReportSource, string> = {
  SECURITY_CHECK: 'Sicherheitsprüfung (security:check)',
  EXTERNAL_MONITOR: 'Externe Überwachung',
  ZAP_BASELINE: 'ZAP-Grundprüfung (passiv)',
  DEPENDENCY_CHECK: 'Abhängigkeiten und Betriebssystem',
  BACKUP: 'Sicherung und Wiederherstellung',
  HOST_INTEGRITY: 'Rechnerintegrität (AIDE/Wazuh/Falco)',
};

const AUFBEWAHREN_JE_QUELLE = 100;

export async function berichtSpeichern(params: { organizationId: string; bericht: SecurityReportInput }) {
  const { bericht } = params;
  const gespeichert = await prisma.securityReport.create({
    data: {
      organizationId: params.organizationId,
      source: bericht.quelle,
      status: bericht.status,
      version: bericht.version ?? null,
      summary: bericht.zusammenfassung,
      details: { pruefungen: bericht.pruefungen, befunde: bericht.befunde, kennzahlen: bericht.kennzahlen } as Prisma.InputJsonValue,
      reportedAt: bericht.erstelltAm,
    },
    select: { id: true },
  });

  // Aufbewahrung: je Quelle die letzten 100. Ein Rechner, der alle fünf
  // Minuten meldet, füllte sonst die Tabelle — und alte Berichte sagen über
  // heute nichts.
  const alte = await prisma.securityReport.findMany({
    where: { organizationId: params.organizationId, source: bericht.quelle },
    orderBy: { receivedAt: 'desc' },
    skip: AUFBEWAHREN_JE_QUELLE,
    select: { id: true },
  });
  if (alte.length) await prisma.securityReport.deleteMany({ where: { id: { in: alte.map((a) => a.id) } } });

  // Ein kritischer Bericht wird ein Sicherheitsereignis — dort, wo die
  // Systemverantwortung ohnehin nach Entscheidungen sucht, und mit derselben
  // Bestätigungspflicht. Nur beim Wechsel in „kritisch", sonst erzeugte ein
  // Überwachungsrechner alle fünf Minuten dasselbe Ereignis.
  if (bericht.status === 'KRITISCH') {
    const vorher = await prisma.securityReport.findFirst({
      where: { organizationId: params.organizationId, source: bericht.quelle, id: { not: gespeichert.id } },
      orderBy: { receivedAt: 'desc' },
      select: { status: true },
    });
    if (vorher?.status !== 'KRITISCH') {
      await recordSecurityEvent({
        organizationId: params.organizationId,
        kind: 'SECURITY_REPORT_CRITICAL',
        summary: `${QUELLE_LABEL[bericht.quelle]}: ${bericht.zusammenfassung}`.slice(0, 500),
        context: { quelle: bericht.quelle, befunde: bericht.befunde.length, bericht: gespeichert.id },
      });
    }
  }
  return gespeichert;
}

export interface Befundzeile {
  id?: string;
  titel: string;
  schwere: string;
  ort?: string;
  details?: string;
}

export interface QuellenZustand {
  quelle: SecurityReportSource;
  label: string;
  letzter: {
    id: string;
    status: SecurityReportStatus;
    version: string | null;
    summary: string;
    reportedAt: Date;
    receivedAt: Date;
    befunde: Befundzeile[];
    kennzahlen: Record<string, number | string | boolean>;
  } | null;
  ausgeblieben: boolean;
  erwartetAlleStunden: number;
}

/**
 * Die Sicherheitsupdate-Lage für das Update Center (2026-09-26).
 *
 * Zwei Arten von Sicherheitsupdates, zwei Wege — und keiner führt über einen
 * Knopf, der etwas ausführt:
 *
 *  • **Clenaris-Versionen** mit Sicherheitskorrekturen laufen durch das
 *    bestehende Entscheidungsregister (freigeben, terminieren); das erledigt
 *    `listReleases` im Update Center selbst.
 *  • **Abhängigkeiten und Betriebssystem** kommen aus den Berichten
 *    (`SECURITY_CHECK`, `DEPENDENCY_CHECK`). Hier gibt es nichts zu
 *    „installieren": Eine behobene Abhängigkeit kommt mit der nächsten
 *    Clenaris-Version, ein Betriebssystemupdate über den Betrieb des Servers
 *    (unattended-upgrades). Das Update Center zeigt, was offen und wie es
 *    bewertet ist, damit die Freigabe der nächsten Version darauf achten kann.
 */
export async function sicherheitsupdateLage(organizationId: string, jetzt = new Date()) {
  const zustaende = await berichtsZustand(organizationId, jetzt);
  const pruefung = zustaende.find((z) => z.quelle === 'SECURITY_CHECK')!;
  const server = zustaende.find((z) => z.quelle === 'DEPENDENCY_CHECK')!;
  const advisories = (pruefung.letzter?.befunde ?? []).filter((b) => b.id?.startsWith('GHSA-'));
  return {
    pruefung: { letzter: pruefung.letzter ? { receivedAt: pruefung.letzter.receivedAt, status: pruefung.letzter.status } : null, ausgeblieben: pruefung.ausgeblieben },
    advisories,
    server: server.letzter
      ? {
          receivedAt: server.letzter.receivedAt,
          ausgeblieben: server.ausgeblieben,
          sicherheitsupdates: server.letzter.kennzahlen.sicherheitsupdates,
          paketeMitUpdates: server.letzter.kennzahlen.paketeMitUpdates,
        }
      : null,
  };
}

/** Sicherung: spätestens alle 26 h. Wiederherstellungsprobe: spätestens alle 35 Tage (monatlich plus Spielraum). */
export const SICHERUNG_STUNDEN = 26;
export const WIEDERHERSTELLUNG_TAGE = 35;

/**
 * Frische von Sicherung und Wiederherstellungsprobe — getrennt, obwohl beide
 * unter der Quelle `BACKUP` melden (2026-09-26).
 *
 * In der Sicherheitszentrale steht nur der jeweils letzte Bericht; für die
 * Überwachung reicht das nicht: Eine tägliche Sicherung überdeckte sonst eine
 * seit Monaten ausgebliebene Wiederherstellungsprobe. Deshalb wird je Art der
 * letzte *erfolgreiche* Bericht gesucht — erkennbar an seiner Kennzahl
 * (`backupAlterStunden` bzw. `wiederherstellungErgebnis = bestanden`).
 */
export async function sicherungsFrische(organizationId: string, jetzt = new Date()) {
  const berichte = await prisma.securityReport.findMany({
    where: { organizationId, source: 'BACKUP', status: 'OK' },
    orderBy: { receivedAt: 'desc' },
    take: 100,
    select: { receivedAt: true, details: true },
  });
  const kennzahl = (d: unknown, k: string) => ((d ?? {}) as { kennzahlen?: Record<string, unknown> }).kennzahlen?.[k];
  const sicherung = berichte.find((b) => kennzahl(b.details, 'backupAlterStunden') !== undefined)?.receivedAt ?? null;
  const probe = berichte.find((b) => kennzahl(b.details, 'wiederherstellungErgebnis') === 'bestanden')?.receivedAt ?? null;
  const alterStunden = (d: Date | null) => (d ? Math.floor((jetzt.getTime() - d.getTime()) / 3_600_000) : null);
  return {
    sicherung: { zuletzt: sicherung, alterStunden: alterStunden(sicherung), frisch: sicherung !== null && alterStunden(sicherung)! <= SICHERUNG_STUNDEN },
    wiederherstellung: { zuletzt: probe, alterStunden: alterStunden(probe), frisch: probe !== null && alterStunden(probe)! <= WIEDERHERSTELLUNG_TAGE * 24 },
  };
}

/** Je Quelle der letzte Bericht und ob er frisch ist. */
export async function berichtsZustand(organizationId: string, jetzt = new Date()): Promise<QuellenZustand[]> {
  const quellen = Object.keys(ERWARTET_ALLE_STUNDEN) as SecurityReportSource[];
  const letzte = await Promise.all(
    quellen.map((q) =>
      prisma.securityReport.findFirst({
        where: { organizationId, source: q },
        orderBy: { receivedAt: 'desc' },
      }),
    ),
  );
  return quellen.map((quelle, i) => {
    const b = letzte[i];
    const details = (b?.details ?? {}) as { befunde?: Befundzeile[]; kennzahlen?: Record<string, number | string | boolean> };
    return {
      quelle,
      label: QUELLE_LABEL[quelle],
      erwartetAlleStunden: ERWARTET_ALLE_STUNDEN[quelle],
      ausgeblieben: !b || jetzt.getTime() - b.receivedAt.getTime() > ERWARTET_ALLE_STUNDEN[quelle] * 3_600_000,
      letzter: b
        ? {
            id: b.id,
            status: b.status,
            version: b.version,
            summary: b.summary,
            reportedAt: b.reportedAt,
            receivedAt: b.receivedAt,
            befunde: (details.befunde ?? []).slice(0, 50),
            kennzahlen: details.kennzahlen ?? {},
          }
        : null,
    };
  });
}
