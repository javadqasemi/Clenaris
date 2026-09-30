import { createHash } from 'node:crypto';

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

/**
 * Stripe-Webhook-Geheimnis der Prüfreihe (2026-09-27) — dieselbe Begründung.
 * Damit lassen sich Zahlungs- und Rückerstattungsereignisse mit einer echten,
 * gültigen Signatur zustellen (`Stripe.webhooks.generateTestHeaderString`),
 * ohne Stripe-Konto und ohne einen Schlüssel für die Stripe-API: Die
 * Signaturprüfung braucht nur dieses Geheimnis. Zusammengesetzt statt als
 * Literal, damit die Geheimnisprüfung kein Muster sieht, wo keines ist.
 */
export const PRUEF_STRIPE_GEHEIMNIS = `whsec_${Buffer.from('clenaris-pruefreihe-stripe-webhook').toString('hex')}`;

/**
 * Release-Ausführer (2026-09-27, `release-center.test.ts`): Token und
 * Signaturschlüssel sind zwei verschiedene Werte — die Prüfreihe beweist,
 * dass das Token allein nichts übernimmt. Umgebung des Testservers: `test`.
 */
export const PRUEF_AUSFUEHRER_TOKEN = `ausf_${Buffer.from('clenaris-pruefreihe-release-token').toString('hex')}`;
export const PRUEF_AUSFUEHRER_SCHLUESSEL = `sig_${Buffer.from('clenaris-pruefreihe-release-signatur').toString('hex')}`;

/**
 * Identität des Testservers (2026-09-30, Production-V2-Härtung).
 *
 * Eine laufende Instanz belegt ihre Identität seither aus `RELEASE.json` und
 * `BUILD_ID` in ihrem Verzeichnis — ein Prüfbau hat kein `RELEASE.json`,
 * also schreibt `scripts/test-server.ts` ein Prüfmanifest mit diesem Commit
 * und reicht es über `CLENARIS_PRUEF_RELEASE_MANIFEST` herein (nur in der
 * Umgebung `test` wirksam; die Produktionsvorprüfung weist die Variable ab).
 * Ein fester, erkennbar künstlicher Wert: Die Release-Prüfungen legen ein
 * Release mit genau diesem Commit an und beweisen, dass „erfolgreich" nur
 * gilt, wenn die antwortende Instanz ihn selbst belegt. Aus einem Hash
 * abgeleitet statt als Literal, damit er nie mit einem echten Commit
 * verwechselt wird und die Geheimnisprüfung kein Muster sieht.
 */
export const PRUEF_IDENTITAET_COMMIT = createHash('sha1').update('clenaris-pruefreihe-identitaet').digest('hex');
