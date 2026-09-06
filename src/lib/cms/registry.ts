/**
 * Register der redaktionell pflegbaren Inhalte.
 *
 * Architekturentscheid: Welche Bausteine es gibt, steht im Code — was
 * darinsteht, in der Datenbank.
 *
 * Der Weg über ein Register statt über eine Tabelle je Seite bringt vier
 * Dinge, die ein reiner Schlüssel-Wert-Speicher nicht hätte:
 *
 *  1. **Die Redaktionsmaske erzeugt sich selbst.** Ein neuer Baustein hier
 *     genügt; `/admin/inhalte` zeigt ihn ohne weiteres Zutun mit passendem
 *     Eingabefeld, Beschriftung und Hilfetext.
 *  2. **Ein Tippfehler im Schlüssel ist ein Übersetzungsfehler**, keine leere
 *     Stelle auf der Website — `content('home.hero.titel')` kompiliert nicht.
 *  3. **Die Website bricht nie.** Fehlt die Zeile in der Datenbank, gilt der
 *     hier hinterlegte Text. Das ist zugleich die Auslieferungsfassung.
 *  4. **Grenzen sind erzwingbar.** `maxLength` verhindert, dass jemand einen
 *     Aufsatz in eine Schaltflächenbeschriftung schreibt und das Layout
 *     sprengt.
 *
 * Der hinterlegte Standardtext ist bewusst der *echte* aktuelle Text der
 * Website — so ändert die Einführung des CMS die Seite kein bisschen, bis
 * jemand bewusst etwas anpasst.
 */

export type ContentKind = 'text' | 'richtext' | 'line' | 'list' | 'image' | 'url';

export interface ContentDefinition {
  /** Stabiler Schlüssel. Wird zum Datenbankschlüssel — nie umbenennen. */
  key: string;
  kind: ContentKind;
  /** Beschriftung in der Redaktionsmaske. */
  label: string;
  /** Erklärt, wo der Text erscheint und worauf zu achten ist. */
  help?: string;
  /** Auslieferungsfassung — gilt, solange nichts gepflegt wurde. */
  default: string | string[];
  maxLength?: number;
  /** Höchstzahl Einträge bei `list`. */
  maxItems?: number;
}

export interface ContentGroup {
  id: string;
  label: string;
  description: string;
  items: ContentDefinition[];
}

export const CONTENT_GROUPS: ContentGroup[] = [
  // -------------------------------------------------------------------------
  {
    id: 'home',
    label: 'Startseite',
    description:
      'Der erste Eindruck. Die Überschrift wird in zwei Zeilen gesetzt — der Umbruch steht dort, wo Sie ihn im Feld setzen.',
    items: [
      {
        key: 'home.hero.titleLine1',
        kind: 'line',
        label: 'Überschrift, erste Zeile',
        help: 'Kurz halten. Steht in der grössten Schrift der ganzen Website.',
        default: 'Sauber übergeben.',
        maxLength: 40,
      },
      {
        key: 'home.hero.titleLine2',
        kind: 'line',
        label: 'Überschrift, zweite Zeile',
        default: 'Ohne Diskussion.',
        maxLength: 40,
      },
      {
        key: 'home.hero.lead',
        kind: 'text',
        label: 'Einleitungstext',
        help: 'Zwei bis drei Sätze. Sagt, was Sie tun und warum man Ihnen trauen kann.',
        default:
          'Wir reinigen Wohnungen, Büros und Baustellen im Kanton Bern — mit festangestelltem Team, festen Preisen und einer Abgabegarantie, die diesen Namen verdient. Rechnen Sie den Preis in einer Minute selbst aus.',
        maxLength: 400,
      },
      {
        key: 'home.hero.bullets',
        kind: 'list',
        label: 'Kurzargumente unter dem Rechner',
        help: 'Drei bis vier Stichworte. Je kürzer, desto besser lesbar.',
        default: [
          'Keine versteckten Kosten',
          'Material inklusive',
          'Bis 24 Std. vorher kostenlos stornieren',
        ],
        maxItems: 5,
        maxLength: 60,
      },
      {
        key: 'home.cta.title',
        kind: 'line',
        label: 'Abschluss-Aufruf, Überschrift',
        default: 'Bereit für eine saubere Übergabe?',
        maxLength: 80,
      },
      {
        key: 'home.cta.text',
        kind: 'text',
        label: 'Abschluss-Aufruf, Text',
        default:
          'Preis in einer Minute berechnen, Termin wählen, fertig. Ohne Anmeldung, ohne Rückruf-Warteschlaufe.',
        maxLength: 300,
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'about',
    label: 'Über uns',
    description: 'Auftrag, Anspruch und Haltung des Betriebs.',
    items: [
      {
        key: 'about.intro',
        kind: 'text',
        label: 'Einleitung',
        default:
          'Reinigung ist Handwerk. Kein Preisvergleich. Wir arbeiten mit festangestellten Leuten, die wir selbst ausbilden — und die wiederkommen, weil die Bedingungen stimmen.',
        maxLength: 600,
      },
      {
        key: 'about.mission',
        kind: 'text',
        label: 'Auftrag',
        help: 'Wofür der Betrieb da ist. Ein bis zwei Sätze.',
        default:
          'Wir nehmen Menschen im Kanton Bern die Reinigung ab — verlässlich, zum vereinbarten Preis, mit Leuten, die man beim Namen kennt.',
        maxLength: 400,
      },
      {
        key: 'about.vision',
        kind: 'text',
        label: 'Anspruch',
        help: 'Wohin sich der Betrieb entwickelt.',
        default:
          'Der Reinigungsbetrieb im Kanton Bern, bei dem man nicht nachfragen muss, ob es gut wird — weder als Kundschaft noch als Mitarbeitende.',
        maxLength: 400,
      },
      {
        key: 'about.values',
        kind: 'list',
        label: 'Grundsätze',
        help: 'Was im Alltag tatsächlich gilt. Keine Werbefloskeln.',
        default: [
          'Festanstellung statt Auftragsarbeit — auch wenn es teurer ist.',
          'Der genannte Preis gilt. Dauert es länger, ist das unser Risiko.',
          'Wer putzt, entscheidet mit, wie geputzt wird.',
          'Reklamationen werden nachgebessert, nicht wegdiskutiert.',
        ],
        maxItems: 6,
        maxLength: 160,
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'contact',
    label: 'Kontakt',
    description: 'Texte rund um Erreichbarkeit. Die Nummern selbst stehen unter Stammdaten.',
    items: [
      {
        key: 'contact.lead',
        kind: 'text',
        label: 'Einleitung',
        default:
          'Ob konkrete Anfrage oder erste Frage: Wir antworten innerhalb eines Arbeitstages. Für Dringendes rufen Sie besser an.',
        maxLength: 300,
      },
      {
        key: 'contact.responseTime',
        kind: 'line',
        label: 'Antwortzeit-Zusage',
        help: 'Erscheint in der Kopfzeile, im Kontaktformular und in Menüs.',
        default: 'Antwort innert 24 Stunden',
        maxLength: 60,
      },
      {
        key: 'contact.hoursNote',
        kind: 'line',
        label: 'Erreichbarkeit in Kurzform',
        default: 'Werktags 07–18 Uhr',
        maxLength: 60,
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'footer',
    label: 'Fussbereich',
    description: 'Steht auf jeder Seite der Website.',
    items: [
      {
        key: 'footer.tagline',
        kind: 'text',
        label: 'Kurzbeschreibung',
        default:
          'Reinigung für Privathaushalte, Unternehmen und Liegenschaften im Kanton Bern.',
        maxLength: 200,
      },
      {
        key: 'footer.newsletterTitle',
        kind: 'line',
        label: 'Newsletter-Überschrift',
        default: 'Tipps, die tatsächlich helfen',
        maxLength: 80,
      },
      {
        key: 'footer.newsletterText',
        kind: 'text',
        label: 'Newsletter-Text',
        default:
          'Alle zwei Monate ein kurzer Ratgeber zu Reinigung und Wohnungsabgabe. Kein Verkauf, jederzeit abbestellbar.',
        maxLength: 250,
      },
      {
        key: 'footer.copyrightNote',
        kind: 'line',
        label: 'Zusatz neben dem Urhebervermerk',
        default: 'Gebaut in Bern.',
        maxLength: 60,
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'legal',
    label: 'Rechtliches',
    description:
      'Diese Texte haben rechtliche Wirkung. Änderungen bitte vorher juristisch prüfen lassen.',
    items: [
      {
        key: 'legal.imprintNote',
        kind: 'richtext',
        label: 'Impressum — Zusatzabschnitt',
        help: 'Ergänzt die automatisch erzeugten Firmenangaben. Absätze mit Leerzeile trennen.',
        default:
          'Die Angaben auf dieser Website wurden mit Sorgfalt erstellt. Für Richtigkeit, Vollständigkeit und Aktualität übernehmen wir keine Gewähr.',
        maxLength: 4000,
      },
      {
        key: 'legal.privacyContact',
        kind: 'text',
        label: 'Datenschutz — Ansprechstelle',
        help: 'Wer Auskunftsbegehren entgegennimmt.',
        default:
          'Für Auskunft, Berichtigung und Löschung Ihrer Daten wenden Sie sich an die im Impressum genannte Adresse. Wir antworten innert 30 Tagen.',
        maxLength: 1000,
      },
      {
        key: 'legal.termsIntro',
        kind: 'richtext',
        label: 'AGB — Einleitung',
        default:
          'Diese Bedingungen gelten für alle Verträge über Reinigungsdienstleistungen. Abweichende Bedingungen gelten nur, wenn wir ihnen schriftlich zugestimmt haben.',
        maxLength: 4000,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
//  Abgeleitete Typen und Nachschlagewerk
// ---------------------------------------------------------------------------

export const CONTENT_DEFINITIONS: ContentDefinition[] = CONTENT_GROUPS.flatMap(
  (group) => group.items,
);

const BY_KEY = new Map(CONTENT_DEFINITIONS.map((item) => [item.key, item]));

/** Alle gültigen Schlüssel — die Grundlage der Typprüfung. */
export const CONTENT_KEYS = CONTENT_DEFINITIONS.map((item) => item.key);

export type ContentKey = (typeof CONTENT_DEFINITIONS)[number]['key'];

export function definitionFor(key: string): ContentDefinition | undefined {
  return BY_KEY.get(key);
}

export function isContentKey(key: string): boolean {
  return BY_KEY.has(key);
}

/** Standardwerte als flaches Objekt — die Auslieferungsfassung der Website. */
export function defaultContent(): Record<string, string | string[]> {
  return Object.fromEntries(CONTENT_DEFINITIONS.map((item) => [item.key, item.default]));
}

// ---------------------------------------------------------------------------
//  Suchmaschinen-Angaben je Seite
// ---------------------------------------------------------------------------

export interface SeoPageDefinition {
  path: string;
  label: string;
  title: string;
  description: string;
}

/**
 * Die Seiten, deren Suchmaschinenangaben redaktionell pflegbar sind.
 *
 * Bewusst eine feste Liste: Detailseiten (Leistung, Blogbeitrag, Stelle)
 * ziehen ihre Angaben aus dem jeweiligen Datensatz, nicht von hier — sonst
 * müsste die Redaktion für jeden neuen Beitrag einen Eintrag anlegen.
 */
export const SEO_PAGES: SeoPageDefinition[] = [
  {
    path: '/',
    label: 'Startseite',
    title: 'Reinigungsfirma in Bern — Preis online berechnen',
    description:
      'Unterhaltsreinigung, Umzugsreinigung mit Abgabegarantie, Büro- und Fensterreinigung im Kanton Bern. Preis in 60 Sekunden berechnen und direkt buchen.',
  },
  {
    path: '/leistungen',
    label: 'Leistungen',
    title: 'Unsere Reinigungsleistungen im Kanton Bern',
    description:
      'Unterhalts-, Umzugs-, Büro-, Fenster- und Baureinigung sowie Hauswartung. Alle Leistungen mit Preisrahmen und Umfang.',
  },
  {
    path: '/preise',
    label: 'Preise',
    title: 'Preise und Konditionen',
    description:
      'Transparente Stundenansätze und Pauschalen für Reinigungen im Kanton Bern. Fixpreis, Material inklusive, keine versteckten Kosten.',
  },
  {
    path: '/einsatzgebiet',
    label: 'Einsatzgebiet',
    title: 'Einsatzgebiet im Kanton Bern',
    description:
      'Wir reinigen in Bern, Köniz, Ostermundigen, Muri, Zollikofen, Thun, Burgdorf und Umgebung. Postleitzahl prüfen.',
  },
  {
    path: '/ueber-uns',
    label: 'Über uns',
    title: 'Über uns — Reinigung als Handwerk',
    description:
      'Festangestelltes Team, feste Preise, Abgabegarantie. Wer wir sind und wie wir arbeiten.',
  },
  {
    path: '/kontakt',
    label: 'Kontakt',
    title: 'Kontakt',
    description:
      'Anfrage stellen oder anrufen. Wir antworten an Werktagen innerhalb eines Arbeitstages.',
  },
  {
    path: '/galerie',
    label: 'Galerie',
    title: 'Vorher und nachher',
    description: 'Ergebnisse aus echten Aufträgen — Wohnungsabgaben, Büros und Baustellen.',
  },
  {
    path: '/bewertungen',
    label: 'Bewertungen',
    title: 'Bewertungen unserer Kundschaft',
    description:
      'Was Kundinnen und Kunden über unsere Reinigung im Kanton Bern sagen. Alle Bewertungen stammen von tatsächlichen Aufträgen.',
  },
  {
    path: '/faq',
    label: 'Häufige Fragen',
    title: 'Häufige Fragen',
    description:
      'Ablauf, Schlüsselübergabe, Abgabegarantie, Bezahlung und Stornierung — die Antworten auf einen Blick.',
  },
  {
    path: '/karriere',
    label: 'Karriere',
    title: 'Offene Stellen',
    description:
      'Festanstellung im Reinigungsbetrieb im Kanton Bern. Faire Bedingungen, geregelte Arbeitszeiten, Weiterbildung.',
  },
  {
    path: '/blog',
    label: 'Ratgeber',
    title: 'Ratgeber rund um Reinigung',
    description:
      'Praktische Tipps zu Wohnungsabgabe, Unterhaltsreinigung und Pflege — ohne Werbefloskeln.',
  },
  {
    path: '/offerte',
    label: 'Offerte',
    title: 'Individuelle Offerte anfordern',
    description:
      'Für Hauswartung, grosse Objekte und Sonderfälle erstellen wir eine massgeschneiderte Offerte.',
  },
  {
    path: '/buchen',
    label: 'Buchung',
    title: 'Termin online buchen',
    description:
      'Leistung wählen, Preis sehen, Termin buchen — in unter zwei Minuten, ohne Anmeldung.',
  },
];

const SEO_BY_PATH = new Map(SEO_PAGES.map((page) => [page.path, page]));

export function seoDefinitionFor(path: string): SeoPageDefinition | undefined {
  return SEO_BY_PATH.get(path);
}
