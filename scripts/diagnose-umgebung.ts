/**
 * Die Festwerte des Diagnoseweges — an **einer** Stelle.
 *
 * `scripts/diagnose-server.ts` startet den Entwicklungsserver damit,
 * `playwright.config.ts` fährt den Diagnosemodus dagegen. Stünden die Werte
 * zweimal da, hiesse eine Abweichung: Playwright wartet auf einen Port, an dem
 * niemand horcht, oder — schlimmer — beide meinen ein anderes
 * Zählerverzeichnis und der Lauf scheitert an Rate-Limits, die niemand geleert
 * hat.
 *
 * Diese Datei enthält bewusst **keinen ausführbaren Teil**: Sie wird aus der
 * Playwright-Konfiguration geladen, und die darf beim Laden keinen Server
 * starten.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Eigener Port — der Produktionstestserver auf 3001 darf gleichzeitig laufen. */
export const DIAGNOSE_PORT = '3002';

/**
 * Eigenes Bauverzeichnis. Der Grund steht ausführlich in `next.config.ts`:
 * `next dev` würde sonst den Produktionsbau überschreiben, den die
 * Browserreihe fährt.
 */
export const DIAGNOSE_DIST_DIR = '.next-diagnose';

/**
 * Eigenes Zählerverzeichnis. Ein Diagnoselauf leert beim Start die
 * Rate-Limit-Zähler; läge das Verzeichnis gemeinsam, griffe er damit in die
 * Umgebung eines parallel laufenden Produktionstestservers ein.
 */
export const DIAGNOSE_CACHE_DIR = join(tmpdir(), 'clenaris-tests', 'cache-diagnose');

/**
 * **Ein dritter Bau wurde versucht und verworfen** — festgehalten, damit
 * niemand denselben Weg noch einmal geht.
 *
 * Die Idee war naheliegend: ein *Produktionsbündel mit unminifiziertem React*,
 * weil beide vorhandenen Bauten für sich blind sind — der Produktionsbau
 * schweigt über die Ursache eines Hydrationsfehlers, der Entwicklungsbau zeigt
 * ihn gar nicht erst (0 von 120 gegenüber 3 von 400).
 *
 * Umgesetzt über eine Modulersetzung (`react-dom*.production.js` →
 * `*.development.js`) und einen Loader, der das in den Entwicklungsbündeln
 * eingebackene `process.env.NODE_ENV !== "production"` vorher auflöst — sonst
 * entfernt webpack den gesamten Rumpf als toten Code.
 *
 * Es blieb trotzdem unbrauchbar. Drei Versuche, drei verschiedene Abbrüche:
 * `default.createContext is not a function` (beim Tausch auch von `react`),
 * `hydrateRoot is not a function` (ohne Loader), schliesslich
 * `Cannot read properties of undefined (reading 'push')`. Reacts
 * Entwicklungs- und Produktionsdateien teilen interne Verabredungen
 * (`__DOM_INTERNALS…`, die Flight-Laufzeit), die einen teilweisen Tausch nicht
 * überstehen.
 *
 * **Lehre:** „Produktionsbau mit Entwicklungs-React" ist durch Modultausch
 * nicht herstellbar. Wer die Klartextmeldung braucht, muss den Wettlauf in
 * einem echten Entwicklungsbau nachstellen — oder, wie in Wave 9.1
 * geschehen, ohne sie auskommen: Der `MutationObserver`-Abzug des verworfenen
 * Teilbaums und die Gegenüberstellung mit dem ausgelieferten HTML beantworten
 * dieselbe Frage.
 */
