/**
 * PM2-Prozesskonfiguration für den Produktionsbetrieb.
 *
 * Architekturentscheide:
 *
 *  • **Cluster-Modus, nicht Fork.** Nur im Cluster-Modus kennt PM2 den
 *    `listen`-Zeitpunkt eines Arbeiters und kann deshalb `reload` ohne
 *    Ausfallzeit fahren: neuen Arbeiter starten, warten, bis er auf dem Port
 *    hört, erst dann den alten beenden. Im Fork-Modus wüsste PM2 nur, dass der
 *    Prozess *läuft* — und schaltete um, während Next noch initialisiert.
 *
 *  • **Zwei Instanzen als Vorgabe.** Mit einer einzigen überlappen alter und
 *    neuer Arbeiter zwar auch, aber jede Störung eines Arbeiters ist dann ein
 *    vollständiger Ausfall. Zwei sind das Minimum, bei dem ein Absturz nur die
 *    halbe Kapazität kostet. `PM2_INSTANCES=max` nutzt alle Kerne; auf einem
 *    kleinen Server ist das kontraproduktiv, weil jeder Next-Arbeiter seinen
 *    eigenen Speicher und seine eigenen Datenbankverbindungen hält.
 *
 *  • **Kein `wait_ready`.** Das setzt voraus, dass die Anwendung
 *    `process.send('ready')` sendet. `next start` tut das nicht, und ein
 *    Wrapper nur für dieses Signal wäre eine zusätzliche Fehlerquelle im
 *    Startpfad. Der Cluster-`listen`-Haken leistet dasselbe.
 *
 *  • **Angemeldete Benutzer überleben den Reload.** Die Sitzung steckt in
 *    einem signierten Token im Cookie, nicht im Arbeitsspeicher des Prozesses.
 *    Solange `JWT_SECRET` gleich bleibt, ist jeder Arbeiter für jede Sitzung
 *    zuständig — deshalb braucht es weder Sticky Sessions noch einen geteilten
 *    Sitzungsspeicher.
 *
 *  • **Das Arbeitsverzeichnis ist das Release, nicht `current`.** `cwd` ist
 *    `__dirname`, und Node löst beim Laden dieser Datei Verweise auf — auch
 *    wenn pm2 sie über `current/ecosystem.config.js` liest, läuft der
 *    Arbeiter in `releases/<commit>`. Daran erkennt das Umschaltwerkzeug, ob
 *    pm2 wirklich die neue Fassung geladen hat (`pm_cwd`, siehe `pm2Lage` in
 *    `scripts/release/umschaltung.ts`), und `pm2 save` hält genau dieses
 *    Verzeichnis für einen Neustart des Servers fest.
 *
 *  • **Keine Versionsangabe aus der Umgebung.** Bis 2026-09-29 setzte die
 *    Aktivierung `APP_VERSION` beim Neuladen, und `/api/health` meldete sie
 *    als Stand — eine Behauptung des Aufrufers. Die Instanz belegt ihre
 *    Identität heute selbst aus `RELEASE.json` und `.next/BUILD_ID`.
 *
 * Aufruf nur über das Umschaltwerkzeug (`scripts/release-umschalten.ts`, aus
 * `deploy/v2/release-aktivieren.sh` und `deploy/v2/release-ruecksprung.sh`):
 *   pm2 start <release>/ecosystem.config.js --env production                 # kein Prozess vorhanden
 *   pm2 startOrReload <release>/ecosystem.config.js --env production --update-env
 *   pm2 save                                                                  # nach bestätigter Identität
 */

const path = require('node:path');

/** Ganze Zahl oder das Schlüsselwort `max` — alles andere fällt auf 2 zurück. */
function instances() {
  const raw = process.env.PM2_INSTANCES;
  if (raw === 'max') return 'max';
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 2;
}

module.exports = {
  apps: [
    {
      name: process.env.PM2_APP_NAME || 'clenaris',

      /**
       * Direkt Nexts Startdatei statt `npm start`. Über npm hinge ein
       * zusätzlicher Shell-Prozess zwischen PM2 und Node: Signale erreichten
       * Next dann verzögert oder gar nicht, und ein sauberes Herunterfahren
       * wäre nicht mehr garantiert. Ausserdem würde `npm start` hier neu
       * bauen — die Auslieferung hat das längst getan.
       */
      script: path.join('node_modules', 'next', 'dist', 'bin', 'next'),
      /**
       * Nur Loopback. Ohne `-H` hört `next start` auf allen Schnittstellen,
       * und der Anwendungsport wäre — je nach Host-Firewall — direkt aus dem
       * Internet erreichbar: an TLS, Zugriffsprotokoll und der Adressermittlung
       * (`TRUSTED_PROXY_MODE`) vorbei. Nginx und der Health-Check sprechen
       * ohnehin `127.0.0.1` an (docs/DEPLOYMENT.md 13.5.1).
       */
      args: 'start -H 127.0.0.1',
      cwd: __dirname,

      exec_mode: 'cluster',
      instances: instances(),

      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || 3000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || 3000,
      },

      /**
       * Ein Neustart wegen Speicher ist die Notbremse, nicht der Normalfall.
       * Der Wert liegt bewusst über dem, was ein gesunder Next-Arbeiter
       * braucht: Die PDF-Erzeugung und die Excel-Exporte spitzen kurzzeitig
       * an, und ein Neustart mitten in einem Rechnungslauf wäre schlimmer als
       * ein paar hundert Megabyte mehr.
       */
      max_memory_restart: process.env.PM2_MAX_MEMORY || '768M',

      /** Wie lange PM2 auf den `listen`-Ruf des neuen Arbeiters wartet. */
      listen_timeout: 20000,
      /**
       * Frist zum sauberen Beenden. Laufende Anfragen sollen fertig antworten;
       * die längsten sind PDF-Erzeugung und Berichte mit `maxDuration: 60`.
       */
      kill_timeout: 10000,

      autorestart: true,
      /**
       * Bremse gegen die Absturzschleife: Wer zehnmal in Folge sofort stirbt,
       * hat ein Problem, das ein elfter Versuch nicht löst — dann soll der
       * Prozess sichtbar liegen bleiben statt die Protokolle zu fluten.
       */
      max_restarts: 10,
      min_uptime: 20000,
      restart_delay: 4000,

      merge_logs: true,
      time: true,
      out_file: path.join(__dirname, 'logs', 'pm2', 'out.log'),
      error_file: path.join(__dirname, 'logs', 'pm2', 'error.log'),

      /** Im Produktionsbetrieb niemals: Dateiänderungen kommen über die Auslieferung. */
      watch: false,
    },
  ],
};
