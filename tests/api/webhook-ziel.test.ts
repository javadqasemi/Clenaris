import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';

import { pruefeZiel, sendeWebhook, WEBHOOK_MAX_ANTWORT_BYTES, WEBHOOK_TIMEOUT_MS } from '../../src/lib/automation/webhook';

/**
 * Grenzen eines ausgehenden Webhooks: Port, Gesamtfrist, Antwortgrösse
 * (N-10, 2026-09-27).
 *
 * Direkt importiert, aus demselben Grund wie in `automatisierungen.test.ts`
 * und `sicherheitsluecken.test.ts`: Über HTTP müsste der Server ein fremdes
 * Ziel wirklich anrufen. Hier ersetzt eine nachgebildete Gegenstelle
 * `https.request` (`mock.method` am Modulobjekt, `syncBuiltinESMExports` für
 * die benannten ESM-Bindungen) — gezählt wird, ob und wie oft verbunden
 * wurde, und wann der Aufruf endet.
 *
 * Gegen den alten Stand scheitert jeder Fall: Ein Port war frei wählbar, die
 * Frist war nur die Leerlaufzeit des Sockets (eine tröpfelnde Gegenstelle oder
 * eine hängende Namensauflösung hielt den Aufruf beliebig lange), und für die
 * Grössengrenze gab es keine Prüfung.
 */

const oeffentlich = async () => [{ address: '93.184.215.14', family: 4 }];

interface Nachbildung {
  aufrufe: string[];
  antworten: (PassThrough & { statusCode: number })[];
  anfrageZerstoert: () => boolean;
  /** Wie viele Bytes die Gegenstelle bis zum Abbruch geschickt hat. */
  geschrieben: () => number;
}

/**
 * Eine Gegenstelle, die mit 200 antwortet und danach je nach `verhalten`
 * Bytes schickt: `troepfeln` alle 20 ms ein Byte, ohne je zu enden; `flut`
 * so lange 4-KiB-Stücke, bis jemand die Antwort zerstört.
 */
function gegenstelle(verhalten: 'troepfeln' | 'flut'): Nachbildung {
  const aufrufe: string[] = [];
  const antworten: (PassThrough & { statusCode: number })[] = [];
  let zerstoert = false;
  let geschrieben = 0;
  mock.method(https, 'request', ((url: unknown, _optionen: unknown, rueckruf: (antwort: unknown) => void) => {
    aufrufe.push(String(url));
    const anfrage = new EventEmitter() as EventEmitter & { end: (rumpf?: unknown) => void; destroy: () => void };
    anfrage.destroy = () => {
      zerstoert = true;
    };
    anfrage.end = () => {
      setImmediate(() => {
        const antwort = Object.assign(new PassThrough(), { statusCode: 200 });
        antworten.push(antwort);
        rueckruf(antwort);
        const schreiben = () => {
          if (antwort.destroyed) return;
          const stueck = Buffer.alloc(verhalten === 'troepfeln' ? 1 : 4096, 0x61);
          geschrieben += stueck.byteLength;
          antwort.write(stueck);
          setTimeout(schreiben, verhalten === 'troepfeln' ? 20 : 1);
        };
        schreiben();
      });
    };
    return anfrage;
  }) as unknown as typeof https.request);
  syncBuiltinESMExports();
  return { aufrufe, antworten, anfrageZerstoert: () => zerstoert, geschrieben: () => geschrieben };
}

afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
});

describe('Webhook-Ziel: nur Port 443', () => {
  for (const url of [
    'https://gegenstelle.pruef.example:8443/hook',
    'https://gegenstelle.pruef.example:22/',
    'https://gegenstelle.pruef.example:6379/',
    'https://gegenstelle.pruef.example:80/hook',
    'https://93.184.215.14:5432/',
  ]) {
    it(`${url} wird vor jeder Auflösung und Verbindung abgewiesen`, async () => {
      let aufgeloest = 0;
      const ergebnis = await pruefeZiel(url, async () => {
        aufgeloest += 1;
        return [{ address: '93.184.215.14', family: 4 }];
      });
      assert.equal(ergebnis.ok, false);
      assert.equal(ergebnis.ok === false && ergebnis.fehler, 'SCHEMA', JSON.stringify(ergebnis));
      assert.equal(aufgeloest, 0, 'ein unzulässiger Port darf nicht einmal aufgelöst werden');

      const g = gegenstelle('flut');
      const gesendet = await sendeWebhook({ url, rumpf: { pruefung: true }, aufloesen: oeffentlich });
      assert.equal(gesendet.ok, false);
      assert.equal(gesendet.fehler, 'SCHEMA');
      assert.equal(g.aufrufe.length, 0, 'es wurde trotzdem verbunden');
    });
  }

  it('der Standardport — weggelassen oder ausdrücklich :443 — bleibt zulässig', async () => {
    for (const url of ['https://gegenstelle.pruef.example/hook', 'https://gegenstelle.pruef.example:443/hook']) {
      const ergebnis = await pruefeZiel(url, oeffentlich);
      assert.equal(ergebnis.ok, true, `${url}: ${JSON.stringify(ergebnis)}`);
    }
  });
});

describe('Webhook: Gesamtfrist statt Leerlaufzeit', () => {
  it('eine tröpfelnde Gegenstelle wird nach der Gesamtfrist abgebrochen — Ergebnis TIMEOUT, nicht Erfolg', async () => {
    const g = gegenstelle('troepfeln');
    const frist = 300;
    const ergebnis = await sendeWebhook({ url: 'https://gegenstelle.pruef.example/hook', rumpf: { pruefung: true }, aufloesen: oeffentlich, gesamtfristMs: frist });
    assert.equal(g.aufrufe.length, 1);
    assert.equal(ergebnis.ok, false, JSON.stringify(ergebnis));
    assert.equal(ergebnis.fehler, 'TIMEOUT');
    assert.ok(ergebnis.dauerMs >= frist - 20 && ergebnis.dauerMs < frist + 1500, `Dauer ${ergebnis.dauerMs} ms bei einer Frist von ${frist} ms`);
    assert.equal(g.antworten[0]!.destroyed, true, 'die Antwort läuft nach der Frist weiter');
    assert.equal(g.anfrageZerstoert(), true, 'die Anfrage läuft nach der Frist weiter');
  });

  it('eine hängende Namensauflösung zählt zur Frist', async () => {
    const g = gegenstelle('flut');
    const haengt = () => new Promise<{ address: string; family: number }[]>(() => undefined);
    const ergebnis = await sendeWebhook({ url: 'https://haengt.pruef.example/hook', rumpf: {}, aufloesen: haengt, gesamtfristMs: 200 });
    assert.equal(ergebnis.fehler, 'TIMEOUT', JSON.stringify(ergebnis));
    assert.ok(ergebnis.dauerMs < 1500, `Dauer ${ergebnis.dauerMs} ms`);
    assert.equal(g.aufrufe.length, 0, 'ohne Auflösung darf nicht verbunden werden');
  });

  it('ohne ausdrückliche Frist gilt WEBHOOK_TIMEOUT_MS als Obergrenze — zehn Sekunden, nicht mehr', () => {
    assert.equal(WEBHOOK_TIMEOUT_MS, 10_000);
  });
});

describe('Webhook: Grössengrenze der Antwort', () => {
  it(`eine endlose Antwort wird nach ${WEBHOOK_MAX_ANTWORT_BYTES} Bytes abgebrochen, statt den Speicher zu füllen`, async () => {
    const g = gegenstelle('flut');
    const ergebnis = await sendeWebhook({ url: 'https://gegenstelle.pruef.example/hook', rumpf: {}, aufloesen: oeffentlich, gesamtfristMs: 5_000 });
    const antwort = g.antworten[0]!;
    assert.equal(antwort.destroyed, true, 'die Antwort wurde nicht abgebrochen');
    // Gelesen wird stückweise: die Grenze plus höchstens die Stücke, die
    // zwischen Überschreiten und Abbruch schon unterwegs waren.
    assert.ok(g.geschrieben() <= WEBHOOK_MAX_ANTWORT_BYTES + 4096 * 3, `bis zum Abbruch geschickt: ${g.geschrieben()} Bytes`);
    assert.notEqual(ergebnis.fehler, 'TIMEOUT', 'die Grössengrenze greift, nicht erst die Frist');
    assert.ok(ergebnis.dauerMs < 5_000, `Dauer ${ergebnis.dauerMs} ms`);
  });
});
