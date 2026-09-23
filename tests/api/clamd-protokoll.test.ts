import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';

import { clamBefehl, schreibeInstream, werteAntwortAus } from '../../src/lib/security/malware/clamd-protokoll';

/**
 * RB-013 — das `clamd`-Protokoll gegen einen nachgebauten Dienst.
 *
 * ---------------------------------------------------------------------------
 *  Was das beweist und was ausdrücklich nicht
 * ---------------------------------------------------------------------------
 *
 * Der Adapter war nie gegen irgendeinen Gegenüber gefahren. Dieser Nachbau
 * spricht das dokumentierte `INSTREAM`-Protokoll von `clamd`: Er liest den
 * Befehl, zerlegt die Längenköpfe, setzt die Stücke zusammen, erkennt die
 * Schlussmarke — und antwortet je nach Inhalt. Stimmt unsere Rahmung nicht
 * (ein falscher Längenkopf, eine fehlende Schlussmarke), kommt hier nie eine
 * Antwort, und die Prüfung scheitert am Zeitlimit.
 *
 * Er beweist **nicht**, dass ein echter `clamd` EICAR erkennt, dass seine
 * Signaturen aktuell sind oder dass `StreamMaxLength` passt. Das ist die
 * Abnahme vor der Produktion (`docs/MALWARE_PROTECTION.md` §Abnahme). Der
 * Testprüfer im Testserver bleibt, was er ist: kein Schadsoftwareprüfer.
 */

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

type Verhalten = 'normal' | 'stumm' | 'unsinn';
let verhalten: Verhalten = 'normal';
let empfangen: Buffer = Buffer.alloc(0);
let server: Server;
let port = 0;

function nachbauClamd(socket: Socket) {
  let puffer = Buffer.alloc(0);
  let befehlGelesen = false;
  const stuecke: Buffer[] = [];
  socket.on('data', (d) => {
    puffer = Buffer.concat([puffer, d]);
    if (!befehlGelesen) {
      const ende = puffer.indexOf(0);
      if (ende < 0) return;
      const befehl = puffer.subarray(0, ende).toString();
      puffer = puffer.subarray(ende + 1);
      befehlGelesen = true;
      if (befehl === 'zPING') return void socket.end('PONG\0');
      if (befehl === 'zVERSION') return void socket.end('ClamAV 1.4.1/27400/Nachbau\0');
      if (befehl !== 'zINSTREAM') return void socket.end('UNKNOWN COMMAND\0');
    }
    for (;;) {
      if (puffer.length < 4) return;
      const laenge = puffer.readUInt32BE(0);
      if (laenge === 0) {
        empfangen = Buffer.concat(stuecke);
        if (verhalten === 'stumm') return; // antwortet nie
        if (verhalten === 'unsinn') return void socket.end('WAS IST DAS\0');
        if (empfangen.length > 1024 * 1024) return void socket.end('INSTREAM size limit exceeded. ERROR\0');
        if (empfangen.includes(Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE'))) {
          return void socket.end('stream: Eicar-Test-Signature FOUND\0');
        }
        return void socket.end('stream: OK\0');
      }
      if (puffer.length < 4 + laenge) return;
      stuecke.push(puffer.subarray(4, 4 + laenge));
      puffer = puffer.subarray(4 + laenge);
    }
  });
}

const ziel = () => ({ host: '127.0.0.1', port });
const pruefen = (bytes: Buffer, timeout = 2_000) => clamBefehl(ziel(), (s) => schreibeInstream(s, bytes), timeout);

describe('clamd-Protokoll gegen einen Nachbau', () => {
  before(async () => {
    server = createServer(nachbauClamd);
    await new Promise<void>((auf) => server.listen(0, '127.0.0.1', auf));
    port = (server.address() as { port: number }).port;
  });

  after(async () => {
    await new Promise<void>((zu) => server.close(() => zu()));
  });

  it('sauber: die Bytes kommen vollständig an, die Antwort ist OK', async () => {
    verhalten = 'normal';
    const inhalt = Buffer.from('Ein gewöhnlicher Rapport, mehrere Zeilen.\n'.repeat(50));
    const antwort = await pruefen(inhalt);
    assert.deepEqual(werteAntwortAus(antwort), { art: 'sauber' });
    assert.ok(empfangen.equals(inhalt), 'Was geprüft wird, ist exakt, was geschickt wurde');
  });

  it('mehrere Stücke: über 64 KiB wird richtig gerahmt und zusammengesetzt', async () => {
    verhalten = 'normal';
    const gross = Buffer.alloc(200 * 1024, 7);
    const antwort = await pruefen(gross);
    assert.deepEqual(werteAntwortAus(antwort), { art: 'sauber' });
    assert.equal(empfangen.length, gross.length);
  });

  it('EICAR wird als Fund gemeldet — mit Namen, ohne Rohantwort', async () => {
    verhalten = 'normal';
    const antwort = await pruefen(Buffer.from(EICAR));
    assert.deepEqual(werteAntwortAus(antwort), { art: 'fund', name: 'Eicar-Test-Signature' });
  });

  it('zu gross: der Dienst lehnt ab, das Ergebnis ist kein „sauber"', async () => {
    verhalten = 'normal';
    const antwort = await pruefen(Buffer.alloc(1024 * 1024 + 1, 1));
    assert.deepEqual(werteAntwortAus(antwort), { art: 'zu_gross' });
  });

  it('ein Dienst, der nicht antwortet, endet im Zeitlimit — nicht in „sauber"', async () => {
    verhalten = 'stumm';
    await assert.rejects(pruefen(Buffer.from('warte'), 300), /TIMEOUT/);
  });

  it('eine unverständliche Antwort gilt nie als sauber', async () => {
    verhalten = 'unsinn';
    const antwort = await pruefen(Buffer.from('irgendwas'));
    assert.deepEqual(werteAntwortAus(antwort), { art: 'unverstanden' });
    // Gemischt: Die sichere Richtung ist der Fund (Quarantäne), nie „sauber".
    assert.notEqual(werteAntwortAus('stream: OK but FOUND something').art, 'sauber');
  });

  it('ein nicht erreichbarer Dienst wirft — der Aufrufer macht daraus ERROR', async () => {
    const leer = createServer();
    await new Promise<void>((auf) => leer.listen(0, '127.0.0.1', auf));
    const freierPort = (leer.address() as { port: number }).port;
    await new Promise<void>((zu) => leer.close(() => zu()));
    await assert.rejects(clamBefehl({ host: '127.0.0.1', port: freierPort }, (s) => schreibeInstream(s, Buffer.from('x')), 1_000));
  });

  it('PING und VERSION', async () => {
    verhalten = 'normal';
    assert.equal(await clamBefehl(ziel(), (s) => s.write('zPING\0'), 1_000), 'PONG');
    assert.match(await clamBefehl(ziel(), (s) => s.write('zVERSION\0'), 1_000), /^ClamAV /);
  });
});
