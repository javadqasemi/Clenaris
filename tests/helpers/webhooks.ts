/**
 * Webhook-Geheimnisse der Prüfreihe (Wave 14).
 *
 * `scripts/test-server.ts` setzt sie in die Umgebung des Testservers, die
 * Prüfungen signieren damit. Kein echtes Geheimnis: Es gilt nur für den
 * Testserver gegen die Testdatenbank und wäre in jeder anderen Umgebung
 * wertlos, weil dort das eigene `RESEND_WEBHOOK_SECRET` steht.
 */
export const PRUEF_RESEND_GEHEIMNIS = `whsec_${Buffer.from('clenaris-pruefreihe-resend-webhook').toString('base64')}`;

/**
 * Token für den Berichtseingang der Sicherheitszentrale (2026-09-26) — mit
 * derselben Begründung: nur Testserver, nur Testdatenbank. Absichtlich
 * verschieden von `CRON_SECRET`, damit ein Test auch beweist, dass das eine
 * das andere nicht öffnet.
 */
export const PRUEF_SICHERHEITSBERICHT_TOKEN = 'clenaris-pruefreihe-sicherheitsbericht-0123456789abcdef';
