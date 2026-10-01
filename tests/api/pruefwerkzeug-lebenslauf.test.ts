import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BrowserContext, TestInfo } from '@playwright/test';

import { diagnoseAnhaengen, lebenslaufMitschreiben } from '../e2e/helpers/diagnose';

/**
 * Die zwei RC-21-Werkzeuge der Browserreihe — ohne Browser (2026-10-01).
 *
 * `lebenslaufMitschreiben` und `ausstehendeAbwarten` laufen sonst nur im
 * Abbau eines Playwright-Falls, und dort fällt ein Fehler in ihnen genau
 * dann auf, wenn er am meisten kostet: im seltenen roten Lauf, dessen
 * Beweise sie liefern sollten. Hier stehen Browser, Kontext, Seite und
 * Antwort als `EventEmitter`-Attrappen; geprüft wird, was in
 * `rc21-<pid>.jsonl` landet und in welcher Reihenfolge, und dass die Frist
 * der offenen Körperlesungen hält.
 *
 * In `tests/api` statt neben der Browserreihe, weil die Datei keinen Browser
 * und keinen Server braucht: Hier läuft sie in jeder HTTP-Reihe mit und
 * unter dem Null-Übersprung-Tor, statt nur in einem Playwright-Lauf.
 */

function attrappen(ausgabe: string) {
  const browser = Object.assign(new EventEmitter(), {
    browserType: () => ({ name: () => 'chromium' }),
    version: () => '0-attrappe',
    isConnected: () => true,
  });
  const seiten: EventEmitter[] = [];
  const context = Object.assign(new EventEmitter(), {
    browser: () => browser,
    pages: () => seiten,
  });
  const testInfo = {
    title: 'Attrappenfall',
    file: join(ausgabe, 'attrappe.spec.ts'),
    project: { name: 'chromium', outputDir: ausgabe },
    retry: 0,
    workerIndex: 0,
    status: 'passed',
    errors: [] as unknown[],
  };
  const seite = () =>
    Object.assign(new EventEmitter(), {
      url: () => 'http://127.0.0.1:3001/',
    });
  return {
    browser,
    context,
    testInfo,
    seite,
    alsKontext: () => context as unknown as BrowserContext,
    alsInfo: () => testInfo as unknown as TestInfo,
  };
}

function zeilen(ausgabe: string): Array<Record<string, unknown>> {
  return readFileSync(join(ausgabe, `rc21-${process.pid}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((z) => JSON.parse(z) as Record<string, unknown>);
}

describe('RC-21: Lebenslauf von Browser, Kontext und Seiten (rein, Attrappen)', () => {
  it('schreibt Beginn, Ende mit Urteil des Rahmens, Abbau und die Ereignisse danach in Reihenfolge', () => {
    const ausgabe = mkdtempSync(join(tmpdir(), 'clenaris-rc21-'));
    try {
      const a = attrappen(ausgabe);
      const lebenslauf = lebenslaufMitschreiben(a.alsKontext(), a.alsInfo());
      const seite = a.seite();
      a.context.emit('page', seite);

      // Der Fallkörper ist grün, die Wache schlägt an — genau der Fall, den
      // der Lebenslauf sonst als „passed, 0 Fehler" ohne Einschränkung zeigte.
      lebenslauf.fallEnde({ offeneKoerper: 0, koerperAbgewartet: true, hydrationsfehler: true });
      lebenslauf.abgebaut({ auswertungGeworfen: true });
      seite.emit('close');
      a.context.emit('close');
      a.browser.emit('disconnected');
      seite.emit('crash');

      const eintraege = zeilen(ausgabe);
      assert.deepEqual(
        eintraege.map((e) => e.ereignis),
        ['browser.beobachtet', 'fall.beginn', 'fall.ende', 'fixture.abgebaut', 'page.close', 'context.close', 'browser.disconnected', 'page.crash'],
      );
      const ende = eintraege.find((e) => e.ereignis === 'fall.ende')!;
      assert.equal(ende.status, 'passed', 'der Status des Fallkörpers bleibt, wie Playwright ihn meldet');
      assert.equal(ende.hydrationsfehler, true, 'das Urteil des Rahmens steht daneben');
      assert.equal(eintraege.find((e) => e.ereignis === 'fixture.abgebaut')!.auswertungGeworfen, true);
      for (const e of eintraege) {
        assert.equal(e.pid, process.pid);
        assert.equal(typeof e.zeit, 'string');
        assert.equal(typeof e.freiMb, 'number');
      }
    } finally {
      rmSync(ausgabe, { recursive: true, force: true });
    }
  });

  it('lässt keinen Fall scheitern, wenn das Ausgabeverzeichnis nicht beschreibbar ist', () => {
    const ausgabe = mkdtempSync(join(tmpdir(), 'clenaris-rc21-'));
    try {
      const a = attrappen(join(ausgabe, 'gibt-es-nicht', '\0ungültig'));
      const lebenslauf = lebenslaufMitschreiben(a.alsKontext(), a.alsInfo());
      assert.doesNotThrow(() => lebenslauf.fallEnde({ hydrationsfehler: false }));
      assert.doesNotThrow(() => lebenslauf.abgebaut({ auswertungGeworfen: false }));
    } finally {
      rmSync(ausgabe, { recursive: true, force: true });
    }
  });
});

describe('RC-21: offene Körperlesungen der Hydrationswache (rein, Attrappen)', () => {
  function antwort(text: Promise<string>) {
    return {
      status: () => 200,
      url: () => 'http://127.0.0.1:3001/',
      request: () => ({ resourceType: () => 'document' }),
      text: () => text,
    };
  }

  it('wartet höchstens die Frist und meldet eine Lesung, die nicht zurückkommt, als offen', async () => {
    const ausgabe = mkdtempSync(join(tmpdir(), 'clenaris-rc21-'));
    try {
      const a = attrappen(ausgabe);
      const diagnose = diagnoseAnhaengen(a.alsKontext(), a.alsInfo());
      const seite = a.seite();
      a.context.emit('page', seite);

      assert.deepEqual(await diagnose.ausstehendeAbwarten(50), { offen: 0, abgeschlossen: true });

      let freigeben!: (text: string) => void;
      seite.emit('response', antwort(new Promise<string>((auf) => (freigeben = auf))));
      const beginn = Date.now();
      assert.deepEqual(await diagnose.ausstehendeAbwarten(150), { offen: 1, abgeschlossen: false });
      assert.ok(Date.now() - beginn < 2_000, 'die Frist hält — eine hängende Lesung hält den Abbau nicht auf');

      freigeben('<html></html>');
      assert.deepEqual(await diagnose.ausstehendeAbwarten(1_000), { offen: 1, abgeschlossen: true });
      // Danach ist die Lesung aus der Menge entfernt (`finally` in der Wache).
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(await diagnose.ausstehendeAbwarten(50), { offen: 0, abgeschlossen: true });
    } finally {
      rmSync(ausgabe, { recursive: true, force: true });
    }
  });

  it('eine abgelehnte Lesung zählt als erledigt, nicht als Fehler des Rahmens', async () => {
    const ausgabe = mkdtempSync(join(tmpdir(), 'clenaris-rc21-'));
    try {
      const a = attrappen(ausgabe);
      const diagnose = diagnoseAnhaengen(a.alsKontext(), a.alsInfo());
      const seite = a.seite();
      a.context.emit('page', seite);
      seite.emit('response', antwort(Promise.reject(new Error('Target page, context or browser has been closed'))));
      assert.deepEqual(await diagnose.ausstehendeAbwarten(1_000), { offen: 1, abgeschlossen: true });
      await assert.doesNotReject(diagnose.auswerten(a.alsInfo()));
    } finally {
      rmSync(ausgabe, { recursive: true, force: true });
    }
  });
});
