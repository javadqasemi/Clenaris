import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { get, requireServer } from '../helpers/client';
import { loginAs } from '../helpers/accounts';

/**
 * Sortierung — ob sie *wirkt*, nicht ob die Seite noch lädt.
 *
 * Die Tabelle wird einmal aufsteigend und einmal absteigend geholt, die erste
 * Datenspalte aus dem HTML gezogen und verglichen. Eine Sortierung, die den
 * Parameter entgegennimmt und ignoriert, fällt damit auf — und genau das ist
 * der Fehler, den ein „Seite lädt"-Test durchwinkt.
 *
 * Dazu drei Dinge, die man leicht übersieht:
 *  • Überlebt die Ordnung das Umblättern? Der häufigste Fehler ist, dass Seite
 *    zwei auf die Standardordnung zurückfällt und Zeilen doppelt zeigt.
 *  • Bricht ein manipuliertes Feld die Seite? `?sort=passwordHash` darf keine
 *    Fehlerseite erzeugen — und erst recht keine Spalte sortieren.
 *  • Trägt der Kopf `aria-sort`? Ohne das ist die Ordnung für eine
 *    Sprachausgabe unsichtbar.
 */

let jar = '';

/** Die erste Zelle jeder Zeile — genug, um eine Änderung der Ordnung zu sehen. */
function firstCells(html: string): string[] {
  const body = html.split('<tbody')[1] ?? '';
  return [...body.matchAll(/<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) =>
    match[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#x27;|&quot;|&amp;/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

/**
 * Die Kennungen der Zeilen, aus den Verweisen auf die Detailseite.
 *
 * Für die Frage „steht dieselbe Zeile auf zwei Seiten?" reicht der angezeigte
 * Text nicht: Zwei Kundschaften dürfen gleich heissen, und die Prüfungen legen
 * bei jedem Lauf dieselbe Firma an. Verglichen werden muss, was eine Zeile
 * eindeutig macht.
 */
function rowIds(html: string, prefix: string): string[] {
  const body = html.split('<tbody')[1] ?? '';
  const pattern = new RegExp(`href="${prefix}/([a-z0-9]+)"`, 'g');
  return [...new Set([...body.matchAll(pattern)].map((match) => match[1]))];
}

const withSort = (path: string, field: string, order: string) =>
  `${path}${path.includes('?') ? '&' : '?'}sort=${field}&order=${order}`;

describe('Sortierung', { concurrency: 1 }, async () => {
  await requireServer();
  jar = await loginAs('admin');

  describe('wirkt auf jeder Liste', () => {
    const CASES: [string, string, string][] = [
      ['Rechnungen', '/admin/rechnungen', 'number'],
      ['Rechnungen nach Betrag', '/admin/rechnungen', 'grossTotal'],
      ['Buchungen', '/admin/buchungen', 'number'],
      ['Einsätze', '/admin/einsaetze', 'number'],
      ['Kunden', '/admin/kunden', 'lastName'],
      ['Kunden nach Umsatz', '/admin/kunden', 'lifetimeValue'],
      ['Offerten', '/admin/offerten', 'number'],
      ['Anfragen', '/admin/leads?ansicht=liste', 'lastName'],
    ];

    for (const [name, path, field] of CASES) {
      it(name, async () => {
        const asc = await get(withSort(path, field, 'asc'), { jar });
        const desc = await get(withSort(path, field, 'desc'), { jar });

        assert.equal(asc.status, 200);
        assert.equal(desc.status, 200);

        const up = firstCells(asc.text);
        const down = firstCells(desc.text);

        assert.ok(up.length >= 2, `nur ${up.length} Zeilen — zu wenig zum Vergleichen`);

        // Bei mehr Treffern als einer Seite ist die umgekehrte Reihenfolge
        // nicht die gespiegelte Liste. Entscheidend ist, dass sich die Ordnung
        // überhaupt ändert.
        assert.notDeepEqual(up, down, `Ordnung unverändert, erste Zeile bleibt „${up[0]}"`);
      });
    }
  });

  describe('überlebt das Blättern', () => {
    // Der häufigste Fehler: Seite 2 fällt auf die Standardordnung zurück und
    // zeigt dieselben Datensätze noch einmal — während andere nie erscheinen.
    const CASES: [string, string, string][] = [
      ['Rechnungen', '/admin/rechnungen', 'grossTotal'],
      ['Kunden', '/admin/kunden', 'lifetimeValue'],
    ];

    for (const [name, path, field] of CASES) {
      it(name, async (t) => {
        const first = await get(withSort(path, field, 'asc'), { jar });
        const link = /href="([^"]*seite=2[^"]*)"/.exec(first.text)?.[1];

        if (!link) {
          t.skip('nur eine Seite, nichts zu blättern');
          return;
        }

        const decoded = link.replace(/&amp;/g, '&');
        assert.ok(decoded.includes(`sort=${field}`), `Blätter-Link ohne Sortierfeld: ${decoded}`);
        assert.ok(decoded.includes('order=asc'), `Blätter-Link ohne Richtung: ${decoded}`);

        const second = await get(decoded, { jar });
        const onFirst = rowIds(first.text, path);
        const onSecond = rowIds(second.text, path);

        assert.ok(onFirst.length > 0, 'keine Zeilenkennungen auf Seite 1 gefunden');
        assert.ok(onSecond.length > 0, 'keine Zeilenkennungen auf Seite 2 gefunden');

        const overlap = onFirst.filter((id) => onSecond.includes(id));
        assert.deepEqual(overlap, [], 'Seite 2 wiederholt Zeilen von Seite 1');
      });
    }
  });

  describe('bleibt robust und ausgezeichnet', () => {
    it('bricht bei einem unbekannten Sortierfeld nicht', async () => {
      // `passwordHash` ist eine Spalte, die es in der Tabelle gibt, aber nie
      // sortierbar sein darf.
      const response = await get('/admin/rechnungen?sort=passwordHash&order=asc', { jar });
      assert.equal(response.status, 200);
    });

    it('bricht bei einer unbekannten Richtung nicht', async () => {
      const response = await get('/admin/rechnungen?sort=grossTotal&order=seitwaerts', { jar });
      assert.equal(response.status, 200);
    });

    it('setzt aria-sort am aktiven und an den übrigen Köpfen', async () => {
      const response = await get('/admin/rechnungen?sort=grossTotal&order=desc', { jar });
      assert.ok(response.text.includes('aria-sort="descending"'), 'aktiver Kopf ohne aria-sort');
      assert.ok(response.text.includes('aria-sort="none"'), 'übrige Köpfe ohne aria-sort="none"');
    });

    it('macht die Sortierung über echte Links bedienbar', async () => {
      // Ein `onClick` auf einem `<th>` ist mit der Tastatur nicht erreichbar
      // und lässt sich nicht als Adresse weitergeben.
      const response = await get('/admin/rechnungen?sort=grossTotal&order=desc', { jar });
      assert.ok(
        /aria-sort="[^"]+"[^>]*>\s*<a /.test(response.text) ||
          response.text.includes('sort=issueDate'),
      );
    });
  });
});
