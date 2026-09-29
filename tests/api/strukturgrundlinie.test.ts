import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { join } from 'node:path';

import { navigationszieleLesen, strukturLesen, strukturVergleichen, type Struktur } from '../../scripts/strukturgrundlinie';

/**
 * Strukturelle Grundlinie der Merkmalsprüfung (2026-09-29, M1).
 *
 * Direkt importiert wie `pruefbilanz.test.ts`: Geprüft wird die Regel, nach
 * der `feature-integrity.ts` einen Rückschritt blockiert. Gegen den alten
 * Stand scheitert jeder Fall mit Fehlererwartung — dort gab es keinen
 * Vergleich, und die Merkmalsprüfung endete immer mit 0.
 */

const GRUNDLINIE: Struktur = {
  endpunkte: ['GET /api/quotes', 'POST /api/quotes', 'DELETE /api/quotes/[id]'],
  berechtigungen: ['quote:create', 'quote:read', 'quote:delete'],
  migrationen: ['20260904090000_init', '20260905100000_performance_indexes'],
};

describe('Strukturelle Grundlinie', () => {
  it('lässt einen unveränderten Stand durch und meldet Neues nur als Hinweis', () => {
    const befund = strukturVergleichen(GRUNDLINIE, {
      ...GRUNDLINIE,
      endpunkte: [...GRUNDLINIE.endpunkte, 'PATCH /api/quotes/[id]'],
    });
    assert.deepEqual(befund.fehler, []);
    assert.deepEqual(befund.neu, ['Endpunkt neu: PATCH /api/quotes/[id]']);
  });

  it('blockiert einen verschwundenen Endpunkt', () => {
    const befund = strukturVergleichen(GRUNDLINIE, { ...GRUNDLINIE, endpunkte: ['GET /api/quotes', 'POST /api/quotes'] });
    assert.deepEqual(befund.fehler, ['Endpunkt fehlt gegenüber der Grundlinie: DELETE /api/quotes/[id]']);
  });

  it('blockiert eine entfallene Berechtigung — auch wenn eine andere dazukommt und die Anzahl gleich bleibt', () => {
    const befund = strukturVergleichen(GRUNDLINIE, { ...GRUNDLINIE, berechtigungen: ['quote:create', 'quote:read', 'quote:send'] });
    assert.deepEqual(befund.fehler, ['Berechtigung fehlt gegenüber der Grundlinie: quote:delete']);
  });

  it('blockiert eine entfernte Migration', () => {
    const befund = strukturVergleichen(GRUNDLINIE, { ...GRUNDLINIE, migrationen: ['20260904090000_init'] });
    assert.deepEqual(befund.fehler, ['Migration fehlt gegenüber der Grundlinie: 20260905100000_performance_indexes']);
  });

  it('blockiert ein Navigationsziel ohne Seite, nimmt dynamische Segmente und Routengruppen als Seite', () => {
    const seiten = [/^\/admin$/, /^\/admin\/kunden\/[^/]+$/];
    const befund = strukturVergleichen(
      GRUNDLINIE,
      GRUNDLINIE,
      [
        { ziel: '/admin', datei: 'layout.tsx' },
        { ziel: '/admin/kunden/abc', datei: 'layout.tsx' },
        { ziel: '/admin/verschwunden', datei: 'layout.tsx' },
      ],
      seiten,
    );
    assert.deepEqual(befund.fehler, ['Navigationsziel ohne Seite: /admin/verschwunden (layout.tsx)']);
  });

  it('liest den echten Bestand: Katalog, Endpunkte, Migrationen und Navigation sind nicht leer', () => {
    const wurzel = join(__dirname, '..', '..');
    const struktur = strukturLesen(wurzel);
    assert.ok(struktur.endpunkte.length > 100, `nur ${struktur.endpunkte.length} Endpunkte gelesen`);
    assert.ok(struktur.berechtigungen.includes('role:assign'));
    assert.ok(struktur.migrationen.some((m) => m.endsWith('_init')));
    assert.ok(navigationszieleLesen(wurzel).length > 20);
  });
});
