/**
 * Was Clenaris an Stripe übermittelt, damit eine Rückkehr zuordenbar bleibt
 * — und was dabei ausdrücklich *nicht* übermittelt wird.
 *
 * **Warum eine eigene Datei ohne Abhängigkeiten.** Hier stehen die beiden
 * Zeichenketten, an denen der behobene Befund hängt; sie sollen prüfbar sein,
 * ohne dass dafür der Stripe-Klient, die Umgebungsprüfung und `server-only`
 * geladen werden müssen. Eine Prüfung, die sich nur mit halbem Serverstart
 * ausführen lässt, wird irgendwann nicht mehr ausgeführt.
 */

/**
 * Die Kennzeichnung, an der der Rückkehrweg eine eigene Sitzung erkennt.
 *
 * Ohne sie müsste er annehmen, jede Sitzung mit einer `invoiceId` in den
 * Metadaten stamme von dieser Anwendung. Mit ihr ist die Prüfung
 * ausdrücklich: Fehlt der Zweck, wird die Sitzung nicht angefasst.
 */
export const CHECKOUT_PURPOSE = 'invoice_payment';

/**
 * Die Rückkehradressen — an einer Stelle, damit beide Zahlwege dieselben
 * verwenden und sich beide zugleich prüfen lassen.
 *
 * **Hier darf nie wieder ein Clenaris-Token stehen.** Vorher lauteten sie
 * `/rechnung/<roher Token>/danke` und `/rechnung/<roher Token>`; damit ging
 * das Geheimnis, das eine Rechnung öffnet und eine Zahlung auslöst, als
 * Bestandteil einer URL an einen Dritten — und lag dort in der
 * Checkout-Sitzung, im Dashboard, in API-Antworten und in der
 * Webhook-Nutzlast.
 *
 * `{CHECKOUT_SESSION_ID}` ersetzt Stripe selbst. Es ist Stripes eigene
 * Kennung, kein Schlüssel von uns; der Rückkehrweg löst sie serverseitig auf
 * und stellt *danach* einen frischen, kurzlebigen Ansichtstoken aus.
 *
 * Der Abbruchweg bekommt bewusst gar keine Kennung: Für `cancel_url` ist die
 * Ersetzung nicht in derselben Weise zugesichert wie für `success_url`, und
 * eine Abbruchseite braucht keine Rechnungsdaten.
 */
export const CHECKOUT_RETURN_PATHS = {
  success: '/zahlung/abschluss?sitzung={CHECKOUT_SESSION_ID}',
  cancel: '/zahlung/abgebrochen',
} as const;
