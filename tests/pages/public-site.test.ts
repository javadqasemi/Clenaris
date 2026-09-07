import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { get, requireServer } from '../helpers/client';
import { internalLinks, pageTitle } from '../helpers/markup';

/**
 * Die öffentliche Website.
 *
 * Zwei Fragen: Ist jede Seite von der Startseite aus erreichbar, und antwortet
 * sie? Eine Seite, die es gibt, auf die aber nichts verweist, existiert für
 * Besucher nicht — und für Suchmaschinen kaum. Das ist der Fehler, den man erst
 * bemerkt, wenn jemand fragt, wo denn die Preise stehen.
 */

const PUBLIC_PAGES = [
  '/leistungen',
  '/preise',
  '/einsatzgebiet',
  '/galerie',
  '/bewertungen',
  '/ueber-uns',
  '/faq',
  '/blog',
  '/karriere',
  '/kontakt',
  '/offerte',
  '/buchen',
  '/legal/impressum',
  '/legal/datenschutz',
  '/legal/agb',
  '/legal/cookies',
];

describe('Öffentliche Website', { concurrency: 1 }, async () => {
  await requireServer();

  const home = await get('/');
  const linked = new Set(internalLinks(home.text));

  describe('ist von der Startseite aus erreichbar', () => {
    for (const path of PUBLIC_PAGES) {
      it(path, () => {
        assert.ok(linked.has(path), 'von der Startseite aus nicht verlinkt');
      });
    }
  });

  describe('antwortet und trägt einen Titel', () => {
    for (const path of ['/', ...PUBLIC_PAGES]) {
      it(path, async () => {
        const response = await get(path);
        assert.equal(response.status, 200, `HTTP ${response.status}`);

        const title = pageTitle(response.text);
        assert.ok(title && title.length > 3, `kein brauchbarer <title>: „${title}"`);
      });
    }
  });

  it('führt eine überschaubare Hauptnavigation', () => {
    // Mehr als sieben Einträge auf oberster Ebene liest niemand mehr; die
    // Zahl ist die Grenze, ab der eine Navigation zur Liste wird.
    const nav = /aria-label="Hauptnavigation"[\s\S]*?<\/nav>/.exec(home.text)?.[0] ?? '';
    assert.notEqual(nav, '', 'keine Hauptnavigation im HTML gefunden');

    const entries = nav
      .replace(/<[^>]+>/g, '|')
      .split('|')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 2);

    assert.ok(entries.length >= 3, `nur ${entries.length} Einträge`);
    assert.ok(entries.length <= 8, `${entries.length} Einträge: ${entries.join(' · ')}`);
  });

  it('liefert robots.txt und sitemap.xml aus', async () => {
    const robots = await get('/robots.txt');
    assert.equal(robots.status, 200);
    assert.ok(robots.text.includes('Sitemap'), 'robots.txt nennt keine Sitemap');

    const sitemap = await get('/sitemap.xml');
    assert.equal(sitemap.status, 200);
    assert.ok(sitemap.text.includes('<urlset'), 'sitemap.xml ist kein urlset');
  });
});
