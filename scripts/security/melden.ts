/**
 * Einen Bericht an den Eingang der Sicherheitszentrale senden
 * (`POST /api/cron/security-report`, 2026-09-26).
 *
 * Gemeinsam für `security:check -- --melden`, `db-backup.ts` und
 * `db-restore-verify.ts`. Ohne `SECURITY_REPORT_URL` und
 * `SECURITY_REPORT_TOKEN` wird nichts gesendet — und das wird gesagt, nicht
 * verschwiegen. Nur `https` (lokal auch `http://127.0.0.1`), Zeitlimit 15 s.
 *
 * **Ein Fehler beim Melden bricht den Auftrag nicht ab.** Eine Sicherung, die
 * gelungen ist, bleibt gelungen, auch wenn die Zentrale gerade nicht
 * erreichbar ist; die Zentrale zeigt die Quelle dann nach Ablauf der Frist
 * als „ausgeblieben". Das ist die richtige Richtung: Ein verlorener Bericht
 * fällt auf, eine verlorene Sicherung wegen eines Berichts wäre schlimmer.
 */

export interface Meldung {
  quelle: 'SECURITY_CHECK' | 'EXTERNAL_MONITOR' | 'ZAP_BASELINE' | 'DEPENDENCY_CHECK' | 'BACKUP' | 'HOST_INTEGRITY';
  status: 'OK' | 'WARNUNG' | 'KRITISCH' | 'NICHT_GEPRUEFT';
  version?: string;
  erstelltAm: string;
  zusammenfassung: string;
  pruefungen?: { id: string; titel: string; status: 'BESTANDEN' | 'BEFUND' | 'NICHT_GEPRUEFT' | 'FEHLER'; befunde: number }[];
  befunde?: { id?: string; titel: string; schwere: 'kritisch' | 'hoch' | 'mittel' | 'niedrig' | 'info'; ort?: string; details?: string }[];
  kennzahlen?: Record<string, number | string | boolean>;
}

export async function melden(bericht: Meldung, ausgabe: (zeile: string) => void = console.log): Promise<boolean> {
  const ziel = process.env.SECURITY_REPORT_URL?.trim();
  const token = process.env.SECURITY_REPORT_TOKEN?.trim();
  if (!ziel || !token) {
    ausgabe('Melden: NICHT GESENDET — SECURITY_REPORT_URL und SECURITY_REPORT_TOKEN setzen.');
    return false;
  }
  if (!/^https:\/\//.test(ziel) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(ziel)) {
    ausgabe('Melden: NICHT GESENDET — nur https (oder lokal http).');
    return false;
  }
  try {
    const r = await fetch(ziel, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(bericht),
      signal: AbortSignal.timeout(15_000),
    });
    ausgabe(`Melden: HTTP ${r.status}`);
    return r.ok;
  } catch (fehler) {
    ausgabe(`Melden: gescheitert (${fehler instanceof Error ? fehler.message : String(fehler)})`);
    return false;
  }
}
