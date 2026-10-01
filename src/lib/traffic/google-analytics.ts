/**
 * Laufzeit der Google-Analytics-Cookies (`_ga`, `_ga_*`) — eine Zahl für das
 * Skript und für die Cookie-Erklärung (2026-09-30).
 *
 * Ohne `server-only` und ohne Abhängigkeiten, aus demselben Grund wie
 * `ereignisse.ts`: Das Skript lädt eine Client-Komponente
 * (`components/marketing/analytics.tsx`), die Erklärung eine Server-Seite
 * (`/legal/cookies`). Eine Konstante in der Client-Datei dürfte die Seite
 * nicht importieren — Werte aus einer `'use client'`-Datei kommen auf dem
 * Server als Verweis an, nicht als Zahl.
 *
 * ---------------------------------------------------------------------------
 *  Warum überhaupt eine eigene Laufzeit
 * ---------------------------------------------------------------------------
 *
 * Die Cookie-Erklärung sagt seit jeher „13 Monate". Das Skript setzte aber
 * keine Laufzeit, und die Vorgabe von Google Analytics 4 ist `cookie_expires`
 * = 63 072 000 Sekunden, zwei Jahre — die bei jedem Aufruf erneuert werden
 * (`cookie_update`, Vorgabe an). Gegenüber den Besuchenden war die Erklärung
 * damit um elf Monate zu kurz. Korrigiert wird das Skript, nicht die
 * Erklärung: Die kürzere Frist ist die datensparsamere, und 13 Monate ist
 * die Frist, die die Erklärung der eigenen Besuchsmessung ebenfalls nennt.
 *
 * Was hier **nicht** geregelt werden kann: wie lange Google die Ereignisse in
 * der Property aufbewahrt. Das stellt die Betreiberin in Google Analytics
 * selbst ein (Verwaltung → Datenaufbewahrung); die Anwendung sieht diese
 * Einstellung nicht.
 */

/** So steht es in der Cookie-Erklärung. */
export const GA_COOKIE_MONATE = 13;

/**
 * Dieselbe Frist in Sekunden, wie `gtag('config', …, { cookie_expires })`
 * sie verlangt: 34 128 000.
 *
 * Ein Kalendermonat ist keine feste Sekundenzahl — 13 Monate ab einem
 * bestimmten Tag dauern zwischen 393 und 397 Tagen. Gerechnet wird mit dem
 * mittleren Monat des gregorianischen Kalenders (365,25 / 12 Tage) und auf
 * ganze Tage **abgerundet**: 395 Tage. Abgerundet, weil eine Frist, die
 * länger läuft als die Erklärung sagt, genau der Fehler wäre, der hier
 * behoben wird; ein Tag weniger schadet niemandem.
 */
export const GA_COOKIE_SEKUNDEN = Math.floor((GA_COOKIE_MONATE * 365.25) / 12) * 24 * 60 * 60;
