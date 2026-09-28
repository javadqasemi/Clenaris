import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { tagPlus, zuercherJahr, zuercherTag, zuercherTagesbeginn, zuercherTagesgrenzen, zuercherTagText } from '../../src/lib/zuerich';

/**
 * Kalendertage in Zürich (2026-09-27) — die Rechnung hinter Nummernkreisen,
 * Fälligkeiten und „heute".
 *
 * Der Anlass: `numbering.service` nahm das Jahr mit `getUTCFullYear`. Eine
 * Rechnung vom 1. Januar um 00:30 Zürcher Zeit trug damit die Nummer des
 * alten Jahres. Geprüft wird an den Stellen, an denen UTC und Zürich
 * auseinanderlaufen: kurz nach Mitternacht im Winter (UTC+1) und im Sommer
 * (UTC+2), und an beiden Umstellungstagen, deren Tage 23 bzw. 25 Stunden haben.
 * Unabhängig davon, in welcher Zone der Prüfrechner läuft.
 */

describe('Zürcher Kalender', () => {
  it('Silvester 23:30 UTC ist in Zürich schon Neujahr — Jahr und Tag', () => {
    const zeitpunkt = new Date('2026-12-31T23:30:00Z'); // 00:30 am 1. Januar in Zürich
    assert.equal(zeitpunkt.getUTCFullYear(), 2026, 'Vorbedingung: in UTC noch das alte Jahr');
    assert.equal(zuercherJahr(zeitpunkt), 2027);
    assert.equal(zuercherTagText(zeitpunkt), '2027-01-01');
  });

  it('Sommernacht: 22:30 UTC ist in Zürich 00:30 des Folgetags', () => {
    assert.equal(zuercherTagText(new Date('2026-07-01T22:30:00Z')), '2026-07-02');
    assert.equal(zuercherTagText(new Date('2026-07-01T21:59:00Z')), '2026-07-01');
  });

  it('der Tag hat die Form von @db.Date: UTC-Mitternacht', () => {
    const tag = zuercherTag(new Date('2026-03-15T10:00:00Z'));
    assert.equal(tag.toISOString(), '2026-03-15T00:00:00.000Z');
    assert.equal(tagPlus(tag, 17).toISOString(), '2026-04-01T00:00:00.000Z');
  });

  it('Tagesbeginn im Winter und im Sommer', () => {
    assert.equal(zuercherTagesbeginn(new Date('2026-01-15T00:00:00Z')).toISOString(), '2026-01-14T23:00:00.000Z');
    assert.equal(zuercherTagesbeginn(new Date('2026-07-15T00:00:00Z')).toISOString(), '2026-07-14T22:00:00.000Z');
  });

  it('Umstellungstage: 23 Stunden im März, 25 im Oktober', () => {
    const maerz = zuercherTagesgrenzen(new Date('2026-03-29T12:00:00Z'));
    assert.equal(maerz.von.toISOString(), '2026-03-28T23:00:00.000Z');
    assert.equal((maerz.bis.getTime() - maerz.von.getTime()) / 3_600_000, 23);
    const oktober = zuercherTagesgrenzen(new Date('2026-10-25T12:00:00Z'));
    assert.equal(oktober.von.toISOString(), '2026-10-24T22:00:00.000Z');
    assert.equal((oktober.bis.getTime() - oktober.von.getTime()) / 3_600_000, 25);
  });
});
