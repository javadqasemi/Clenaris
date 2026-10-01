import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { get, requireServer } from '../helpers/client';
import { internalLinks, pageTitle } from '../helpers/markup';
import { FIRMEN_TYP, TYPEN_JEDE_SEITE, typenIn } from '../../src/lib/seo/structured-data';
import { qrSvg } from '../../src/lib/kontakt/qr';
import { TRAFFIC_GRENZEN } from '../../src/lib/traffic/ereignisse';
import { GA_COOKIE_MONATE } from '../../src/lib/traffic/google-analytics';

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

// ---------------------------------------------------------------------------

/**
 * Technische SEO (Teil H, 2026-09-28) — was im ausgelieferten HTML steht.
 *
 * Die Regeln selbst prüft `tests/api/seo-rechenkern.test.ts` direkt; hier
 * wird nachgesehen, dass die Seiten sie auch verwenden. Jeder Fall hält einen
 * Befund aus `docs/SEO_AUDIT.md` fest und wäre gegen den Stand vor der
 * Prüfung rot gewesen (Canonical der Startseite überall, hreflang auf 404,
 * FAQPage doppelt, fester Firmenname im JSON-LD, Sitemap ohne Mandant).
 */

/** React setzt `<!-- -->` zwischen Textknoten; vor Mustervergleichen entfernen. */
const ohneKommentare = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '');

function linkHref(html: string, rel: string): string | null {
  const tag = new RegExp(`<link[^>]+rel="${rel}"[^>]*>`, 'i').exec(html)?.[0];
  return tag ? (/href="([^"]*)"/.exec(tag)?.[1] ?? null) : null;
}

function metaProperty(html: string, property: string): string | null {
  const tag = new RegExp(`<meta[^>]+property="${property}"[^>]*>`, 'i').exec(html)?.[0];
  return tag ? (/content="([^"]*)"/.exec(tag)?.[1] ?? null) : null;
}

function jsonLdBloecke(html: string): unknown[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((treffer) =>
    JSON.parse(treffer[1]!),
  );
}

const unescapeAttr = (wert: string) => wert.replace(/&amp;/g, '&');

describe('Technische SEO der öffentlichen Seiten', { concurrency: 1 }, async () => {
  await requireServer();

  for (const path of ['/', ...PUBLIC_PAGES]) {
    describe(path, () => {
      let html = '';

      it('antwortet', async () => {
        const response = await get(path);
        assert.equal(response.status, 200);
        html = ohneKommentare(response.text);
      });

      it('hat genau eine h1', () => {
        assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1);
      });

      it('nennt sich selbst als kanonische Adresse — nicht die Startseite', () => {
        const canonical = linkHref(html, 'canonical');
        assert.ok(canonical, 'kein rel=canonical');
        const url = new URL(unescapeAttr(canonical));
        assert.equal(url.pathname, path === '/' ? '/' : path);
        assert.equal(url.search, '');
        assert.equal(metaProperty(html, 'og:url'), canonical, 'og:url weicht vom Canonical ab');
      });

      it('trägt og:site_name und og:locale', () => {
        assert.equal(metaProperty(html, 'og:site_name'), 'Clenaris');
        assert.equal(metaProperty(html, 'og:locale'), 'de_CH');
      });

      it('verweist mit hreflang auf keine Sprachfassung, die es nicht gibt', () => {
        assert.equal(/hrefLang|hreflang/i.test(html), false);
      });

      it('gibt Firma und Website als strukturierte Daten aus, gültiges JSON', () => {
        const typen = typenIn(jsonLdBloecke(html));
        for (const typ of TYPEN_JEDE_SEITE) assert.ok(typen.includes(typ), `${typ} fehlt`);
      });

      it('enthält für Besuchende keine Redaktionsmarkierungen', () => {
        assert.equal(html.includes('data-cms-key'), false);
      });
    });
  }

  it('zeichnet FAQPage nur auf /faq aus, nicht noch einmal auf der Startseite', async () => {
    const start = typenIn(jsonLdBloecke((await get('/')).text));
    assert.equal(start.includes('FAQPage'), false);
  });

  it('nimmt den Firmennamen im JSON-LD aus den Stammdaten', async () => {
    const html = (await get('/kontakt')).text;
    const graph = jsonLdBloecke(html).find(
      (block) => typeof block === 'object' && block !== null && '@graph' in block,
    ) as { '@graph': Record<string, unknown>[] } | undefined;
    assert.ok(graph, 'kein @graph');
    const firma = graph['@graph'].find((knoten) => knoten['@type'] === FIRMEN_TYP);
    assert.ok(firma, 'kein Firmenknoten');
    assert.ok(typeof firma.name === 'string' && firma.name.length > 1);
    assert.equal('priceRange' in firma, false, 'erfundene Preisspanne');
    // Der sichtbare Firmenname steht auch im HTML der Kontaktseite.
    assert.ok(html.includes(String(firma.name)), 'Firmenname im JSON-LD, aber nicht auf der Seite');
  });

  it('gibt einer Leistungsseite Service, Brotkrumen und Canonical auf sich selbst', async () => {
    const start = (await get('/leistungen')).text;
    const pfad = internalLinks(start).find((link) => /^\/leistungen\/[^/]+$/.test(link));
    if (!pfad) return; // ohne aktive Leistung nichts zu prüfen
    const html = ohneKommentare((await get(pfad)).text);
    const typen = typenIn(jsonLdBloecke(html));
    assert.ok(typen.includes('Service'));
    assert.ok(typen.includes('BreadcrumbList'));
    assert.equal(new URL(unescapeAttr(linkHref(html, 'canonical') ?? '')).pathname, pfad);
    assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1);
  });

  it('erklärt Seiten ausserhalb der Website nicht zur Kopie der Startseite', async () => {
    // Vorher erbte jede Seite ohne eigene Angabe `canonical: '/'` aus dem Wurzellayout.
    const html = (await get('/auth/anmelden')).text;
    const canonical = linkHref(html, 'canonical');
    if (canonical) assert.notEqual(new URL(unescapeAttr(canonical)).pathname, '/');
  });

  it('nimmt die kanonische Adresse nicht aus einem Host-Kopf der Anfrage', async () => {
    const html = (await get('/kontakt', { headers: { 'X-Forwarded-Host': 'boese.example', 'X-Forwarded-Proto': 'https' } })).text;
    assert.equal(html.includes('boese.example'), false);
  });

  it('sperrt in robots.txt die Bereiche ausserhalb der Website', async () => {
    const robots = (await get('/robots.txt')).text;
    for (const pfad of ['/admin/', '/portal/', '/konto/', '/api/', '/signieren', '/abnahme/', '/rechnung/', '/offerte/']) {
      assert.ok(robots.includes(`Disallow: ${pfad}`), `Disallow: ${pfad} fehlt`);
    }
  });

  it('führt in der Sitemap nur öffentliche Seiten', async () => {
    const sitemap = (await get('/sitemap.xml')).text;
    const adressen = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((treffer) => new URL(treffer[1]!).pathname);
    assert.ok(adressen.length >= PUBLIC_PAGES.length);
    for (const pfad of adressen) {
      assert.equal(/^\/(admin|portal|konto|api|auth|signieren|abnahme|rechnung|buchung|zahlung)(\/|$)/.test(pfad), false, pfad);
    }
    const herkunft = new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((treffer) => new URL(treffer[1]!).origin));
    assert.equal(herkunft.size, 1, `mehrere Herkünfte: ${[...herkunft].join(', ')}`);
  });
});

// ---------------------------------------------------------------------------

/**
 * Visitenkarte auf `/kontakt` (Teil I, 2026-09-28): QR-Code im HTML, Download
 * über `GET /api/public/kontakt/vcard` — und beide mit demselben Inhalt.
 */
describe('Kontaktseite — Visitenkarte als QR-Code und Datei', { concurrency: 1 }, async () => {
  await requireServer();

  it('zeigt den QR-Code als SVG mit Beschriftung und den Download-Link', async () => {
    const html = ohneKommentare((await get('/kontakt')).text);
    const svg = /<svg[^>]*data-kontakt-qr[^>]*>[\s\S]*?<\/svg>/.exec(html)?.[0];
    assert.ok(svg, 'kein QR-SVG auf /kontakt');
    assert.match(svg, /role="img"/);
    assert.match(svg, /aria-labelledby="kontakt-qr-titel"/);
    assert.match(svg, /<title id="kontakt-qr-titel">[^<]*QR-Code/);
    assert.match(svg, /fill="#ffffff"/, 'Ruhezone nicht fest weiss');
    assert.ok(html.includes('href="/api/public/kontakt/vcard"'), 'Download-Link fehlt');
    assert.ok(html.includes('Kontakt speichern'));
  });

  it('liefert die vCard als Datei mit den erwarteten Kopfzeilen', async () => {
    const response = await get('/api/public/kontakt/vcard');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/vcard; charset=utf-8/i);
    assert.match(response.headers.get('content-disposition') ?? '', /^attachment; filename="[A-Za-z0-9-]+\.vcf"$/);
    assert.match(response.headers.get('cache-control') ?? '', /public/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });

  it('enthält Firma, Kontaktwege und Adresse — und nichts Internes', async () => {
    const vcard = (await get('/api/public/kontakt/vcard')).text;
    assert.ok(vcard.startsWith('BEGIN:VCARD\r\nVERSION:3.0\r\n'));
    assert.ok(vcard.endsWith('END:VCARD\r\n'));
    const zeilen = vcard.replace(/\r\n /g, '').split('\r\n');
    for (const feld of ['FN', 'ORG', 'EMAIL;TYPE=INTERNET,WORK', 'URL', 'ADR;TYPE=WORK']) {
      assert.ok(zeilen.some((zeile) => zeile.startsWith(`${feld}:`) || zeile.startsWith(`${feld};`)), `${feld} fehlt`);
    }
    // IBAN (CHkk …), MWST-Nummer (CHE-…), Notizen: nichts davon.
    assert.equal(/CH\d{2}\s?\d{4}/.test(vcard), false, 'IBAN in der vCard');
    assert.equal(/CHE-?\d{3}/.test(vcard), false, 'MWST-Nummer in der vCard');
    assert.equal(/^(NOTE|X-IBAN|X-VAT)/m.test(vcard), false);
  });

  it('trägt im QR-Code genau die vCard, die der Download liefert', async () => {
    const [html, vcard] = await Promise.all([get('/kontakt'), get('/api/public/kontakt/vcard')]);
    const pfad = /<svg[^>]*data-kontakt-qr[^>]*>[\s\S]*?<path d="([^"]+)"/.exec(ohneKommentare(html.text))?.[1];
    assert.ok(pfad, 'kein QR-Pfad');
    // Dieselbe Darstellung für die geladene vCard nachrechnen: Stimmen die
    // Pfade überein, kodiert der Code auf der Seite genau diese Datei.
    assert.equal(pfad, qrSvg(vcard.text).pfad, 'QR-Code und Download weichen ab (Seite noch nicht neu erzeugt?)');
  });

  it('nimmt keinen Inhalt aus der Anfrage an', async () => {
    const response = await get('/api/public/kontakt/vcard?name=%3Cscript%3E', {
      headers: { 'X-Forwarded-Host': 'boese.example' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.text.includes('<script>'), false);
    assert.equal(response.text.includes('boese.example'), false);
  });
});

// ---------------------------------------------------------------------------

/**
 * Fristen in den Rechtstexten (2026-09-30) — am ausgelieferten HTML, gegen
 * die Konstanten, nach denen tatsächlich gelöscht bzw. gesetzt wird.
 *
 * Die Datenschutzerklärung nannte für Analysedaten zugleich 13 (Fliesstext)
 * und 14 Monate (Tabelle); gelöscht wird nach `TRAFFIC_GRENZEN.
 * aufbewahrungMonate`. Die Cookie-Erklärung nannte für `_ga` 13 Monate, das
 * Skript setzte zwei Jahre. Beide Seiten leiten die Zahl jetzt ab; diese
 * Fälle halten fest, dass das auch im HTML ankommt.
 *
 * Geprüft wird die eingebaute Fassung. Die Prüfreihe erfasst keinen eigenen
 * Text für Datenschutz oder Cookies (`website-ops.test.ts` schreibt nur die
 * AGB) — eine redaktionelle Fassung ersetzte die eingebaute vollständig.
 */
describe('Rechtstexte — Fristen aus den Konstanten', { concurrency: 1 }, async () => {
  await requireServer();

  /** Der Wert einer Protokollzeile `<dt>Bezeichnung</dt><dd>Wert</dd>`. */
  const protokollwert = (html: string, bezeichnung: string) =>
    new RegExp(`<dt[^>]*>${bezeichnung}</dt>\\s*<dd[^>]*>([^<]*)</dd>`).exec(html)?.[1] ?? null;

  it('Datenschutzerklärung: Analysedaten 13 Monate — gleich der Löschfrist', async () => {
    const antwort = await get('/legal/datenschutz');
    assert.equal(antwort.status, 200);
    const html = ohneKommentare(antwort.text);
    const monate = TRAFFIC_GRENZEN.aufbewahrungMonate;
    assert.equal(protokollwert(html, 'Analysedaten'), `${monate} Monate`, 'Tabelle „Wie lange wir Daten aufbewahren"');
    assert.ok(html.includes(`Die Daten werden nach ${monate} Monaten gelöscht`), 'Fliesstext zur eigenen Besuchsmessung');
    assert.ok(!html.includes('14 Monate'), 'die alte, falsche Frist steht noch auf der Seite');
  });

  it('Cookie-Erklärung: _ga und _ga_* mit der Laufzeit, die das Skript setzt', async () => {
    const antwort = await get('/legal/cookies');
    assert.equal(antwort.status, 200);
    const html = ohneKommentare(antwort.text);
    for (const name of ['_ga', '_ga_*']) {
      const zeile = new RegExp(`<td[^>]*>${name.replace('*', '\\*')}</td>\\s*<td[^>]*>[^<]*</td>\\s*<td[^>]*>([^<]*)</td>`).exec(html);
      assert.ok(zeile, `keine Zeile für ${name}`);
      assert.equal(zeile[1], `${GA_COOKIE_MONATE} Monate`, name);
    }
  });
});
