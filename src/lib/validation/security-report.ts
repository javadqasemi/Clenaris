import { z } from 'zod';

/**
 * Sicherheitsberichte von ausserhalb der Anwendung (Sicherheitsautomation,
 * 2026-09-26): `npm run security:check`, der externe Überwachungsrechner
 * (`ops/security-monitor/`), die ZAP-Grundprüfung, die Sicherung.
 *
 * **Warum ein Eingang statt einer Shell.** Die Sicherheitszentrale soll zeigen,
 * was die Prüfungen gefunden haben — aber keine Browserroute darf eine Prüfung
 * *starten*, ein Programm aufrufen oder eine Datei auf dem Server lesen, die
 * ein Skript hinterlassen hat (dann hinge die Anzeige am Dateisystem genau
 * des Rechners, den sie überwachen soll). Die Prüfungen laufen, wo sie
 * hingehören, und **melden** ihr Ergebnis hierher. Die Anwendung speichert
 * und zeigt; sie führt nichts aus.
 *
 * Alles ist begrenzt: Anzahl Prüfungen, Befunde, Kennzahlen, jede
 * Zeichenkette. Der Absender ist ein Rechner mit einem Token, aber ein
 * gestohlenes Token soll die Datenbank nicht mit Megabytes füllen können.
 * Die Texte werden als Text gezeigt, nie als HTML.
 */

export const SECURITY_REPORT_QUELLEN = ['SECURITY_CHECK', 'EXTERNAL_MONITOR', 'ZAP_BASELINE', 'DEPENDENCY_CHECK', 'BACKUP', 'HOST_INTEGRITY'] as const;
export const SECURITY_REPORT_STATUS = ['OK', 'WARNUNG', 'KRITISCH', 'NICHT_GEPRUEFT'] as const;
export const BEFUND_SCHWERE = ['kritisch', 'hoch', 'mittel', 'niedrig', 'info'] as const;

const text = (max: number) => z.string().trim().max(max);

export const securityReportSchema = z.object({
  quelle: z.enum(SECURITY_REPORT_QUELLEN),
  status: z.enum(SECURITY_REPORT_STATUS),
  /** Version oder Commit der geprüften Anwendung, falls bekannt. */
  version: text(80).optional(),
  /** Wann der Bericht entstand — nicht mehr als einen Tag in der Zukunft. */
  erstelltAm: z.coerce.date().refine((d) => d.getTime() < Date.now() + 86_400_000, 'Zeitpunkt in der Zukunft.'),
  zusammenfassung: text(500).min(1),
  pruefungen: z
    .array(
      z.object({
        id: text(60).min(1),
        titel: text(160).min(1),
        status: z.enum(['BESTANDEN', 'BEFUND', 'NICHT_GEPRUEFT', 'FEHLER']),
        befunde: z.number().int().min(0).max(100_000),
      }),
    )
    .max(50)
    .default([]),
  befunde: z
    .array(
      z.object({
        id: text(120).optional(),
        titel: text(300).min(1),
        schwere: z.enum(BEFUND_SCHWERE),
        ort: text(300).optional(),
        details: text(1000).optional(),
      }),
    )
    .max(200)
    .default([]),
  /** Einzelwerte wie `backupAlterStunden`, `tlsTageBisAblauf`, `kopfzeilenFehlend`. */
  kennzahlen: z
    .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/), z.union([z.number().finite(), z.boolean(), text(120)]))
    .refine((r) => Object.keys(r).length <= 30, 'Höchstens 30 Kennzahlen.')
    .default({}),
});

export type SecurityReportInput = z.infer<typeof securityReportSchema>;
