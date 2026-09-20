import { test as basis } from '@playwright/test';

import { resetRateLimits } from '../../helpers/rate-limit';

/**
 * Der gemeinsame Testrahmen der Browser-Reihe.
 *
 * **Was er tut und warum ausgerechnet das.** Vor jedem Fall werden die
 * Rate-Limit-Zähler des Testservers geleert — dieselbe Massnahme, die
 * `loginAll()` in der HTTP-Reihe je Datei ergreift, hier nur feiner.
 *
 * Der Grund ist eine harte Grenze: Die Anmeldung erlaubt acht Versuche je
 * fünf Minuten und Adresse, und weil vor dem Testserver kein Proxy steht
 * (`TRUSTED_PROXY_MODE=NONE`), teilen sich **alle** Aufrufer den Schlüssel
 * „unbekannt". Diese Reihe meldet sich aber bewusst in fast jedem Fall neu an,
 * weil die Gerätesperre an der Rotationsfamilie hängt und eine
 * wiederverwendete Sitzung genau diese Aussage zerstörte. Ohne das Leeren
 * liefe der neunte Fall in einen 429 und man suchte den Fehler im Produkt.
 *
 * Die Limits selbst bleiben unverändert; ihre Semantik prüft weiterhin
 * `tests/api/rate-limit.test.ts` gegen die echten Werte.
 *
 * Das ist zugleich die Zusicherung aus § 4: Jeder Fall beginnt mit vollem
 * Kontingent und setzt keinen anderen voraus.
 */
export const test = basis.extend({});

test.beforeEach(async () => {
  resetRateLimits();
});

export { expect } from '@playwright/test';
