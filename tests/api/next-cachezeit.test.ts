import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/**
 * RB-002 — die Zeitmarke einer Ungültigmachung liegt nie vor der Wanduhr.
 *
 * Next vergleicht das Alter einer gespeicherten Seite (Dateizeit, Wanduhr)
 * mit der Marke, die `expireTags` setzt — und die kam aus der monotonen Uhr.
 * In einem langlebigen Prozess laufen die beiden auseinander; eine
 * Veröffentlichung kurz nach dem letzten Aufruf einer Seite blieb dann bis zu
 * einer Stunde unsichtbar (Herleitung in `scripts/next-cachezeit-korrektur.mjs`).
 *
 * Geprüft wird ohne Server und ohne Warten: Die monotone Uhr wird fünf
 * Sekunden zurückgestellt — so weit, wie sie nach Tagen Laufzeit
 * zurückliegen kann —, dann wird ein Tag ungültig gemacht. Ohne die Korrektur
 * läge die Marke fünf Sekunden in der Vergangenheit, und eine Seite, die eine
 * Sekunde vorher gespeichert wurde, gälte als frisch.
 */

const laden = createRequire(import.meta.url);
const { default: handler } = laden('next/dist/server/lib/cache-handlers/default.external.js') as {
  default: { expireTags: (...tags: string[]) => Promise<void> };
};
const { tagsManifest, isStale } = laden('next/dist/server/lib/incremental-cache/tags-manifest.external.js') as {
  tagsManifest: Map<string, number>;
  isStale: (tags: string[], zeitpunkt: number) => boolean;
};

describe('Next-Cache: Ungültigmachung gegen die Wanduhr (RB-002)', () => {
  it('liegt nicht vor Date.now(), auch wenn die monotone Uhr zurückliegt', async () => {
    const echt = performance.now.bind(performance);
    const tag = `pruef-rb002-${Date.now()}`;
    Object.defineProperty(performance, 'now', { configurable: true, value: () => echt() - 5_000 });
    try {
      const vorher = Date.now();
      // Eine Seite, eine Sekunde vor der Veröffentlichung gespeichert (Dateizeit = Wanduhr).
      const seiteGespeichert = vorher - 1_000;
      await handler.expireTags(tag);

      const marke = tagsManifest.get(tag);
      assert.ok(typeof marke === 'number', 'keine Marke gesetzt');
      assert.ok(marke >= vorher, `Marke ${vorher - marke} ms vor der Wanduhr`);
      assert.equal(isStale([tag], seiteGespeichert), true, 'die vorher gespeicherte Seite gilt noch als frisch');
    } finally {
      Object.defineProperty(performance, 'now', { configurable: true, value: echt });
      tagsManifest.delete(tag);
    }
  });
});
