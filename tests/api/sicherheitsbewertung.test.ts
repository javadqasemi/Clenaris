import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  befundEinordnen,
  HOECHSTFRIST_TAGE,
  veralteteBewertungen,
  VORWARNUNG_TAGE,
  type Bewertung,
} from '../../scripts/security/bewertung';

/**
 * Risikoannahmen laufen ab (Sicherheitsautomation, 2026-09-26).
 *
 * Direkt importiert: Die Regeln sind Rechnung mit Datumsangaben. Geprüft
 * wird, dass eine Bewertung vor dem Ablauf warnt, nach dem Ablauf wieder
 * blockiert (high) bzw. warnt (darunter), dass `critical` sich nie
 * wegbewerten lässt — und dass die eingecheckten Bewertungen vollständig
 * begründet und nicht zu lang befristet sind.
 *
 * Ob sie *heute* noch gelten, prüft absichtlich nicht diese Reihe, sondern
 * `npm run security:check`: Eine Prüfreihe, die an einem Stichtag von allein
 * rot wird, verrät nichts über den Code — der Sicherheitslauf dagegen soll
 * genau dann anschlagen.
 */

const b = (bis: string, bewertetAm = '2026-09-26'): Bewertung => ({ id: 'GHSA-x', paket: 'p', schwere: 'high', begruendung: 'geprüft', bewertetAm, bis });

describe('Einordnung eines Befunds gegen seine Bewertung', () => {
  it('critical blockiert immer, auch mit Bewertung', () => {
    assert.equal(befundEinordnen('critical', b('2026-12-31'), '2026-10-01').schwere, 'blockierend');
  });

  it('high ohne Bewertung blockiert; darunter nur Hinweis', () => {
    assert.equal(befundEinordnen('high', undefined, '2026-10-01').schwere, 'blockierend');
    assert.equal(befundEinordnen('moderate', undefined, '2026-10-01').schwere, 'hinweis');
  });

  it('gültige Bewertung: Hinweis', () => {
    assert.equal(befundEinordnen('high', b('2026-12-31'), '2026-10-01').schwere, 'hinweis');
  });

  it(`höchstens ${VORWARNUNG_TAGE} Tage vor Ablauf: Warnung`, () => {
    const r = befundEinordnen('high', b('2026-12-31'), '2026-12-01');
    assert.equal(r.schwere, 'warnung');
    assert.match(r.vermerk, /läuft in 30 Tag/);
    assert.equal(befundEinordnen('high', b('2026-12-31'), '2026-11-30').schwere, 'hinweis');
  });

  it('am Stichtag noch gültig (Warnung), am Tag danach abgelaufen', () => {
    assert.equal(befundEinordnen('high', b('2026-12-31'), '2026-12-31').schwere, 'warnung');
    assert.equal(befundEinordnen('high', b('2026-12-31'), '2027-01-01').schwere, 'blockierend');
    assert.equal(befundEinordnen('moderate', b('2026-12-31'), '2027-01-01').schwere, 'warnung');
  });

  it(`eine Frist über ${HOECHSTFRIST_TAGE} Tage ab Bewertung ist selbst eine Warnung`, () => {
    const r = befundEinordnen('high', b('2027-09-26', '2026-09-26'), '2026-10-01');
    assert.equal(r.schwere, 'warnung');
    assert.match(r.vermerk, /länger als/);
  });

  it('Bewertungen ohne gemeldeten Befund werden als veraltet erkannt', () => {
    const alle = [b('2026-12-31'), { ...b('2026-12-31'), id: 'GHSA-y' }];
    assert.deepEqual(veralteteBewertungen(alle, new Set(['GHSA-x'])).map((x) => x.id), ['GHSA-y']);
  });
});

describe('Die eingecheckten Bewertungen', () => {
  const datei = JSON.parse(readFileSync(join(__dirname, '..', '..', 'security', 'akzeptierte-befunde.json'), 'utf8')) as { befunde: Bewertung[] };

  it('sind gültiges JSON mit Kennung, Begründung, Bewertungsdatum und Frist', () => {
    assert.ok(datei.befunde.length > 0);
    for (const e of datei.befunde) {
      assert.match(e.id, /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/, e.id);
      assert.ok(e.begruendung.length >= 40, `${e.id}: Begründung zu kurz`);
      assert.match(e.bewertetAm ?? '', /^\d{4}-\d{2}-\d{2}$/, `${e.id}: bewertetAm fehlt`);
      assert.match(e.bis, /^\d{4}-\d{2}-\d{2}$/, `${e.id}: bis fehlt`);
    }
  });

  it(`sind höchstens ${HOECHSTFRIST_TAGE} Tage befristet`, () => {
    for (const e of datei.befunde) {
      const tage = (Date.parse(e.bis) - Date.parse(e.bewertetAm!)) / 86_400_000;
      assert.ok(tage <= HOECHSTFRIST_TAGE, `${e.id}: ${tage} Tage`);
    }
  });
});
