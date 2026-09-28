/**
 * Leistungsmessung gegen einen laufenden Server (Wave 19).
 *
 *   $env:TEST_BASE_URL = 'http://127.0.0.1:3001'
 *   npx tsx scripts/leistungsmessung.ts [--runden 15] [--json pfad]
 *
 * Misst die Antwortzeit der meistbenutzten Seiten und Endpunkte je Rolle —
 * Median, p95 und Maximum über mehrere Runden nach zwei Aufwärmrunden.
 *
 * Warum ein Skript und keine Testreihe mit Zeitbudget: Eine Schwelle in
 * Millisekunden hängt an der Maschine, an der Datenbankgrösse und daran, was
 * nebenher läuft. Als Test wäre sie entweder so grosszügig, dass sie nichts
 * fängt, oder so knapp, dass sie auf dem nächsten Rechner rot wird und
 * abgeschaltet wird. Das Skript liefert Zahlen für einen Vergleich *vorher /
 * nachher auf derselben Maschine* — dafür ist es da. Die Messwerte der Wave
 * stehen in `docs/LEISTUNG.md`, mit Maschine und Datenbestand.
 *
 * Gemessen wird die Wanduhr beim Client. Endpunkte liefern zusätzlich
 * `Server-Timing: app;dur=…`; die Differenz ist Netz und Serialisierung.
 * Eine Probe, die in ein Rate-Limit lief (der Client wartet dann), wird
 * verworfen, statt die Wartezeit als Antwortzeit zu zählen.
 */
import { writeFileSync } from 'node:fs';

import { get, requireServer } from '../tests/helpers/client';
import { loginAll, type AccountName } from '../tests/helpers/accounts';

const ZIELE: [AccountName, string][] = [
  ['admin', '/admin'],
  ['admin', '/admin/kalender'],
  ['admin', '/admin/buchungen'],
  ['admin', '/admin/einsaetze'],
  ['admin', '/admin/kunden'],
  ['admin', '/admin/rechnungen'],
  ['admin', '/admin/offerten'],
  ['admin', '/admin/lohn'],
  ['admin', '/admin/suche?q=Reinigung'],
  ['admin', '/admin/fuehrung'],
  ['admin', '/admin/auswertungen'],
  // Ergänzt 2026-09-28: die Bereiche, nach denen „die App lädt langsam"
  // gefragt wurde und die bisher nicht gemessen waren.
  ['admin', '/admin/vertraege'],
  ['admin', '/admin/personal'],
  ['admin', '/api/customers'],
  ['admin', '/api/invoices'],
  ['admin', '/api/jobs?pageSize=50'],
  ['admin', '/api/search?q=Reinigung'],
  ['admin', '/api/notifications/count'],
  ['employee', '/portal'],
  ['employee', '/portal/einsaetze'],
  ['customer', '/konto'],
  ['customer', '/konto/rechnungen'],
  ['admin', '/'],
  ['admin', '/offerte'],
  ['admin', '/buchen'],
];

function arg(name: string, vorgabe: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : vorgabe;
}

const quantil = (werte: number[], q: number) => {
  const s = [...werte].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] ?? NaN;
};

async function main() {
  await requireServer();
  const jars = await loginAll();
  const runden = Number(arg('runden', '15'));
  const ergebnisse: {
    rolle: string;
    pfad: string;
    status: number;
    median: number;
    p95: number;
    max: number;
    server?: number;
    bytes: number;
  }[] = [];

  for (const [rolle, pfad] of ZIELE) {
    const zeiten: number[] = [];
    const serverzeiten: number[] = [];
    let status = 0;
    let bytes = 0;
    for (let i = 0; i < runden + 2; i++) {
      const start = performance.now();
      const r = await get(pfad, { jar: jars[rolle], retries: 0 });
      const dauer = performance.now() - start;
      status = r.status;
      bytes = r.text.length;
      if (r.status === 429 || i < 2) continue;
      zeiten.push(dauer);
      const st = /app;dur=(\d+(?:\.\d+)?)/.exec(r.headers.get('server-timing') ?? '');
      if (st) serverzeiten.push(Number(st[1]));
    }
    const zeile = {
      rolle,
      pfad,
      status,
      median: Math.round(quantil(zeiten, 0.5)),
      p95: Math.round(quantil(zeiten, 0.95)),
      max: Math.round(Math.max(...zeiten)),
      server: serverzeiten.length ? Math.round(quantil(serverzeiten, 0.5)) : undefined,
      bytes,
    };
    ergebnisse.push(zeile);
    console.log(
      `${rolle.padEnd(9)} ${pfad.padEnd(28)} ${String(status).padEnd(4)} median ${String(zeile.median).padStart(5)} ms  p95 ${String(zeile.p95).padStart(5)} ms  max ${String(zeile.max).padStart(5)} ms` +
        (zeile.server !== undefined ? `  server ${zeile.server} ms` : '') +
        `  ${Math.round(bytes / 1024)} KB  (${zeiten.length} Proben)`,
    );
  }

  const json = arg('json', '');
  if (json) writeFileSync(json, JSON.stringify(ergebnisse, null, 2));
}

main().catch((fehler) => {
  console.error(fehler);
  process.exit(1);
});
