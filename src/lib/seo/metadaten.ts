import type { Metadata } from 'next';

/**
 * Suchmaschinen-Metadaten der öffentlichen Website — **eine** Herstellung für
 * alle Seiten (Teil H, 2026-09-28).
 *
 * ---------------------------------------------------------------------------
 *  Warum ein eigenes, reines Modul
 * ---------------------------------------------------------------------------
 *
 * Bis hierher baute jede Seite ihr `Metadata`-Objekt selbst: die
 * redaktionellen Übersichtsseiten über `pageMetadata()`, die Leistungs-,
 * Ratgeber- und Stellenseiten je in ihrem `generateMetadata`, die
 * Rechtstexte als festes Objekt. Das ergab vier Fassungen derselben Regel,
 * und die Prüfung vom 2026-09-28 fand genau die Lücken, die man bei vier
 * Fassungen erwartet:
 *
 *  • Next.js **ersetzt** `openGraph` und `alternates` einer Elternebene,
 *    statt sie zu mischen. Wer im Seitenobjekt `openGraph` setzt, verliert
 *    `og:site_name`, `og:locale` und `og:type` aus dem Wurzellayout; wer es
 *    nicht setzt, erbt `og:url` der Startseite. Beides stand im HTML.
 *  • Das Wurzellayout setzte `canonical: '/'`. Jede Seite ohne eigene Angabe
 *    — Rechnung, Buchung, Anmeldung, alle Applikationsseiten — erklärte damit
 *    die Startseite zu ihrer kanonischen Fassung.
 *  • `twitter:card` stand auf `summary_large_image`, auch wo es gar kein Bild
 *    gab; das ist eine Zusage, die die Karte nicht halten kann.
 *
 * Die Funktion hier ist rein (kein `server-only`, keine Datenbank), damit
 * dieselbe Rechnung zwei Verbraucher hat: die Seiten, die daraus ihre
 * Metadaten machen, und die Übersicht „SEO-Status" in `/admin/seo`, die daraus
 * ihre Befunde ableitet. Zeigte die Übersicht etwas anderes, als die Seite
 * ausliefert, wäre sie wertlos — sie läse eine zweite Wahrheit.
 *
 * ---------------------------------------------------------------------------
 *  Sicherheitsregeln (V-Sicherheit)
 * ---------------------------------------------------------------------------
 *
 *  • **Titel und Beschreibung sind Klartext.** Sie kommen aus der Redaktion
 *    (`SeoMeta`) oder aus Datensätzen (Leistung, Beitrag, Stelle). React
 *    maskiert sie im Attribut ohnehin — aber ein `<b>` im Titel stünde dann
 *    wörtlich als „&lt;b&gt;" im Suchergebnis. `klartext()` entfernt Tags und
 *    Steuerzeichen, bevor der Wert irgendwohin geht.
 *  • **Die kanonische Adresse entsteht nur aus der konfigurierten Herkunft**
 *    (`SEITEN_URL`, Bauzeit) und einem geprüften Pfad — nie aus einem
 *    `Host`-Header und nie aus einem Redaktionsfeld. Ein Pfad, der nicht mit
 *    genau einem `/` beginnt oder ein Schema trägt, fällt weg: lieber keine
 *    kanonische Angabe als eine, die auf einen fremden Host zeigt.
 *  • **Das Vorschaubild ist das einzige frei gepflegte Adressfeld.** Erlaubt
 *    sind ein Pfad dieser Website, eine Adresse der eigenen Herkunft und eine
 *    `https`-Adresse (Objektspeicher). `javascript:`, `data:` und
 *    Klartext-`http` auf fremde Hosts fallen weg.
 */

/** Was das Wurzellayout an jeden Titel hängt (`title.template`). */
export const TITEL_ZUSATZ = ' | Clenaris';
export const TITEL_VORLAGE = `%s${TITEL_ZUSATZ}`;
export const SEITENNAME = 'Clenaris';
export const OG_LOCALE = 'de_CH';

/**
 * Richtwerte, an denen die Übersicht misst. Google kürzt Titel nach etwa
 * 580 Pixeln (rund 60 Zeichen) und Beschreibungen nach etwa 155–160 Zeichen.
 * Es sind Hinweise, keine Grenzen — die Redaktion entscheidet.
 */
export const RICHTWERTE = {
  titelMin: 25,
  titelMax: 60,
  beschreibungMin: 70,
  beschreibungMax: 160,
} as const;

// Steuerzeichen als Zeichencodes gebaut, damit kein Editor sie still in ein
// echtes Zeichen verwandelt (dieselbe Vorsicht wie in `lib/json-ld.ts`).
const STEUERZEICHEN_KLASSE = `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`;
const STEUERZEICHEN = new RegExp(STEUERZEICHEN_KLASSE, 'g');
// Ohne `g`: Ein globaler Ausdruck merkt sich in `.test()` die letzte
// Fundstelle (`lastIndex`), und der nächste Aufruf begänne mitten im Text.
const ENTHAELT_STEUERZEICHEN = new RegExp(STEUERZEICHEN_KLASSE);

/**
 * Freitext zu einzeiligem Klartext: Tags weg, Steuerzeichen weg, Leerraum
 * zusammengezogen. Entitäten werden bewusst **nicht** aufgelöst — „&amp;" aus
 * einem Datensatz ist Text, den jemand so geschrieben hat, und ein Auflösen
 * könnte aus „&lt;script&gt;" erst ein Tag machen.
 */
export function klartext(wert: string | null | undefined): string {
  if (!wert) return '';
  return wert
    .replace(/<[^>]*>/g, ' ')
    .replace(STEUERZEICHEN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Markdown zu Klartext für Beschreibungen (Stelleninserate). Nur die
 * Auszeichnung, die in den Datensätzen tatsächlich vorkommt: Überschriften,
 * Hervorhebung, Listenpunkte, Links. Ein vollständiger Markdown-Parser wäre
 * für eine Meta-Beschreibung übertrieben.
 */
export function markdownKlartext(wert: string | null | undefined): string {
  if (!wert) return '';
  return klartext(
    wert
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/[*_`]{1,3}/g, ''),
  );
}

/** Auf `max` Zeichen kürzen, an einer Wortgrenze, mit Auslassungszeichen. */
export function kuerzen(text: string, max: number): string {
  if (text.length <= max) return text;
  const schnitt = text.slice(0, max - 1);
  const wortgrenze = schnitt.lastIndexOf(' ');
  return `${(wortgrenze > max * 0.6 ? schnitt.slice(0, wortgrenze) : schnitt).trimEnd()}…`;
}

/**
 * Die Herkunft der Website (`https://host[:port]`) aus einer konfigurierten
 * Adresse — oder `null`, wenn sie keine brauchbare http(s)-Adresse ist.
 * Pfad, Abfrage und Zugangsdaten fallen weg: Die kanonische Adresse ist
 * Herkunft plus Seitenpfad, nichts dazwischen.
 */
export function seitenHerkunft(konfiguriert: string): string | null {
  try {
    const url = new URL(konfiguriert);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Ein Seitenpfad, wie er in `canonical` und `og:url` stehen darf — oder
 * `null`. Abfrage und Fragment fallen weg (`/buchen?leistung=x` ist
 * dieselbe Seite wie `/buchen`), ein Schrägstrich am Ende auch (Next leitet
 * `/kontakt/` ohnehin auf `/kontakt` um).
 */
export function kanonischerPfad(pfad: string | null | undefined): string | null {
  if (!pfad) return null;
  const ohneZusatz = pfad.split(/[?#]/, 1)[0] ?? '';
  if (!ohneZusatz.startsWith('/') || ohneZusatz.startsWith('//')) return null;
  if (/[\\\s]/.test(ohneZusatz) || ENTHAELT_STEUERZEICHEN.test(ohneZusatz)) return null;
  if (ohneZusatz.split('/').some((segment) => segment === '..' || segment === '.')) return null;
  if (ohneZusatz === '/') return '/';
  return ohneZusatz.replace(/\/+$/, '') || '/';
}

/** Absolute Adresse einer Seite der eigenen Website — für Sitemap, Canonical, JSON-LD. */
export function absoluteSeitenUrl(pfad: string, herkunft: string): string | null {
  const basis = seitenHerkunft(herkunft);
  const geprueft = kanonischerPfad(pfad);
  if (!basis || !geprueft) return null;
  return geprueft === '/' ? `${basis}/` : `${basis}${geprueft}`;
}

/**
 * Das Vorschaubild als absolute Adresse — oder `null`, wenn es wegfällt.
 *
 * Erlaubt: wurzelrelativer Pfad (eingebaute Ablage `/api/files/…`), Adresse
 * der eigenen Herkunft (auch `http` in einer lokalen Umgebung), jede
 * `https`-Adresse. Alles andere ist entweder gefährlich (`javascript:`,
 * `data:`) oder unzuverlässig (`http` auf fremde Hosts — die Plattformen
 * laden es nicht, und es verrät Besuchenden nichts Gutes über die Seite).
 */
export function sichereBildUrl(url: string | null | undefined, herkunft: string): string | null {
  const wert = url?.trim();
  if (!wert) return null;
  const basis = seitenHerkunft(herkunft);

  if (wert.startsWith('/') && !wert.startsWith('//')) {
    if (!basis || /[\\\s]/.test(wert) || ENTHAELT_STEUERZEICHEN.test(wert)) return null;
    return `${basis}${wert}`;
  }

  try {
    const ziel = new URL(wert);
    if (ziel.username || ziel.password) return null;
    if (ziel.protocol === 'https:') return ziel.toString();
    if (ziel.protocol === 'http:' && basis && ziel.origin === basis) return ziel.toString();
    return null;
  } catch {
    return null;
  }
}

/**
 * Gepflegte Zeile (`SeoMeta`) über den Registertext gelegt — die Regel aus
 * `getPageSeo`: ein leeres Feld heisst „Standardtext". Hier, damit die
 * Übersicht in `/admin/seo` sie nicht nachbaut, sondern dieselbe Funktion
 * aufruft wie die Website.
 */
export function gepflegteSeo(
  standard: { title: string; description: string } | undefined,
  zeile:
    | {
        title: string | null;
        description: string | null;
        keywords: string[] | null;
        ogImageUrl: string | null;
        noIndex: boolean;
      }
    | null
    | undefined,
): { title: string; description: string; keywords: string[]; ogImageUrl: string | null; noIndex: boolean } {
  return {
    title: zeile?.title?.trim() || standard?.title || '',
    description: zeile?.description?.trim() || standard?.description || '',
    keywords: zeile?.keywords ?? [],
    ogImageUrl: zeile?.ogImageUrl ?? null,
    noIndex: zeile?.noIndex ?? false,
  };
}

export interface SeitenSeo {
  /** Pfad der Seite ohne Domain, etwa `/leistungen/umzugsreinigung`. */
  pfad: string;
  titel: string | null | undefined;
  beschreibung: string | null | undefined;
  schluesselwoerter?: string[] | null;
  ogBildUrl?: string | null;
  noIndex?: boolean;
  ogTyp?: 'website' | 'article';
  /** Nur für `ogTyp: 'article'`. */
  veroeffentlicht?: Date | null;
}

/**
 * Das `Metadata`-Objekt einer öffentlichen Seite.
 *
 * `herkunft` ist `SEITEN_URL` — der Aufrufer reicht sie herein, damit diese
 * Datei keine Umgebung liest und in der Einheitsprüfung mit jeder Herkunft
 * rechnen kann.
 */
export function seitenMetadaten(seo: SeitenSeo, herkunft: string): Metadata {
  const titel = klartext(seo.titel);
  const beschreibung = klartext(seo.beschreibung);
  const kanonisch = absoluteSeitenUrl(seo.pfad, herkunft);
  const bild = sichereBildUrl(seo.ogBildUrl, herkunft);
  const schluesselwoerter = (seo.schluesselwoerter ?? []).map(klartext).filter(Boolean);
  const ogTyp = seo.ogTyp ?? 'website';

  return {
    ...(titel ? { title: titel } : {}),
    ...(beschreibung ? { description: beschreibung } : {}),
    ...(schluesselwoerter.length > 0 ? { keywords: schluesselwoerter } : {}),
    ...(kanonisch ? { alternates: { canonical: kanonisch } } : {}),
    openGraph: {
      type: ogTyp,
      locale: OG_LOCALE,
      siteName: SEITENNAME,
      ...(kanonisch ? { url: kanonisch } : {}),
      ...(titel ? { title: titel } : {}),
      ...(beschreibung ? { description: beschreibung } : {}),
      ...(bild ? { images: [{ url: bild }] } : {}),
      ...(ogTyp === 'article' && seo.veroeffentlicht
        ? { publishedTime: seo.veroeffentlicht.toISOString() }
        : {}),
    },
    twitter: {
      // Die grosse Karte nur mit Bild — ohne Bild zeigte sie eine leere Fläche.
      card: bild ? 'summary_large_image' : 'summary',
      ...(titel ? { title: titel } : {}),
      ...(beschreibung ? { description: beschreibung } : {}),
      ...(bild ? { images: [bild] } : {}),
    },
    // `noIndex` wirkt hier *und* über die Sitemap (die solche Seiten
    // weglässt); `follow` bleibt, damit die Links der Seite weiter zählen.
    robots: seo.noIndex
      ? { index: false, follow: true }
      : {
          index: true,
          follow: true,
          googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 },
        },
  };
}

// ---------------------------------------------------------------------------
//  Detailseiten — Angaben aus dem Datensatz
// ---------------------------------------------------------------------------
//
// Leistungs-, Ratgeber- und Stellenseiten ziehen Titel und Beschreibung aus
// ihrem Datensatz (nicht aus `SeoMeta`, Begründung in `/admin/seo`). Die
// Auswahl — eigener SEO-Titel, sonst Name — steht hier, weil die Seite und
// die Übersicht sie beide brauchen.

export function leistungsSeo(leistung: {
  slug: string;
  name: string;
  seoTitle: string | null;
  seoDescription: string | null;
  shortDesc: string | null;
  keywords?: string[] | null;
}): SeitenSeo {
  return {
    pfad: `/leistungen/${leistung.slug}`,
    titel: leistung.seoTitle || leistung.name,
    beschreibung: leistung.seoDescription || leistung.shortDesc,
    schluesselwoerter: leistung.keywords ?? [],
  };
}

export function beitragsSeo(beitrag: {
  slug: string;
  title: string;
  excerpt: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  keywords?: string[] | null;
  publishedAt: Date | null;
}): SeitenSeo {
  return {
    pfad: `/blog/${beitrag.slug}`,
    titel: beitrag.seoTitle || beitrag.title,
    beschreibung: beitrag.seoDescription || beitrag.excerpt,
    schluesselwoerter: beitrag.keywords ?? [],
    ogTyp: 'article',
    veroeffentlicht: beitrag.publishedAt,
  };
}

/**
 * Stelleninserat: Die Beschreibung ist Markdown. Vorher wurde sie roh auf 155
 * Zeichen abgeschnitten — mit `##` und `**` im Suchergebnis und mitten im
 * Wort gekappt.
 */
export function stellenSeo(stelle: {
  slug: string;
  title: string;
  location: string;
  description: string;
}): SeitenSeo {
  return {
    pfad: `/karriere/${stelle.slug}`,
    titel: `${stelle.title} — ${stelle.location}`,
    beschreibung: kuerzen(markdownKlartext(stelle.description), 155),
  };
}

// ---------------------------------------------------------------------------
//  SEO-Status für die Verwaltung (H3)
// ---------------------------------------------------------------------------

export type SeoStufe = 'ok' | 'hinweis' | 'warnung';

export interface SeoStatusEingabe extends SeitenSeo {
  bezeichnung: string;
  /** Woher Titel und Beschreibung stammen — für die Anzeige. */
  quelle: 'Redaktion' | 'Standardtext' | 'Datensatz' | 'Code';
  /** Typen der strukturierten Daten, die die Seite ausgibt. */
  strukturierteDaten: string[];
}

export interface SeoStatusZeile {
  pfad: string;
  bezeichnung: string;
  quelle: SeoStatusEingabe['quelle'];
  /** Der Titel, wie er im `<title>` steht — mit Zusatz aus der Vorlage. */
  titel: string;
  titelLaenge: number;
  beschreibungLaenge: number;
  kanonisch: string | null;
  indexierbar: boolean;
  ogBild: boolean;
  strukturierteDaten: string[];
  befunde: { stufe: Exclude<SeoStufe, 'ok'>; text: string }[];
  stufe: SeoStufe;
}

/**
 * Befunde einer Seite, berechnet aus **demselben** `seitenMetadaten()`, das
 * die Seite ausliefert. Nichts wird geändert; die Übersicht zeigt, die
 * Redaktion entscheidet.
 */
export function seoStatus(eingabe: SeoStatusEingabe, herkunft: string): SeoStatusZeile {
  const meta = seitenMetadaten(eingabe, herkunft);
  const rohTitel = typeof meta.title === 'string' ? meta.title : '';
  const titel = rohTitel ? `${rohTitel}${TITEL_ZUSATZ}` : '';
  const beschreibung = typeof meta.description === 'string' ? meta.description : '';
  const kanonischRoh = meta.alternates?.canonical;
  const kanonisch = typeof kanonischRoh === 'string' ? kanonischRoh : null;
  const bilder = meta.openGraph?.images;
  const ogBild = Array.isArray(bilder) ? bilder.length > 0 : Boolean(bilder);
  const indexierbar = !eingabe.noIndex;

  const befunde: SeoStatusZeile['befunde'] = [];

  if (!rohTitel) befunde.push({ stufe: 'warnung', text: 'Kein Titel' });
  else if (titel.length > RICHTWERTE.titelMax)
    befunde.push({ stufe: 'hinweis', text: `Titel länger als ${RICHTWERTE.titelMax} Zeichen — wird gekürzt` });
  else if (titel.length < RICHTWERTE.titelMin)
    befunde.push({ stufe: 'hinweis', text: `Titel kürzer als ${RICHTWERTE.titelMin} Zeichen` });

  if (!beschreibung) befunde.push({ stufe: 'warnung', text: 'Keine Beschreibung' });
  else if (beschreibung.length > RICHTWERTE.beschreibungMax)
    befunde.push({
      stufe: 'hinweis',
      text: `Beschreibung länger als ${RICHTWERTE.beschreibungMax} Zeichen — wird gekürzt`,
    });
  else if (beschreibung.length < RICHTWERTE.beschreibungMin)
    befunde.push({ stufe: 'hinweis', text: `Beschreibung kürzer als ${RICHTWERTE.beschreibungMin} Zeichen` });

  if (!kanonisch) befunde.push({ stufe: 'warnung', text: 'Keine kanonische Adresse' });
  if (!indexierbar) befunde.push({ stufe: 'hinweis', text: 'Aus dem Index genommen (noindex)' });
  if (eingabe.ogBildUrl?.trim() && !ogBild)
    befunde.push({ stufe: 'warnung', text: 'Vorschaubild verworfen — keine https-Adresse und kein Pfad dieser Website' });
  if (!ogBild) befunde.push({ stufe: 'hinweis', text: 'Kein Vorschaubild für soziale Medien' });

  const stufe: SeoStufe = befunde.some((b) => b.stufe === 'warnung')
    ? 'warnung'
    : befunde.length > 0
      ? 'hinweis'
      : 'ok';

  return {
    pfad: eingabe.pfad,
    bezeichnung: eingabe.bezeichnung,
    quelle: eingabe.quelle,
    titel,
    titelLaenge: titel.length,
    beschreibungLaenge: beschreibung.length,
    kanonisch,
    indexierbar,
    ogBild,
    strukturierteDaten: eingabe.strukturierteDaten,
    befunde,
    stufe,
  };
}
