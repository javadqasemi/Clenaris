/**
 * Abnahme gegen einen echten `clamd` — ausführbar (2026-09-27).
 *
 *   CLAMAV_HOST=… [CLAMAV_PORT=3310] npx tsx scripts/abnahme/clamd.ts
 *
 * `docs/MALWARE_PROTECTION.md` beschreibt die Abnahme in zehn Schritten. Die
 * Schritte, die den **Prüfer** betreffen, laufen hier automatisch — über
 * genau den Klienten, den die Anwendung benutzt (`clamavScanner`), damit ein
 * grünes Ergebnis etwas über die Anwendung sagt und nicht über ein
 * Nebenwerkzeug:
 *
 *   1  Erreichbarkeit (PING) und Fassung samt Signaturstand
 *   2  Saubere Bytes → `clean`
 *   3  EICAR-Testzeichenkette → `infected` (keine echte Schadsoftware)
 *   4  Grösse über `SCAN_MAX_BYTES` → `error/TOO_LARGE`, nie `clean`
 *   8  Unsinn als Antwort → `error`, nie `clean` (gegen einen Stellvertreter
 *      mit `--unsinn-port`, sonst übersprungen und so gemeldet)
 *
 * Die Schritte, die die **Anwendung** betreffen (Quarantäne in der
 * Oberfläche, Nachlauf, Wiederholungsgrenze, Byte-Gleichheit der
 * Auslieferung), bleiben die Handliste in der Dokumentation — sie brauchen
 * die laufende Anwendung mit echter Ablage.
 *
 * Exit 0 nur, wenn jeder ausgeführte Schritt bestanden hat. Ohne
 * `CLAMAV_HOST` bricht das Skript ab, statt „bestanden" zu melden: Eine
 * Abnahme ohne Gegenstelle ist keine.
 */
import Module from 'node:module';
import { join } from 'node:path';

// `server-only` gibt es nur in Next — dieselbe Umleitung wie `scripts/backfill-kpi.ts`, vor dem ersten Import.
const mitAufloeser = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
const urspruenglich = mitAufloeser._resolveFilename;
mitAufloeser._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'server-only') return join(__dirname, '..', 'server-only-stub.cjs');
  return urspruenglich.call(this, request, ...rest);
};

type Ergebnis = { schritt: string; ok: boolean | null; hinweis: string };

async function main(): Promise<void> {
  const { SCAN_MAX_BYTES } = await import('../../src/lib/security/malware/scanner');
  const { clamavScanner, clamKonfiguration } = await import('../../src/lib/security/malware/clamav');
  const { eicarBytes } = await import('../../src/lib/security/malware/test-scanner');
  if (!clamKonfiguration()) {
    console.error('❌  CLAMAV_HOST ist nicht gesetzt — ohne echten clamd gibt es nichts abzunehmen.');
    process.exit(2);
  }
  const scanner = clamavScanner();
  const ergebnisse: Ergebnis[] = [];

  const zustand = await scanner.health();
  ergebnisse.push({ schritt: '1 Erreichbar (PING)', ok: zustand.erreichbar, hinweis: zustand.grund ?? 'PONG' });
  const fassung = await scanner.version();
  ergebnisse.push({ schritt: '1 Fassung und Signaturstand', ok: Boolean(fassung), hinweis: fassung ?? 'keine Antwort auf VERSION' });

  const sauber = await scanner.scan(Buffer.from('Clenaris-Abnahme: gewöhnlicher Text ohne Befund.\n'));
  ergebnisse.push({ schritt: '2 Saubere Bytes → clean', ok: sauber.ergebnis === 'clean', hinweis: `${sauber.ergebnis}${sauber.fehlerCode ? `/${sauber.fehlerCode}` : ''} in ${sauber.dauerMs} ms` });

  const eicar = await scanner.scan(eicarBytes());
  ergebnisse.push({
    schritt: '3 EICAR → infected',
    ok: eicar.ergebnis === 'infected',
    hinweis: eicar.ergebnis === 'infected' ? `Fund: ${eicar.detectionName}` : `${eicar.ergebnis}${eicar.fehlerCode ? `/${eicar.fehlerCode}` : ''} — der Dienst erkennt die Testzeichenkette nicht`,
  });

  const gross = await scanner.scan(Buffer.alloc(SCAN_MAX_BYTES + 1, 0x41));
  ergebnisse.push({ schritt: '4 Über SCAN_MAX_BYTES → error/TOO_LARGE', ok: gross.ergebnis === 'error' && gross.fehlerCode === 'TOO_LARGE', hinweis: `${gross.ergebnis}/${gross.fehlerCode ?? '—'}` });

  const unsinnPort = process.argv.includes('--unsinn-port') ? process.argv[process.argv.indexOf('--unsinn-port') + 1] : undefined;
  if (unsinnPort) {
    process.env.CLAMAV_PORT = unsinnPort;
    const unsinn = await clamavScanner().scan(Buffer.from('Abnahme Schritt 8'));
    ergebnisse.push({ schritt: '8 Unsinnige Antwort → error, nie clean', ok: unsinn.ergebnis === 'error', hinweis: `${unsinn.ergebnis}/${unsinn.fehlerCode ?? '—'}` });
  } else {
    ergebnisse.push({ schritt: '8 Unsinnige Antwort', ok: null, hinweis: 'übersprungen — mit --unsinn-port <Port eines Stellvertreters> ausführen' });
  }

  for (const e of ergebnisse) console.log(`${e.ok === null ? '○' : e.ok ? '✓' : '✗'} ${e.schritt.padEnd(42)} ${e.hinweis}`);
  const gescheitert = ergebnisse.filter((e) => e.ok === false);
  console.log(gescheitert.length ? `\n❌  ${gescheitert.length} Schritt(e) nicht bestanden.` : '\n✓ Alle ausgeführten Prüferschritte bestanden. Die Anwendungsschritte stehen in docs/MALWARE_PROTECTION.md.');
  process.exit(gescheitert.length ? 1 : 0);
}

void main();
