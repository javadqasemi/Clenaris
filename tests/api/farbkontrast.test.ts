import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { kontrast, lesbareFarben, MIN_KONTRAST } from '../../src/lib/farbkontrast';
import { data, get, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb';

/**
 * Lesbare Kalendereinträge (2026-09-27).
 *
 * Befund der axe-Prüfung über die ganze Navigation: weisse Schrift auf
 * „Erledigt" (`#2B8A3E`) mit 4.36 : 1 statt 4.5 : 1 — sichtbar, sobald ein
 * erledigter Einsatz in der angezeigten Woche lag. Nachgerechnet waren fünf
 * der neun Statusfarben zu schwach, „Pausiert" mit 2.1 : 1 am deutlichsten.
 *
 * Zwei Ebenen: Die reine Rechnung mit festen Farben (wie die Rechenkerne der
 * Unternehmensführung, direkt importiert), und der Kalenderendpunkt, der für
 * *jeden* Einsatz ein Paar liefern muss, das die Schwelle hält — auch für
 * eine gespeicherte Einsatzfarbe, die nicht aus der Statuspalette stammt.
 * Gegen den alten Stand scheitern beide: Die Funktion gab es nicht, und der
 * Endpunkt lieferte kein `textColor` (FullCalendar setzt dann Weiss).
 */

describe('Farbkontrast — die Rechnung', () => {
  it('Kontrast nach WCAG: Weiss auf Schwarz 21, auf sich selbst 1, der Befund 4.37', () => {
    assert.equal(Math.round(kontrast('#FFFFFF', '#000000')), 21);
    assert.equal(kontrast('#0B7285', '#0B7285'), 1);
    assert.equal(kontrast('#2B8A3E', '#FFFFFF').toFixed(2), '4.37');
  });

  it('jede alte Statusfarbe ergibt ein Paar über der Schwelle', () => {
    const alt = ['#94A3B8', '#0B7285', '#1971C2', '#5F3DC4', '#E8590C', '#F59F00', '#2B8A3E', '#0C8599', '#C92A2A'];
    for (const farbe of alt) {
      const paar = lesbareFarben(farbe);
      assert.ok(kontrast(paar.hintergrund, paar.schrift) >= MIN_KONTRAST, `${farbe} → ${paar.hintergrund}/${paar.schrift}`);
    }
  });

  it('eine starke Fläche bleibt unverändert, eine helle bekommt dunkle Schrift', () => {
    assert.deepEqual(lesbareFarben('#0B7285'), { hintergrund: '#0B7285', schrift: '#FFFFFF' });
    assert.deepEqual(lesbareFarben('#F59F00'), { hintergrund: '#F59F00', schrift: '#0F172A' });
  });

  it('der Mittelton, an dem beide Schriften scheitern, wird abgedunkelt — der Farbton bleibt', () => {
    assert.ok(kontrast('#2B8A3E', '#0F172A') < MIN_KONTRAST, 'Voraussetzung: dunkle Schrift reicht hier nicht');
    const paar = lesbareFarben('#2B8A3E');
    assert.equal(paar.schrift, '#FFFFFF');
    assert.notEqual(paar.hintergrund, '#2B8A3E');
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(paar.hintergrund.slice(i, i + 2), 16));
    assert.ok(g > r && g > b, `noch grün: ${paar.hintergrund}`);
  });

  it('eine unlesbare Eingabe geht nicht ungeprüft durch', () => {
    assert.deepEqual(lesbareFarben('rot', '#C92A2A'), { hintergrund: '#C92A2A', schrift: '#FFFFFF' });
  });
});

describe('Farbkontrast — der Kalenderendpunkt', () => {
  let jars: Record<AccountName, string>;
  let einsatz: { id: string; color: string | null } | null = null;

  interface Ereignis {
    id: string;
    backgroundColor: string;
    textColor?: string;
    extendedProps: { status: string };
  }

  const fenster = (von: number, bis: number) =>
    `from=${new Date(Date.now() + von * 864e5).toISOString()}&to=${new Date(Date.now() + bis * 864e5).toISOString()}`;
  const laden = async () => [
    ...data(await get<{ data: Ereignis[] }>(`/api/jobs/calendar?${fenster(-60, 0)}`, { jar: jars.admin })),
    ...data(await get<{ data: Ereignis[] }>(`/api/jobs/calendar?${fenster(0, 60)}`, { jar: jars.admin })),
  ];

  before(async () => {
    await requireServer();
    jars = await loginAll();
  });

  after(async () => {
    const db = testDb();
    if (db && einsatz) await db.job.update({ where: { id: einsatz.id }, data: { color: einsatz.color } });
    await testDbSchliessen();
  });

  it('jedes Ereignis trägt eine Schriftfarbe, die auf seiner Fläche die Schwelle hält', async () => {
    const ereignisse = await laden();
    assert.ok(ereignisse.length > 0, 'keine Einsätze im Kalender — Datenbank mit db:seed:demo befüllt?');
    const schwach = ereignisse
      .map((e) => ({ e, k: kontrast(e.backgroundColor, e.textColor ?? '#FFFFFF') }))
      .filter(({ k }) => k < MIN_KONTRAST)
      .map(({ e, k }) => `${e.extendedProps.status} ${e.backgroundColor}/${e.textColor ?? '(keine)'} = ${k.toFixed(2)}`);
    assert.deepEqual(schwach, []);
  });

  it('auch eine gespeicherte Einsatzfarbe ausserhalb der Palette wird lesbar ausgeliefert', async (t) => {
    const db = testDb();
    if (!db) return t.skip(`kein Zugang zur Testdatenbank: ${testDbGrund()}`);
    const kandidat = (await laden())[0];
    assert.ok(kandidat);
    einsatz = await db.job.findUniqueOrThrow({ where: { id: kandidat.id }, select: { id: true, color: true } });
    await db.job.update({ where: { id: kandidat.id }, data: { color: '#2B8A3E' } });

    const ereignis = (await laden()).find((e) => e.id === kandidat.id);
    assert.ok(ereignis);
    assert.ok(
      kontrast(ereignis.backgroundColor, ereignis.textColor ?? '#FFFFFF') >= MIN_KONTRAST,
      `${ereignis.backgroundColor}/${ereignis.textColor ?? '(keine)'}`,
    );
  });
});
