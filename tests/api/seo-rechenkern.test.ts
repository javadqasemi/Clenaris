import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  absoluteSeitenUrl,
  beitragsSeo,
  gepflegteSeo,
  kanonischerPfad,
  klartext,
  kuerzen,
  markdownKlartext,
  seitenHerkunft,
  seitenMetadaten,
  seoStatus,
  sichereBildUrl,
  stellenSeo,
  TITEL_ZUSATZ,
} from '../../src/lib/seo/metadaten';
import {
  artikelKnoten,
  bewertungsKnoten,
  brotkrumen,
  faqSeite,
  FIRMEN_TYP,
  firmenKnoten,
  leistungsKnoten,
  leistungsPreis,
  ohneLeere,
  stellenKnoten,
  strukturierteDatenTypen,
  typenIn,
  websiteGraph,
  type FirmenDaten,
} from '../../src/lib/seo/structured-data';
import { jsonLd } from '../../src/lib/json-ld';

/**
 * Technische SEO der öffentlichen Website (Teil H, 2026-09-28) — die reinen
 * Rechenkerne, direkt importiert. Was hier steht, ist die Regel; die Seiten
 * und die Übersicht in `/admin/seo` rufen genau diese Funktionen.
 *
 * Jede Erwartung, die einen behobenen Befund festhält, sagt im Namen, was
 * vorher anders war — sie wäre gegen den alten Stand rot gewesen.
 */

const HERKUNFT = 'https://www.clenaris.ch';

const FIRMA: FirmenDaten = {
  name: 'Clenaris',
  legalName: 'Clenaris Reinigungen GmbH',
  email: 'info@clenaris.ch',
  phone: '031 123 45 67',
  logoUrl: null,
  address: { street: 'Aarbergergasse 1', postalCode: '3011', city: 'Bern', canton: 'BE', country: 'CH' },
  openingHours: [
    { weekday: 1, opensAt: '07:00', closesAt: '18:00', closed: false },
    { weekday: 0, opensAt: null, closesAt: null, closed: true },
  ],
};

describe('Metadaten — Klartext und Adressen', () => {
  it('entfernt Tags und Steuerzeichen aus Titel und Beschreibung', () => {
    assert.equal(klartext('<b>Umzug</b>\u0000 in   Bern<script>x</script>'), 'Umzug in Bern x');
    assert.equal(klartext(null), '');
  });

  it('löst Entitäten nicht auf — „&lt;script&gt;" bleibt Text', () => {
    assert.equal(klartext('&lt;script&gt;'), '&lt;script&gt;');
  });

  it('entfernt Markdown-Auszeichnung für Beschreibungen', () => {
    assert.equal(markdownKlartext('## Aufgabe\n- **Reinigen** von [Büros](/x)'), 'Aufgabe Reinigen von Büros');
  });

  it('kürzt an einer Wortgrenze mit Auslassungszeichen', () => {
    const text = kuerzen('Eins zwei drei vier fünf sechs sieben', 20);
    assert.ok(text.length <= 20, text);
    assert.ok(text.endsWith('…'));
    assert.ok(!text.includes('  '));
  });

  it('nimmt als Herkunft nur http(s) ohne Zugangsdaten, und nur den Ursprung', () => {
    assert.equal(seitenHerkunft('https://www.clenaris.ch/pfad?x=1'), 'https://www.clenaris.ch');
    assert.equal(seitenHerkunft('javascript:alert(1)'), null);
    assert.equal(seitenHerkunft('https://nutzer:pw@clenaris.ch'), null);
    assert.equal(seitenHerkunft('kein url'), null);
  });

  it('lässt als kanonischen Pfad nur einen Pfad dieser Website zu', () => {
    assert.equal(kanonischerPfad('/'), '/');
    assert.equal(kanonischerPfad('/kontakt/'), '/kontakt');
    assert.equal(kanonischerPfad('/buchen?leistung=x#oben'), '/buchen');
    assert.equal(kanonischerPfad('//fremd.example/x'), null);
    assert.equal(kanonischerPfad('https://fremd.example/'), null);
    assert.equal(kanonischerPfad('/a/../admin'), null);
    assert.equal(kanonischerPfad('/a\\b'), null);
    assert.equal(kanonischerPfad('/a b'), null);
    // Zweimal hintereinander: Ein globaler Ausdruck mit `lastIndex` hätte beim zweiten Aufruf anders geantwortet.
    assert.equal(kanonischerPfad('/a\u0001b'), null);
    assert.equal(kanonischerPfad('/a\u0001b'), null);
  });

  it('baut absolute Adressen nur aus Herkunft und geprüftem Pfad', () => {
    assert.equal(absoluteSeitenUrl('/', HERKUNFT), 'https://www.clenaris.ch/');
    assert.equal(absoluteSeitenUrl('/leistungen', `${HERKUNFT}/`), 'https://www.clenaris.ch/leistungen');
    assert.equal(absoluteSeitenUrl('//boese.example', HERKUNFT), null);
    assert.equal(absoluteSeitenUrl('/x', 'ftp://clenaris.ch'), null);
  });

  it('lässt als Vorschaubild nur https, eigene Herkunft oder eigenen Pfad zu', () => {
    assert.equal(sichereBildUrl('/api/files/blob/abc', HERKUNFT), 'https://www.clenaris.ch/api/files/blob/abc');
    assert.equal(sichereBildUrl('https://cdn.example/bild.jpg', HERKUNFT), 'https://cdn.example/bild.jpg');
    assert.equal(sichereBildUrl('http://localhost:3000/bild.jpg', 'http://localhost:3000'), 'http://localhost:3000/bild.jpg');
    assert.equal(sichereBildUrl('http://fremd.example/bild.jpg', HERKUNFT), null);
    assert.equal(sichereBildUrl('javascript:alert(1)', HERKUNFT), null);
    assert.equal(sichereBildUrl('data:image/png;base64,AAAA', HERKUNFT), null);
    assert.equal(sichereBildUrl('//fremd.example/bild.jpg', HERKUNFT), null);
    assert.equal(sichereBildUrl('', HERKUNFT), null);
  });
});

describe('Metadaten — seitenMetadaten()', () => {
  it('setzt Canonical und og:url absolut aus der Herkunft', () => {
    const meta = seitenMetadaten({ pfad: '/preise', titel: 'Preise', beschreibung: 'Text' }, HERKUNFT);
    assert.equal(meta.alternates?.canonical, 'https://www.clenaris.ch/preise');
    assert.equal((meta.openGraph as { url?: string }).url, 'https://www.clenaris.ch/preise');
  });

  it('trägt og:site_name, og:locale und og:type — vorher ersetzte das Seiten-openGraph die des Layouts', () => {
    const og = seitenMetadaten({ pfad: '/', titel: 'T', beschreibung: 'B' }, HERKUNFT).openGraph as Record<string, unknown>;
    assert.equal(og.siteName, 'Clenaris');
    assert.equal(og.locale, 'de_CH');
    assert.equal(og.type, 'website');
  });

  it('lässt Canonical und og:url weg, wenn der Pfad nicht geprüft werden kann', () => {
    const meta = seitenMetadaten({ pfad: 'https://boese.example/', titel: 'T', beschreibung: 'B' }, HERKUNFT);
    assert.equal(meta.alternates, undefined);
    assert.equal((meta.openGraph as { url?: string }).url, undefined);
  });

  it('macht aus Markup im Titel Klartext', () => {
    const meta = seitenMetadaten({ pfad: '/', titel: '<i>Reinigung</i> Bern', beschreibung: '<p>x</p>' }, HERKUNFT);
    assert.equal(meta.title, 'Reinigung Bern');
    assert.equal(meta.description, 'x');
  });

  // SEO-06 (2026-09-29): Früher hiess „kein gepflegtes Bild" auch „kein
  // og:image" und die kleine Karte. Seither gilt dann das Standardbild —
  // die Erwartung „summary ohne Bild" wäre heute die leere Vorschau, die
  // SEO-06 beseitigt. Geprüft wird deshalb: gepflegtes Bild geht vor,
  // sonst das Standardbild mit Massen, und die kleine Karte nur, wenn gar
  // kein Bild gebildet werden kann (keine gültige Herkunft).
  it('nimmt das gepflegte Vorschaubild, sonst das Standardbild — die grosse Karte nur mit Bild', () => {
    const ohne = seitenMetadaten({ pfad: '/', titel: 'T', beschreibung: 'B' }, HERKUNFT);
    assert.equal((ohne.twitter as { card?: string }).card, 'summary_large_image');
    assert.deepEqual((ohne.openGraph as { images?: unknown }).images, [
      { url: 'https://www.clenaris.ch/og-standard.png', width: 1200, height: 630, alt: 'Clenaris' },
    ]);
    const mit = seitenMetadaten({ pfad: '/', titel: 'T', beschreibung: 'B', ogBildUrl: '/bild.jpg' }, HERKUNFT);
    assert.equal((mit.twitter as { card?: string }).card, 'summary_large_image');
    assert.deepEqual((mit.openGraph as { images?: unknown }).images, [{ url: 'https://www.clenaris.ch/bild.jpg' }]);
    const ohneHerkunft = seitenMetadaten({ pfad: '/', titel: 'T', beschreibung: 'B' }, '');
    assert.equal((ohneHerkunft.twitter as { card?: string }).card, 'summary');
    assert.equal((ohneHerkunft.openGraph as { images?: unknown }).images, undefined);
  });

  it('verwirft ein Vorschaubild mit javascript:-Adresse und fällt auf das Standardbild zurück', () => {
    const meta = seitenMetadaten({ pfad: '/', titel: 'T', beschreibung: 'B', ogBildUrl: 'javascript:alert(1)' }, HERKUNFT);
    const bilder = JSON.stringify([(meta.openGraph as { images?: unknown }).images, (meta.twitter as { images?: unknown }).images]);
    assert.doesNotMatch(bilder, /javascript/);
    assert.deepEqual((meta.twitter as { images?: unknown }).images, ['https://www.clenaris.ch/og-standard.png']);
  });

  it('setzt noindex mit follow', () => {
    const meta = seitenMetadaten({ pfad: '/', titel: 'T', beschreibung: 'B', noIndex: true }, HERKUNFT);
    assert.deepEqual(meta.robots, { index: false, follow: true });
  });

  it('legt die gepflegte Zeile über den Standardtext; leer heisst Standard', () => {
    const standard = { title: 'Standard', description: 'Standardtext' };
    assert.deepEqual(gepflegteSeo(standard, null), {
      title: 'Standard',
      description: 'Standardtext',
      keywords: [],
      ogImageUrl: null,
      noIndex: false,
    });
    const zeile = { title: '  ', description: 'Eigen', keywords: ['a'], ogImageUrl: null, noIndex: true };
    assert.equal(gepflegteSeo(standard, zeile).title, 'Standard');
    assert.equal(gepflegteSeo(standard, zeile).description, 'Eigen');
  });

  it('schreibt die Stellenbeschreibung ohne Markdown und gekürzt', () => {
    const seo = stellenSeo({ slug: 'x', title: 'Reiniger/in', location: 'Bern', description: `## Aufgabe\n**${'a '.repeat(200)}**` });
    assert.ok(!String(seo.beschreibung).includes('#'));
    assert.ok(!String(seo.beschreibung).includes('*'));
    assert.ok(String(seo.beschreibung).length <= 155);
  });

  it('nimmt für Beiträge den SEO-Titel und sonst den Titel — ein leerer SEO-Titel zählt nicht', () => {
    const seo = beitragsSeo({ slug: 'a', title: 'Titel', excerpt: 'Auszug', seoTitle: '', seoDescription: null, publishedAt: null });
    assert.equal(seo.titel, 'Titel');
    assert.equal(seo.ogTyp, 'article');
  });
});

describe('SEO-Status', () => {
  it('misst den Titel mit dem Zusatz aus der Vorlage', () => {
    const zeile = seoStatus(
      { pfad: '/', bezeichnung: 'Start', quelle: 'Standardtext', titel: 'Kurz', beschreibung: 'x'.repeat(100), strukturierteDaten: [] },
      HERKUNFT,
    );
    assert.equal(zeile.titel, `Kurz${TITEL_ZUSATZ}`);
    assert.equal(zeile.titelLaenge, 4 + TITEL_ZUSATZ.length);
  });

  it('meldet fehlende Beschreibung als Warnung und zu lange Titel als Hinweis', () => {
    const zeile = seoStatus(
      { pfad: '/x', bezeichnung: 'X', quelle: 'Redaktion', titel: 'T'.repeat(70), beschreibung: '', strukturierteDaten: [] },
      HERKUNFT,
    );
    assert.equal(zeile.stufe, 'warnung');
    assert.ok(zeile.befunde.some((b) => b.text === 'Keine Beschreibung' && b.stufe === 'warnung'));
    assert.ok(zeile.befunde.some((b) => b.text.startsWith('Titel länger') && b.stufe === 'hinweis'));
  });

  it('meldet ein verworfenes Vorschaubild', () => {
    const zeile = seoStatus(
      {
        pfad: '/x',
        bezeichnung: 'X',
        quelle: 'Redaktion',
        titel: 'Ein Titel von angemessener Länge',
        beschreibung: 'b'.repeat(120),
        ogBildUrl: 'http://fremd.example/x.jpg',
        strukturierteDaten: [],
      },
      HERKUNFT,
    );
    assert.equal(zeile.ogBild, false);
    assert.ok(zeile.befunde.some((b) => b.text.startsWith('Vorschaubild verworfen')));
  });

  it('ist in Ordnung, wenn alles im Richtwert liegt', () => {
    const zeile = seoStatus(
      {
        pfad: '/x',
        bezeichnung: 'X',
        quelle: 'Redaktion',
        titel: 'Ein Titel von angemessener Länge',
        beschreibung: 'b'.repeat(120),
        ogBildUrl: '/bild.jpg',
        strukturierteDaten: ['WebSite'],
      },
      HERKUNFT,
    );
    assert.equal(zeile.stufe, 'ok');
    assert.equal(zeile.kanonisch, 'https://www.clenaris.ch/x');
    assert.deepEqual(zeile.befunde, []);
  });
});

describe('Strukturierte Daten', () => {
  it('entfernt leere Felder rekursiv statt sie leer auszugeben', () => {
    assert.deepEqual(ohneLeere({ a: '', b: null, c: [], d: { e: undefined }, f: 0, g: 'x', h: [{ i: '' }] }), { f: 0, g: 'x' });
  });

  it('gibt die Firma als HousekeepingService mit @id und echten Stammdaten aus', () => {
    const knoten = firmenKnoten({ firma: FIRMA, herkunft: HERKUNFT, orte: [], leistungen: [] });
    assert.equal(knoten['@type'], FIRMEN_TYP);
    assert.equal(knoten['@id'], 'https://www.clenaris.ch/#organisation');
    assert.equal(knoten.name, 'Clenaris');
    assert.equal(knoten.legalName, 'Clenaris Reinigungen GmbH');
    assert.equal(knoten.telephone, '031 123 45 67');
    assert.deepEqual(knoten.address, {
      '@type': 'PostalAddress',
      streetAddress: 'Aarbergergasse 1',
      postalCode: '3011',
      addressLocality: 'Bern',
      addressRegion: 'BE',
      addressCountry: 'CH',
    });
  });

  it('erfindet keine Preisspanne und kein Logo', () => {
    const knoten = firmenKnoten({ firma: FIRMA, herkunft: HERKUNFT, orte: [], leistungen: [] });
    assert.equal('priceRange' in knoten, false);
    assert.equal('logo' in knoten, false);
    assert.equal('hasOfferCatalog' in knoten, false);
  });

  it('nennt jeden Ort einmal und ohne Postleitzahl an City', () => {
    const knoten = firmenKnoten({
      firma: FIRMA,
      herkunft: HERKUNFT,
      orte: [{ city: 'Bern' }, { city: 'Bern' }, { city: 'Köniz' }],
      leistungen: [],
    });
    assert.deepEqual(knoten.areaServed, [
      { '@type': 'City', name: 'Bern' },
      { '@type': 'City', name: 'Köniz' },
    ]);
  });

  it('nimmt nur offene Tage in die Öffnungszeiten', () => {
    const knoten = firmenKnoten({ firma: FIRMA, herkunft: HERKUNFT, orte: [], leistungen: [] });
    assert.deepEqual(knoten.openingHoursSpecification, [
      { '@type': 'OpeningHoursSpecification', dayOfWeek: 'Monday', opens: '07:00', closes: '18:00' },
    ]);
  });

  it('lässt ContactPoint weg, wenn weder Telefon noch E-Mail da sind', () => {
    const knoten = firmenKnoten({ firma: { ...FIRMA, phone: null, email: '' }, herkunft: HERKUNFT, orte: [], leistungen: [] });
    assert.equal('contactPoint' in knoten, false);
  });

  it('gibt die Website ohne Suchaktion aus — die Seite hat keine Suche', () => {
    const graph = websiteGraph({ firma: FIRMA, herkunft: HERKUNFT, orte: [], leistungen: [{ name: 'Umzug', slug: 'umzug' }] });
    const website = (graph['@graph'] as Record<string, unknown>[]).find((k) => k['@type'] === 'WebSite')!;
    assert.equal('potentialAction' in website, false);
    assert.deepEqual(website.publisher, { '@id': 'https://www.clenaris.ch/#organisation' });
  });

  it('wählt denselben Preis wie die sichtbare Beschriftung — vorher bei Pauschalen den Stundenansatz', () => {
    assert.deepEqual(leistungsPreis({ pricingModel: 'FLAT', hourlyRate: 62, minPrice: 0, basePrice: 450 }), { betrag: 450, art: 'PAUSCHAL' });
    assert.deepEqual(leistungsPreis({ pricingModel: 'PER_HOUR', hourlyRate: 62, minPrice: 300, basePrice: 0 }), { betrag: 62, art: 'STUNDE' });
    assert.deepEqual(leistungsPreis({ pricingModel: 'PER_SQM', hourlyRate: 0, minPrice: 390, basePrice: 0 }), { betrag: 390, art: 'AB_PAUSCHAL' });
    assert.equal(leistungsPreis({ pricingModel: 'QUOTE', hourlyRate: 62, minPrice: 0, basePrice: 0 }), null);
    assert.equal(leistungsPreis({ pricingModel: 'PER_HOUR', hourlyRate: 0, minPrice: 0, basePrice: 0 }), null);
  });

  it('gibt eine Leistung mit provider per @id und ohne Offer bei Offertleistungen aus', () => {
    const knoten = leistungsKnoten({
      leistung: { name: 'Hauswartung', slug: 'hauswartung', beschreibung: 'Text' },
      preis: null,
      herkunft: HERKUNFT,
      orte: [{ city: 'Bern' }],
    });
    assert.equal(knoten['@type'], 'Service');
    assert.deepEqual(knoten.provider, { '@id': 'https://www.clenaris.ch/#organisation' });
    assert.equal('offers' in knoten, false);
    assert.equal(knoten.url, 'https://www.clenaris.ch/leistungen/hauswartung');
  });

  it('gibt den Stundenansatz als UnitPriceSpecification netto aus', () => {
    const knoten = leistungsKnoten({
      leistung: { name: 'Unterhalt', slug: 'unterhalt', beschreibung: null },
      preis: { betrag: 62, art: 'STUNDE' },
      herkunft: HERKUNFT,
      orte: [],
    });
    const angebot = knoten.offers as Record<string, unknown>;
    assert.equal(angebot.price, 62);
    assert.equal(angebot.priceCurrency, 'CHF');
    const spezifikation = angebot.priceSpecification as Record<string, unknown>;
    assert.equal(spezifikation.unitCode, 'HUR');
    assert.equal(spezifikation.valueAddedTaxIncluded, false);
  });

  it('nummeriert Brotkrumen ab 1 mit absoluten Adressen', () => {
    const liste = brotkrumen([{ name: 'Start', pfad: '/' }, { name: 'Leistungen', pfad: '/leistungen' }], HERKUNFT);
    assert.deepEqual(liste.itemListElement, [
      { '@type': 'ListItem', position: 1, name: 'Start', item: 'https://www.clenaris.ch/' },
      { '@type': 'ListItem', position: 2, name: 'Leistungen', item: 'https://www.clenaris.ch/leistungen' },
    ]);
  });

  it('gibt ohne Fragen keine FAQPage und ohne Bewertungen keinen Bewertungsknoten aus', () => {
    assert.equal(faqSeite([]), null);
    assert.equal(bewertungsKnoten({ firma: FIRMA, herkunft: HERKUNFT, durchschnitt: 0, anzahl: 0, bewertungen: [] }), null);
  });

  it('hängt Bewertungen an die Firma (@id) mit den echten Werten', () => {
    const knoten = bewertungsKnoten({
      firma: FIRMA,
      herkunft: HERKUNFT,
      durchschnitt: 4.666,
      anzahl: 3,
      bewertungen: [{ authorName: 'A. B.', rating: 5, title: null, body: 'Gut', createdAt: new Date('2026-05-01T10:00:00Z') }],
    })!;
    assert.equal(knoten['@id'], 'https://www.clenaris.ch/#organisation');
    assert.deepEqual(knoten.aggregateRating, {
      '@type': 'AggregateRating',
      ratingValue: '4.7',
      reviewCount: 3,
      bestRating: 5,
      worstRating: 1,
    });
    const [bewertung] = knoten.review as Record<string, unknown>[];
    assert.equal('name' in bewertung!, false, 'Titel null darf nicht als leerer Name erscheinen');
  });

  it('nimmt den Verlag eines Beitrags aus den Stammdaten statt eines festen Namens', () => {
    const knoten = artikelKnoten({
      beitrag: { slug: 'a', title: 'T', excerpt: null, publishedAt: null, updatedAt: new Date('2026-01-01'), autor: null },
      firma: FIRMA,
      herkunft: HERKUNFT,
    });
    assert.equal((knoten.publisher as Record<string, unknown>).name, 'Clenaris');
    assert.equal((knoten.author as Record<string, unknown>)['@type'], 'Organization');
    assert.equal('datePublished' in knoten, false);
  });

  it('bildet Lehrstelle und Stundenlohn als OTHER ab — vorher PART_TIME', () => {
    const basis = {
      slug: 's',
      title: 'Lernende/r',
      description: '**Text**',
      location: 'Thun',
      publishedAt: null,
      closesAt: null,
      salaryFrom: null,
      salaryTo: null,
    };
    assert.equal(stellenKnoten({ stelle: { ...basis, employmentType: 'APPRENTICE' }, firma: FIRMA, herkunft: HERKUNFT }).employmentType, 'OTHER');
    assert.equal(stellenKnoten({ stelle: { ...basis, employmentType: 'HOURLY' }, firma: FIRMA, herkunft: HERKUNFT }).employmentType, 'OTHER');
    const voll = stellenKnoten({ stelle: { ...basis, employmentType: 'FULL_TIME' }, firma: FIRMA, herkunft: HERKUNFT });
    assert.equal(voll.employmentType, 'FULL_TIME');
    assert.equal(voll.description, 'Text');
    assert.equal('baseSalary' in voll, false);
  });

  it('kennt die Typen je Seite für die Übersicht', () => {
    assert.deepEqual(strukturierteDatenTypen('/kontakt'), [FIRMEN_TYP, 'WebSite']);
    assert.deepEqual(strukturierteDatenTypen('/faq', false), [FIRMEN_TYP, 'WebSite']);
    assert.ok(strukturierteDatenTypen('/faq').includes('FAQPage'));
    assert.ok(strukturierteDatenTypen('/leistungen/x').includes('Service'));
    assert.ok(strukturierteDatenTypen('/blog/x').includes('BreadcrumbList'));
  });

  it('findet alle @type-Werte auch in @graph', () => {
    const graph = websiteGraph({ firma: FIRMA, herkunft: HERKUNFT, orte: [{ city: 'Bern' }], leistungen: [] });
    const typen = typenIn(graph);
    for (const typ of [FIRMEN_TYP, 'WebSite', 'PostalAddress', 'City']) assert.ok(typen.includes(typ), typ);
  });

  it('schreibt einen Firmennamen mit </script> maskiert ins JSON-LD', () => {
    const text = jsonLd(firmenKnoten({ firma: { ...FIRMA, name: 'A</script><script>alert(1)</script>' }, herkunft: HERKUNFT, orte: [], leistungen: [] }));
    assert.ok(!text.includes('</script>'));
    assert.ok(!text.includes('<'));
    // `klartext` hat die Tags schon entfernt; die Maskierung ist die zweite Linie.
    assert.equal(JSON.parse(text).name, 'A alert(1)');
    const roh = jsonLd({ name: '</script> ' });
    assert.ok(!roh.includes('</script>'));
    assert.ok(!roh.includes(' '));
    assert.equal(JSON.parse(roh).name, '</script> ');
  });
});
