/**
 * HTTPS-Vorschaltung vor dem Prüfserver — nur für die Browserreihe
 * (2026-09-29, Pendenz W-02).
 *
 *   npx tsx scripts/test-https-vorschaltung.ts          # https://127.0.0.1:3443 → http://127.0.0.1:3001
 *   E2E_HTTPS_PORT=3444 E2E_PORT=3002 npx tsx scripts/test-https-vorschaltung.ts
 *
 * **Warum es das gibt.** Die Anmeldecookies sind im Produktionsbau `Secure`.
 * Chromium und Firefox schicken sie auch über `http://127.0.0.1`, weil sie
 * die Loopback-Adresse als sicheren Ursprung behandeln; Playwrights WebKit
 * tut das nicht — weder für `127.0.0.1` noch für `localhost` (gemessen
 * 2026-09-29). Angemeldete Fälle liefen deshalb nie in WebKit. `Secure` für
 * die Prüfung abzuschalten hiesse, genau die Einstellung aufzuweichen, deren
 * Wirkung geprüft werden soll. Stattdessen spricht WebKit hier HTTPS, wie
 * Safari in Betrieb auch.
 *
 * **Zertifikat ohne Zusatzpaket.** Ein selbstsigniertes Zertifikat (ECDSA
 * P-256, SAN `127.0.0.1` und `localhost`, 2 Tage gültig) entsteht bei jedem
 * Start im Speicher — mit `node:crypto` und einem kleinen DER-Kodierer, statt
 * eine Abhängigkeit nur für die Prüfreihe in die Lieferkette zu holen. Es
 * wird nirgends gespeichert; der Browser nimmt es über `ignoreHTTPSErrors`
 * an, das nur das WebKit-Projekt setzt.
 *
 * **Was die Vorschaltung ändert — und was nicht.** Sie reicht jede Anfrage
 * unverändert weiter, auch den `Host`-Kopf: Die Herkunftsprüfung der
 * Anwendung erlaubt den Host der Anfrage selbst, und der ist hier der Host
 * der Vorschaltung. Umgeschrieben werden nur `Location`-Köpfe von
 * Weiterleitungen, die die Anwendung als `http://…` baut, weil sie selbst
 * über HTTP angesprochen wird — sonst spränge der Browser nach jeder
 * Weiterleitung aus dem HTTPS heraus. Kein `X-Forwarded-*`: Der Prüfserver
 * läuft mit `TRUSTED_PROXY_MODE=NONE` und würde ihn ohnehin nicht lesen.
 */
import http from 'node:http';
import https from 'node:https';
import { X509Certificate, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const ZIEL_PORT = Number(process.env.E2E_PORT?.trim() || '3001');
const PORT = Number(process.env.E2E_HTTPS_PORT?.trim() || '3443');

// ---------------------------------------------------------------------------
//  DER-Kodierung, gerade genug für ein X.509-v3-Zertifikat
// ---------------------------------------------------------------------------

function laenge(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, ...teile: Buffer[]) => {
  const inhalt = Buffer.concat(teile);
  return Buffer.concat([Buffer.from([tag]), laenge(inhalt.length), inhalt]);
};
const folge = (...teile: Buffer[]) => tlv(0x30, ...teile);
const menge = (...teile: Buffer[]) => tlv(0x31, ...teile);
function oid(punktiert: string): Buffer {
  const teile = punktiert.split('.').map(Number);
  const bytes = [40 * teile[0]! + teile[1]!];
  for (const wert of teile.slice(2)) {
    const stueck = [wert & 0x7f];
    for (let rest = wert >> 7; rest > 0; rest >>= 7) stueck.unshift((rest & 0x7f) | 0x80);
    bytes.push(...stueck);
  }
  return tlv(0x06, Buffer.from(bytes));
}
const ganzzahl = (bytes: Buffer) => tlv(0x02, bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
const utcZeit = (d: Date) => tlv(0x17, Buffer.from(`${d.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`));

function selbstsigniert(): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const ecdsaSha256 = folge(oid('1.2.840.10045.4.3.2'));
  const name = folge(menge(folge(oid('2.5.4.3'), tlv(0x0c, Buffer.from('Clenaris Prüfreihe')))));
  const jetzt = Date.now();
  const alternativeNamen = folge(
    tlv(0x82, Buffer.from('localhost')), // dNSName
    tlv(0x87, Buffer.from([127, 0, 0, 1])), // iPAddress
  );
  const erweiterungen = tlv(0xa3, folge(folge(oid('2.5.29.17'), tlv(0x04, alternativeNamen))));
  const zuSignieren = folge(
    tlv(0xa0, ganzzahl(Buffer.from([2]))), // Version 3
    ganzzahl(randomBytes(12)),
    ecdsaSha256,
    name,
    folge(utcZeit(new Date(jetzt - 3_600_000)), utcZeit(new Date(jetzt + 2 * 86_400_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    erweiterungen,
  );
  const signatur = sign('sha256', zuSignieren, privateKey);
  const der = folge(zuSignieren, ecdsaSha256, tlv(0x03, Buffer.concat([Buffer.from([0]), signatur])));
  const cert = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/.{1,64}/g, '$&\n')}-----END CERTIFICATE-----\n`;
  // Selbstprüfung: Node muss das Ergebnis als Zertifikat lesen können, sonst
  // lieber hier scheitern als mit einem unverständlichen TLS-Fehler im Browser.
  const gelesen = new X509Certificate(cert);
  if (!gelesen.checkHost('localhost') || !gelesen.checkIP('127.0.0.1')) {
    throw new Error('Das erzeugte Zertifikat deckt 127.0.0.1/localhost nicht ab.');
  }
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), cert };
}

// ---------------------------------------------------------------------------
//  Weiterleitung
// ---------------------------------------------------------------------------

const httpUrsprung = new RegExp(`^http://(127\\.0\\.0\\.1|localhost):(${ZIEL_PORT}|${PORT})`);

const server = https.createServer(selbstsigniert(), (anfrage, antwort) => {
  const weiter = http.request(
    { host: '127.0.0.1', port: ZIEL_PORT, method: anfrage.method, path: anfrage.url, headers: anfrage.headers },
    (zielAntwort) => {
      const koepfe = { ...zielAntwort.headers };
      if (typeof koepfe.location === 'string') koepfe.location = koepfe.location.replace(httpUrsprung, `https://$1:${PORT}`);
      antwort.writeHead(zielAntwort.statusCode ?? 502, koepfe);
      zielAntwort.pipe(antwort);
    },
  );
  weiter.on('error', () => {
    if (!antwort.headersSent) antwort.writeHead(502);
    antwort.end();
  });
  anfrage.pipe(weiter);
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`HTTPS-Vorschaltung: https://127.0.0.1:${PORT} → http://127.0.0.1:${ZIEL_PORT}\n`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)));
