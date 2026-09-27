/**
 * Kaufmännisch runden — auf den Dezimalwert, nicht auf den Binärwert
 * (2026-09-27).
 *
 * ---------------------------------------------------------------------------
 *  Der Befund
 * ---------------------------------------------------------------------------
 *
 * Drei Helfer rundeten Beträge: `utils.round2` mit
 * `Math.round((x + Number.EPSILON) * 100) / 100`, `bi/math.round2` und
 * `payroll/beitraege.rappen` ohne `EPSILON`. Alle drei rundeten die
 * **Binärzahl**. 1.5 Std. × CHF 12.35 sind 18.525; als Gleitkommazahl
 * 18.52499999999999857…, und daraus wurden 18.52 statt 18.53 — auf einer
 * Rechnung. `EPSILON` (2.2 × 10⁻¹⁶) ist für Beträge dieser Grösse um
 * Grössenordnungen zu klein, um den Darstellungsfehler aufzufangen.
 *
 * ---------------------------------------------------------------------------
 *  Die Rechnung
 * ---------------------------------------------------------------------------
 *
 * JavaScript gibt eine Zahl als die **kürzeste** Dezimalzahl aus, die wieder
 * genau diese Gleitkommazahl ergibt: `String(1.5 * 12.35)` ist `"18.525"`.
 * Das ist der Wert, den die Rechnung meint. Verschoben wird über den
 * Exponenten der Zeichenkette (`"18.525e2"` ist exakt 1852.5), nicht über eine
 * Multiplikation, die den Fehler neu einführte; gerundet wird halb weg von
 * null (ROUND_HALF_UP, wie `aufRappen` in `money.ts`).
 *
 * Ohne Abhängigkeiten und ohne `server-only`: Die Funktion läuft in
 * Formularen im Browser (Vorschau der Summen) wie auf dem Server, und beide
 * sollen dieselbe Zahl zeigen. `decimal.js` ins Browserbündel zu holen wäre
 * dafür unverhältnismässig. Wo Beträge **summiert oder gespeichert** werden,
 * rechnet `money.ts` mit `Prisma.Decimal`; diese Funktion ist die Rundung am
 * Ende einer `number`-Rechnung.
 */
export function kaufmaennischRunden(wert: number, stellen = 2): number {
  if (!Number.isFinite(wert) || wert === 0) return wert === 0 ? 0 : wert;
  const betrag = Math.abs(wert);
  const [mantisse, exponent = '0'] = String(betrag).split('e');
  const verschoben = Number(`${mantisse}e${Number(exponent) + stellen}`);
  const gerundet = Number(`${Math.round(verschoben)}e${-stellen}`);
  if (gerundet === 0) return 0;
  return wert < 0 ? -gerundet : gerundet;
}
