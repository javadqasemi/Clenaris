/**
 * Webhook-Geheimnisse der Prüfreihe (Wave 14).
 *
 * `scripts/test-server.ts` setzt sie in die Umgebung des Testservers, die
 * Prüfungen signieren damit. Kein echtes Geheimnis: Es gilt nur für den
 * Testserver gegen die Testdatenbank und wäre in jeder anderen Umgebung
 * wertlos, weil dort das eigene `RESEND_WEBHOOK_SECRET` steht.
 */
export const PRUEF_RESEND_GEHEIMNIS = `whsec_${Buffer.from('clenaris-pruefreihe-resend-webhook').toString('base64')}`;
