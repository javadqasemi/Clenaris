import { OG_LOCALE, absoluteSeitenUrl, klartext, markdownKlartext, sichereBildUrl } from './metadaten';

/**
 * Strukturierte Daten (schema.org, JSON-LD) der öffentlichen Website — reine
 * Bauteile von Daten zu Objekten (Teil H, 2026-09-28).
 *
 * ---------------------------------------------------------------------------
 *  Die drei Regeln, die hier gelten
 * ---------------------------------------------------------------------------
 *
 * 1. **Nur echte Daten.** Jeder Wert stammt aus den Firmendaten, dem
 *    Einsatzgebiet oder dem Datensatz der Seite. Vorher standen im Code ein
 *    fester Firmenname („Clenaris Reinigungen GmbH" in vier Dateien), eine
 *    erfundene Preisspanne („CHF 62–95 / Std.") und `addressLocality: 'Bern'`
 *    — Angaben, die nach einer Änderung der Stammdaten still falsch geworden
 *    wären.
 * 2. **Nur, was auf der Seite sichtbar ist.** Google wertet strukturierte
 *    Daten, die dem sichtbaren Inhalt widersprechen oder ihn erfinden, als
 *    Täuschung (Richtlinie „Spammy structured markup"). Deshalb: ein Preis nur
 *    dort, wo die Seite denselben Preis zeigt; Bewertungen nur auf
 *    `/bewertungen`, wo sie stehen; `FAQPage` nur auf `/faq` und nicht noch
 *    einmal auf der Startseite (Google verlangt eine einzige Fundstelle je
 *    Frage).
 * 3. **Leer heisst weglassen.** Ein Feld ohne Wert fällt weg (`ohneLeere`),
 *    statt mit einem Platzhalter gefüllt zu werden.
 *
 * ---------------------------------------------------------------------------
 *  Warum `HousekeepingService`
 * ---------------------------------------------------------------------------
 *
 * schema.org kennt keinen Typ „Reinigungsfirma". `HousekeepingService` ist der
 * spezifischste Untertyp von `LocalBusiness` für Reinigung
 * (LocalBusiness → HomeAndConstructionBusiness → HousekeepingService) und
 * steht auf Googles Liste der unterstützten LocalBusiness-Typen. Der bisher
 * verwendete Obertyp `HomeAndConstructionBusiness` umfasst auch Elektriker,
 * Dachdecker und Umzugsfirmen und sagt deshalb weniger. `ProfessionalService`
 * ist bei schema.org als missverständlich markiert. Da `LocalBusiness` von
 * `Organization` erbt, ist *ein* Knoten zugleich Organisation und lokales
 * Geschäft — ein zweiter, getrennter `Organization`-Knoten wäre eine zweite
 * Firma mit demselben Namen. Alle Seiten verweisen per `@id` auf diesen einen
 * Knoten.
 *
 * Das Schreiben ins HTML übernimmt ausschliesslich
 * `components/marketing/json-ld.tsx` (über `lib/json-ld.ts`, das `<`, `>`,
 * `&`, U+2028 und U+2029 maskiert). Diese Datei baut nur Objekte.
 */

export const FIRMEN_TYP = 'HousekeepingService';

export interface FirmenDaten {
  name: string;
  legalName?: string | null;
  email?: string | null;
  phone?: string | null;
  logoUrl?: string | null;
  address: { street: string; postalCode: string; city: string; canton: string; country: string };
  openingHours: { weekday: number; opensAt: string | null; closesAt: string | null; closed: boolean }[];
}

export type JsonLdObjekt = Record<string, unknown>;

/**
 * Entfernt rekursiv `undefined`, `null`, leere Zeichenketten, leere Listen
 * und leere Objekte. So bleibt „kein Wert" ein fehlendes Feld und wird nie
 * zu `"telephone": ""`, was schema.org-Prüfer als falschen Wert melden.
 */
export function ohneLeere<T>(wert: T): T {
  if (Array.isArray(wert)) {
    return wert.map((eintrag) => ohneLeere(eintrag)).filter((eintrag) => !istLeer(eintrag)) as T;
  }
  if (wert && typeof wert === 'object' && !(wert instanceof Date)) {
    const ergebnis: Record<string, unknown> = {};
    for (const [schluessel, eintrag] of Object.entries(wert as Record<string, unknown>)) {
      const bereinigt = ohneLeere(eintrag);
      if (!istLeer(bereinigt)) ergebnis[schluessel] = bereinigt;
    }
    return ergebnis as T;
  }
  return wert;
}

function istLeer(wert: unknown): boolean {
  if (wert === undefined || wert === null) return true;
  if (typeof wert === 'string') return wert.trim() === '';
  if (typeof wert === 'number') return !Number.isFinite(wert);
  if (Array.isArray(wert)) return wert.length === 0;
  if (typeof wert === 'object') return Object.keys(wert as object).length === 0;
  return false;
}

export function organisationsId(herkunft: string): string {
  return `${absoluteSeitenUrl('/', herkunft) ?? ''}#organisation`;
}

export function webseitenId(herkunft: string): string {
  return `${absoluteSeitenUrl('/', herkunft) ?? ''}#website`;
}

const WOCHENTAGE = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const LAENDER: Record<string, string> = { CH: 'CH', Schweiz: 'CH', Switzerland: 'CH' };

function land(wert: string | null | undefined): string | undefined {
  if (!wert) return undefined;
  return LAENDER[wert.trim()] ?? wert.trim();
}

function postanschrift(firma: FirmenDaten): JsonLdObjekt {
  return {
    '@type': 'PostalAddress',
    streetAddress: klartext(firma.address.street),
    postalCode: klartext(firma.address.postalCode),
    addressLocality: klartext(firma.address.city),
    addressRegion: klartext(firma.address.canton),
    addressCountry: land(firma.address.country),
  };
}

/** Orte des Einsatzgebiets, einmal je Ort. `City` kennt keine Postleitzahl. */
export function einsatzorte(orte: { city: string }[]): JsonLdObjekt[] {
  const namen = Array.from(new Set(orte.map((ort) => klartext(ort.city)).filter(Boolean)));
  return namen.map((name) => ({ '@type': 'City', name }));
}

/**
 * Der Firmenknoten: Organisation und lokales Geschäft in einem. Er steht im
 * Layout jeder öffentlichen Seite — seine Angaben (Adresse, Telefon, E-Mail,
 * Öffnungszeiten, Leistungen, Orte) stehen dort auch sichtbar in der
 * Fusszeile.
 */
export function firmenKnoten(params: {
  firma: FirmenDaten;
  herkunft: string;
  orte: { city: string }[];
  leistungen: { name: string; slug: string }[];
}): JsonLdObjekt {
  const { firma, herkunft, orte, leistungen } = params;
  const telefon = klartext(firma.phone);
  const email = klartext(firma.email);

  return ohneLeere({
    '@type': FIRMEN_TYP,
    '@id': organisationsId(herkunft),
    name: klartext(firma.name),
    legalName: klartext(firma.legalName),
    url: absoluteSeitenUrl('/', herkunft),
    logo: sichereBildUrl(firma.logoUrl, herkunft),
    telephone: telefon,
    email,
    address: postanschrift(firma),
    areaServed: einsatzorte(orte),
    contactPoint:
      telefon || email
        ? [
            {
              '@type': 'ContactPoint',
              contactType: 'customer service',
              telephone: telefon,
              email,
              areaServed: land(firma.address.country),
              availableLanguage: 'de',
            },
          ]
        : [],
    openingHoursSpecification: firma.openingHours
      .filter((stunde) => !stunde.closed && stunde.opensAt && stunde.closesAt)
      .map((stunde) => ({
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: WOCHENTAGE[stunde.weekday],
        opens: stunde.opensAt,
        closes: stunde.closesAt,
      })),
    hasOfferCatalog:
      leistungen.length > 0
        ? {
            '@type': 'OfferCatalog',
            name: 'Reinigungsdienstleistungen',
            itemListElement: leistungen.map((leistung) => ({
              '@type': 'Offer',
              itemOffered: {
                '@type': 'Service',
                name: klartext(leistung.name),
                url: absoluteSeitenUrl(`/leistungen/${leistung.slug}`, herkunft),
              },
            })),
          }
        : undefined,
  });
}

/**
 * Die Website als Ganzes. Bewusst **ohne** `potentialAction`/`SearchAction`:
 * Die öffentliche Seite hat keine Suche, und eine Suchbox im Suchergebnis,
 * die auf nichts führt, ist genau die Art erfundener Angabe, die Regel 1
 * ausschliesst.
 */
export function webseitenKnoten(params: { firma: FirmenDaten; herkunft: string }): JsonLdObjekt {
  return ohneLeere({
    '@type': 'WebSite',
    '@id': webseitenId(params.herkunft),
    url: absoluteSeitenUrl('/', params.herkunft),
    name: klartext(params.firma.name),
    inLanguage: OG_LOCALE.replace('_', '-'),
    publisher: { '@id': organisationsId(params.herkunft) },
  });
}

/** Firmen- und Websiteknoten als ein Graph — ein einziger Skriptblock im Layout. */
export function websiteGraph(params: {
  firma: FirmenDaten;
  herkunft: string;
  orte: { city: string }[];
  leistungen: { name: string; slug: string }[];
}): JsonLdObjekt {
  return {
    '@context': 'https://schema.org',
    '@graph': [firmenKnoten(params), webseitenKnoten(params)],
  };
}

// ---------------------------------------------------------------------------
//  Leistungen
// ---------------------------------------------------------------------------

export type Preismodell = 'PER_HOUR' | 'PER_SQM' | 'PER_UNIT' | 'FLAT' | string;

export interface LeistungsPreis {
  betrag: number;
  art: 'STUNDE' | 'AB_PAUSCHAL' | 'EINHEIT' | 'PAUSCHAL';
}

/**
 * Der Preis, den die Leistungsseite **sichtbar** zeigt — dieselbe Auswahl
 * für die Beschriftung und für das `Offer`. Vorher nahm das JSON-LD
 * `hourlyRate || minPrice`, die Seite aber bei Pauschalen `basePrice`: Eine
 * Pauschalleistung zeigte 450 Franken und meldete Google den Stundenansatz.
 * `null` heisst „Individuelle Offerte" — dann gibt es kein `Offer`.
 */
export function leistungsPreis(leistung: {
  pricingModel: Preismodell;
  hourlyRate: number | null;
  minPrice: number | null;
  basePrice: number | null;
}): LeistungsPreis | null {
  const wert = (zahl: number | null) => (zahl && Number.isFinite(zahl) && zahl > 0 ? zahl : null);
  switch (leistung.pricingModel) {
    case 'PER_HOUR': {
      const betrag = wert(leistung.hourlyRate);
      return betrag === null ? null : { betrag, art: 'STUNDE' };
    }
    case 'PER_SQM': {
      const betrag = wert(leistung.minPrice);
      return betrag === null ? null : { betrag, art: 'AB_PAUSCHAL' };
    }
    case 'PER_UNIT': {
      const betrag = wert(leistung.hourlyRate);
      return betrag === null ? null : { betrag, art: 'EINHEIT' };
    }
    case 'FLAT': {
      const betrag = wert(leistung.basePrice);
      return betrag === null ? null : { betrag, art: 'PAUSCHAL' };
    }
    default:
      return null;
  }
}

function angebot(preis: LeistungsPreis): JsonLdObjekt {
  // Die Seite zeigt „zzgl. 8.1 % MWST" — der Betrag ist netto.
  if (preis.art === 'AB_PAUSCHAL') {
    return {
      '@type': 'Offer',
      priceCurrency: 'CHF',
      priceSpecification: {
        '@type': 'PriceSpecification',
        minPrice: preis.betrag,
        priceCurrency: 'CHF',
        valueAddedTaxIncluded: false,
      },
    };
  }
  return {
    '@type': 'Offer',
    priceCurrency: 'CHF',
    price: preis.betrag,
    priceSpecification: {
      '@type': 'UnitPriceSpecification',
      price: preis.betrag,
      priceCurrency: 'CHF',
      valueAddedTaxIncluded: false,
      ...(preis.art === 'STUNDE' ? { unitCode: 'HUR', unitText: 'Stunde' } : {}),
      ...(preis.art === 'EINHEIT' ? { unitText: 'Einheit' } : {}),
    },
  };
}

/**
 * Eine Leistungsseite (`/leistungen/[slug]`). Kein `aggregateRating`: Die
 * Seite zeigt drei Bewertungen, aber keinen Schnitt — ein Schnitt im JSON-LD
 * wäre eine Zahl, die niemand auf der Seite sieht.
 */
export function leistungsKnoten(params: {
  leistung: { name: string; slug: string; beschreibung: string | null };
  preis: LeistungsPreis | null;
  herkunft: string;
  orte: { city: string }[];
}): JsonLdObjekt {
  const { leistung, preis, herkunft, orte } = params;
  const url = absoluteSeitenUrl(`/leistungen/${leistung.slug}`, herkunft);
  return ohneLeere({
    '@context': 'https://schema.org',
    '@type': 'Service',
    '@id': url ? `${url}#leistung` : undefined,
    name: klartext(leistung.name),
    serviceType: klartext(leistung.name),
    description: klartext(leistung.beschreibung),
    url,
    provider: { '@id': organisationsId(herkunft) },
    areaServed: einsatzorte(orte),
    offers: preis ? angebot(preis) : undefined,
  });
}

/** Brotkrumen — nur, wo die Seite sie sichtbar zeigt oder die Hierarchie eindeutig ist. */
export function brotkrumen(eintraege: { name: string; pfad: string }[], herkunft: string): JsonLdObjekt {
  return ohneLeere({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: eintraege.map((eintrag, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: klartext(eintrag.name),
      item: absoluteSeitenUrl(eintrag.pfad, herkunft),
    })),
  });
}

// ---------------------------------------------------------------------------
//  Fragen, Bewertungen, Beiträge, Stellen
// ---------------------------------------------------------------------------

export function faqSeite(fragen: { question: string; answer: string }[]): JsonLdObjekt | null {
  if (fragen.length === 0) return null;
  return ohneLeere({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: fragen.map((frage) => ({
      '@type': 'Question',
      name: klartext(frage.question),
      acceptedAnswer: { '@type': 'Answer', text: klartext(frage.answer) },
    })),
  });
}

/**
 * Bewertungen auf `/bewertungen` — Schnitt, Anzahl und Einzelbewertungen,
 * genau die Werte, die die Seite zeigt. Der Knoten trägt die `@id` des
 * Firmenknotens: Er ergänzt die Firma um ihre Bewertungen, statt eine zweite
 * Firma anzulegen (vorher: eigener `LocalBusiness`-Knoten mit festem Namen).
 *
 * Hinweis für die Redaktion: Google zeigt für Bewertungen, die ein Geschäft
 * über sich selbst auf der eigenen Website veröffentlicht, keine Sterne im
 * Suchergebnis. Die Angaben sind trotzdem zulässig und bleiben — sie sind
 * wahr und sichtbar.
 */
export function bewertungsKnoten(params: {
  firma: FirmenDaten;
  herkunft: string;
  durchschnitt: number;
  anzahl: number;
  bewertungen: { authorName: string; rating: number; title: string | null; body: string; createdAt: Date }[];
}): JsonLdObjekt | null {
  const { firma, herkunft, durchschnitt, anzahl, bewertungen } = params;
  if (anzahl <= 0) return null;
  return ohneLeere({
    '@context': 'https://schema.org',
    '@type': FIRMEN_TYP,
    '@id': organisationsId(herkunft),
    name: klartext(firma.name),
    aggregateRating: {
      '@type': 'AggregateRating',
      ratingValue: durchschnitt.toFixed(1),
      reviewCount: anzahl,
      bestRating: 5,
      worstRating: 1,
    },
    review: bewertungen.map((bewertung) => ({
      '@type': 'Review',
      author: { '@type': 'Person', name: klartext(bewertung.authorName) },
      datePublished: bewertung.createdAt.toISOString().slice(0, 10),
      name: klartext(bewertung.title),
      reviewBody: klartext(bewertung.body),
      reviewRating: { '@type': 'Rating', ratingValue: bewertung.rating, bestRating: 5, worstRating: 1 },
    })),
  });
}

export function artikelKnoten(params: {
  beitrag: {
    slug: string;
    title: string;
    excerpt: string | null;
    publishedAt: Date | null;
    updatedAt: Date;
    autor: string | null;
  };
  firma: FirmenDaten;
  herkunft: string;
}): JsonLdObjekt {
  const { beitrag, firma, herkunft } = params;
  const url = absoluteSeitenUrl(`/blog/${beitrag.slug}`, herkunft);
  const verlag = {
    '@type': 'Organization',
    '@id': organisationsId(herkunft),
    name: klartext(firma.name),
    logo: sichereBildUrl(firma.logoUrl, herkunft),
  };
  return ohneLeere({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: klartext(beitrag.title),
    description: klartext(beitrag.excerpt),
    datePublished: beitrag.publishedAt?.toISOString(),
    dateModified: beitrag.updatedAt.toISOString(),
    inLanguage: OG_LOCALE.replace('_', '-'),
    mainEntityOfPage: url,
    url,
    // Die Seite nennt die Autorin sichtbar („Von …"); ohne sie ist die Firma
    // die Urheberin — dann dieselbe Firma wie im Layout.
    author: beitrag.autor ? { '@type': 'Person', name: klartext(beitrag.autor) } : verlag,
    publisher: verlag,
  });
}

const ANSTELLUNGSART: Record<string, string> = {
  FULL_TIME: 'FULL_TIME',
  PART_TIME: 'PART_TIME',
  TEMPORARY: 'TEMPORARY',
  CONTRACTOR: 'CONTRACTOR',
  // Stundenlohn und Lehrstelle haben bei schema.org keinen eigenen Wert.
  // Vorher wurde beides zu PART_TIME — eine Lehrstelle ist aber keine
  // Teilzeitstelle. `OTHER` ist die ehrliche Antwort.
  HOURLY: 'OTHER',
  APPRENTICE: 'OTHER',
};

export function stellenKnoten(params: {
  stelle: {
    slug: string;
    title: string;
    description: string;
    location: string;
    employmentType: string;
    publishedAt: Date | null;
    closesAt: Date | null;
    salaryFrom: number | null;
    salaryTo: number | null;
  };
  firma: FirmenDaten;
  herkunft: string;
}): JsonLdObjekt {
  const { stelle, firma, herkunft } = params;
  return ohneLeere({
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: klartext(stelle.title),
    description: markdownKlartext(stelle.description),
    datePosted: stelle.publishedAt?.toISOString(),
    validThrough: stelle.closesAt?.toISOString(),
    employmentType: ANSTELLUNGSART[stelle.employmentType] ?? 'OTHER',
    url: absoluteSeitenUrl(`/karriere/${stelle.slug}`, herkunft),
    hiringOrganization: {
      '@type': 'Organization',
      '@id': organisationsId(herkunft),
      name: klartext(firma.name),
      sameAs: absoluteSeitenUrl('/', herkunft),
      logo: sichereBildUrl(firma.logoUrl, herkunft),
    },
    jobLocation: {
      '@type': 'Place',
      address: {
        '@type': 'PostalAddress',
        addressLocality: klartext(stelle.location),
        addressRegion: klartext(firma.address.canton),
        addressCountry: land(firma.address.country),
      },
    },
    baseSalary:
      stelle.salaryFrom && stelle.salaryFrom > 0
        ? {
            '@type': 'MonetaryAmount',
            currency: 'CHF',
            value: {
              '@type': 'QuantitativeValue',
              minValue: stelle.salaryFrom,
              maxValue: stelle.salaryTo && stelle.salaryTo > 0 ? stelle.salaryTo : undefined,
              unitText: 'MONTH',
            },
          }
        : undefined,
  });
}

// ---------------------------------------------------------------------------
//  Welche Seite welche Typen ausgibt — für die SEO-Übersicht
// ---------------------------------------------------------------------------

/** Auf jeder öffentlichen Seite (Layout). */
export const TYPEN_JEDE_SEITE = [FIRMEN_TYP, 'WebSite'] as const;

/** Seitenspezifische Typen der Übersichtsseiten — nur, wenn Inhalt da ist. */
export const TYPEN_JE_SEITE: Record<string, readonly string[]> = {
  '/faq': ['FAQPage'],
  '/bewertungen': ['AggregateRating', 'Review'],
};

export const TYPEN_LEISTUNG = ['Service', 'BreadcrumbList'] as const;
export const TYPEN_BEITRAG = ['Article', 'BreadcrumbList'] as const;
export const TYPEN_STELLE = ['JobPosting', 'BreadcrumbList'] as const;

/**
 * Die Typen, die eine Seite ausgibt. `mitInhalt` sagt, ob der bedingte Teil
 * (Fragen, Bewertungen) Daten hat — ohne Daten gibt die Seite ihn nicht aus.
 */
export function strukturierteDatenTypen(pfad: string, mitInhalt = true): string[] {
  const basis: string[] = [...TYPEN_JEDE_SEITE];
  if (pfad.startsWith('/leistungen/')) return [...basis, ...TYPEN_LEISTUNG];
  if (pfad.startsWith('/blog/')) return [...basis, ...TYPEN_BEITRAG];
  if (pfad.startsWith('/karriere/')) return [...basis, ...TYPEN_STELLE];
  const zusatz = TYPEN_JE_SEITE[pfad];
  return zusatz && mitInhalt ? [...basis, ...zusatz] : basis;
}

/** Alle `@type`-Werte eines JSON-LD-Objekts, auch in `@graph` und verschachtelt. */
export function typenIn(objekt: unknown): string[] {
  const gefunden = new Set<string>();
  const besuchen = (wert: unknown) => {
    if (Array.isArray(wert)) {
      wert.forEach(besuchen);
      return;
    }
    if (wert && typeof wert === 'object') {
      for (const [schluessel, eintrag] of Object.entries(wert as Record<string, unknown>)) {
        if (schluessel === '@type') {
          (Array.isArray(eintrag) ? eintrag : [eintrag]).forEach((typ) => {
            if (typeof typ === 'string') gefunden.add(typ);
          });
        } else {
          besuchen(eintrag);
        }
      }
    }
  };
  besuchen(objekt);
  return [...gefunden];
}
