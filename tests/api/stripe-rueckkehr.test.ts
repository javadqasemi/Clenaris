import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { CHECKOUT_PURPOSE, CHECKOUT_RETURN_PATHS } from '../../src/lib/payments/checkout-refs';

/**
 * Was an Stripe übermittelt wird — und was nicht.
 *
 * Vierte Datei neben `bi-rechenkerne`, `verschluesselung` und
 * `zugriffstokens`, die Anwendungscode direkt importiert, und aus einem
 * verwandten Grund: Ohne eingerichteten Stripe-Zugang lässt sich die
 * Zahlroute über HTTP nicht bis zur Sitzungserzeugung fahren. Beobachten
 * liesse sich nur ein Konfigurationsfehler — nicht, *was* übermittelt worden
 * wäre.
 *
 * **Der Befund dahinter.** Die Rückkehradressen lauteten
 * `/rechnung/<roher Token>/danke` und `/rechnung/<roher Token>`. Damit ging
 * der Capability-Token, der eine Rechnung öffnet und eine Zahlung auslöst,
 * als Bestandteil einer URL an Stripe — und lag dort in der Checkout-Sitzung,
 * im Dashboard, in API-Antworten und in der Webhook-Nutzlast.
 *
 * Diese Datei hält fest, dass dort nie wieder ein Geheimnis von uns steht.
 * Ein vollständiger Durchlauf gegen einen Stripe-Doppelgänger fehlt und ist
 * im Bericht als offener Punkt vermerkt.
 */

describe('Rückkehradressen enthalten kein Clenaris-Geheimnis', () => {
  const adressen = [CHECKOUT_RETURN_PATHS.success, CHECKOUT_RETURN_PATHS.cancel];

  for (const adresse of adressen) {
    it(`„${adresse}" trägt keinen Token`, () => {
      /**
       * Ein Capability-Token sind 32 Zufallsbytes hexadezimal, also 64
       * Zeichen aus `[0-9a-f]`. Gesucht wird jede Folge dieser Länge —
       * gefunden werden darf keine.
       */
      assert.doesNotMatch(adresse, /[0-9a-f]{64}/, 'sieht nach einem rohen Token aus');

      // Auch keine Vorlage, in die später einer eingesetzt werden könnte.
      assert.doesNotMatch(adresse, /\$\{/, 'enthält eine Einsetzstelle');

      // Und kein Rechnungspfad mehr, der einen Token erwartet.
      assert.doesNotMatch(
        adresse,
        /^\/rechnung\//,
        'zeigt wieder auf den tokenbehafteten Rechnungspfad',
      );
    });
  }

  it('die Erfolgsadresse nutzt Stripes eigene Sitzungskennung', () => {
    assert.match(
      CHECKOUT_RETURN_PATHS.success,
      /\{CHECKOUT_SESSION_ID\}/,
      'ohne Sitzungskennung liesse sich die Rückkehr nicht zuordnen',
    );
  });

  it('die Abbruchadresse trägt gar keine Kennung', () => {
    /**
     * Für `cancel_url` ist die Ersetzung von `{CHECKOUT_SESSION_ID}` nicht
     * in derselben Weise zugesichert wie für `success_url`. Statt sich
     * darauf zu verlassen, verzichtet der Abbruchweg auf jede Zuordnung —
     * eine Abbruchseite braucht keine Rechnungsdaten.
     */
    assert.doesNotMatch(CHECKOUT_RETURN_PATHS.cancel, /\{|\?|=/);
  });

  it('die Sitzungen tragen eine eigene Kennzeichnung', () => {
    /**
     * Ohne sie müsste der Rückkehrweg annehmen, jede Sitzung mit einer
     * `invoiceId` in den Metadaten stamme von dieser Anwendung. Mit ihr ist
     * die Prüfung ausdrücklich.
     */
    assert.equal(typeof CHECKOUT_PURPOSE, 'string');
    assert.ok(CHECKOUT_PURPOSE.length > 0);
  });
});
