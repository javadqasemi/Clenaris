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
        key: 'home.hero.availability',
        kind: 'line',
        label: 'Verfügbarkeits-Hinweis',
        help: '`{datum}` wird durch den nächsten freien Termin ersetzt. Ohne den Platzhalter steht der Text unverändert da.',
        default: 'Termine ab {datum} frei',
        maxLength: 60,
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
    id: 'home-stats',
    label: 'Startseite — Kennzahlen',
    description:
      'Das Zahlenband unter dem Kopfbereich. Die Zahlen selbst rechnet das System aus dem Betrieb aus; hier stehen nur ihre Beschriftungen.',
    items: [
      {
        key: 'home.stats.areasLabel',
        kind: 'line',
        label: 'Beschriftung — Einsatzgebiet',
        default: 'Postleitzahlen im Einsatzgebiet',
        maxLength: 60,
      },
      {
        key: 'home.stats.jobsLabel',
        kind: 'line',
        label: 'Beschriftung — Einsätze',
        default: 'Abgeschlossene Einsätze',
        maxLength: 60,
      },
      {
        key: 'home.stats.ratingLabel',
        kind: 'line',
        label: 'Beschriftung — Bewertung',
        default: 'Durchschnittliche Bewertung',
        maxLength: 60,
      },
      {
        key: 'home.stats.responseValue',
        kind: 'line',
        label: 'Antwortzeit — Zahl',
        help: 'Die einzige Kennzahl, die nicht gerechnet wird. Sie ist ein Versprechen — ändern Sie sie nur, wenn es auch gilt.',
        default: '24 Std.',
        maxLength: 20,
      },
      {
        key: 'home.stats.responseLabel',
        kind: 'line',
        label: 'Antwortzeit — Beschriftung',
        default: 'Antwort auf jede Offertanfrage',
        maxLength: 60,
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'home-sections',
    label: 'Startseite — Abschnitte',
    description:
      'Überschrift und Einleitung der Abschnitte auf der Startseite. Die Inhalte darunter — Leistungen, Bewertungen, Fragen — stammen aus den jeweiligen Bereichen der Verwaltung.',
    items: [
      {
        key: 'home.services.title',
        kind: 'line',
        label: 'Leistungen — Überschrift',
        default: 'Was wir für Sie tun',
        maxLength: 80,
      },
      {
        key: 'home.services.lead',
        kind: 'text',
        label: 'Leistungen — Einleitung',
        default: 'Sechs Leistungen, klar abgegrenzt. Jede mit einem Preis, den Sie vorher kennen.',
        maxLength: 300,
      },
      {
        key: 'home.services.linkLabel',
        kind: 'line',
        label: 'Leistungen — Verweis',
        default: 'Alle Details',
        maxLength: 40,
      },
      {
        key: 'home.process.title',
        kind: 'line',
        label: 'Ablauf — Überschrift',
        default: 'So läuft es ab',
        maxLength: 80,
      },
      {
        key: 'home.process.lead',
        kind: 'text',
        label: 'Ablauf — Einleitung',
        default:
          'Vier Schritte vom Klick bis zur sauberen Wohnung. Ohne Rückrufschlaufe, ohne Preisverhandlung.',
        maxLength: 300,
      },
      {
        key: 'home.trust.title',
        kind: 'line',
        label: 'Vertrauen — Überschrift',
        default: 'Warum Sie uns den Schlüssel geben können',
        maxLength: 80,
      },
      {
        key: 'home.trust.lead',
        kind: 'text',
        label: 'Vertrauen — Einleitung',
        default:
          'Reinigung heisst, Fremde in die eigenen Räume zu lassen. Das nehmen wir ernst.',
        maxLength: 300,
      },
      {
        key: 'home.reviews.title',
        kind: 'line',
        label: 'Bewertungen — Überschrift',
        default: 'Was Kundinnen und Kunden sagen',
        maxLength: 80,
      },
      {
        key: 'home.reviews.lead',
        kind: 'text',
        label: 'Bewertungen — Einleitung',
        default: 'Bewertungen von Personen, die bei uns gebucht haben — ungefiltert.',
        maxLength: 300,
      },
      {
        key: 'home.reviews.linkLabel',
        kind: 'line',
        label: 'Bewertungen — Verweis',
        default: 'Alle Bewertungen',
        maxLength: 40,
      },
      {
        key: 'home.faq.title',
        kind: 'line',
        label: 'Fragen — Überschrift',
        default: 'Häufige Fragen',
        maxLength: 80,
      },
      {
        key: 'home.faq.lead',
        kind: 'text',
        label: 'Fragen — Einleitung',
        default: 'Was Sie am häufigsten wissen möchten — kurz beantwortet.',
        maxLength: 300,
      },
      {
        key: 'home.faq.linkLabel',
        kind: 'line',
        label: 'Fragen — Verweis',
        default: 'Alle Fragen',
        maxLength: 40,
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'home-process',
    label: 'Startseite — Die vier Schritte',
    description:
      'Der Ablauf vom Klick bis zur Rechnung. Vier Schritte sind gesetzt — die Nummerierung erzeugt die Website selbst.',
    items: [
      {
        key: 'home.process.step1.title',
        kind: 'line',
        label: 'Schritt 1 — Titel',
        default: 'Preis berechnen',
        maxLength: 60,
      },
      {
        key: 'home.process.step1.text',
        kind: 'text',
        label: 'Schritt 1 — Beschreibung',
        default:
          'Leistung, Fläche und Termin eingeben. Der Preis erscheint sofort und ist verbindlich.',
        maxLength: 300,
      },
      {
        key: 'home.process.step2.title',
        kind: 'line',
        label: 'Schritt 2 — Titel',
        default: 'Termin wählen',
        maxLength: 60,
      },
      {
        key: 'home.process.step2.text',
        kind: 'text',
        label: 'Schritt 2 — Beschreibung',
        default:
          'Sie sehen nur Zeitfenster, in denen wir tatsächlich Kapazität haben. Keine Warteschlaufe.',
        maxLength: 300,
      },
      {
        key: 'home.process.step3.title',
        kind: 'line',
        label: 'Schritt 3 — Titel',
        default: 'Wir kommen',
        maxLength: 60,
      },
      {
        key: 'home.process.step3.text',
        kind: 'text',
        label: 'Schritt 3 — Beschreibung',
        default:
          'Ein festes Team, das Sie kennenlernen. Material und Reinigungsmittel bringen wir mit.',
        maxLength: 300,
      },
      {
        key: 'home.process.step4.title',
        kind: 'line',
        label: 'Schritt 4 — Titel',
        default: 'Bericht und Rechnung',
        maxLength: 60,
      },
      {
        key: 'home.process.step4.text',
        kind: 'text',
        label: 'Schritt 4 — Beschreibung',
        default:
          'Nach dem Einsatz erhalten Sie Fotos, die Checkliste und die QR-Rechnung mit 30 Tagen Frist.',
        maxLength: 300,
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'home-trust',
    label: 'Startseite — Vertrauensargumente',
    description:
      'Die vier Zusagen, die erklären, warum man Fremde in die eigenen Räume lässt. Jede davon ist ein Versprechen — bitte nur ändern, was der Betrieb auch hält.',
    items: [
      {
        key: 'home.trust.item1.title',
        kind: 'line',
        label: 'Argument 1 — Titel',
        default: 'Festangestelltes Team',
        maxLength: 60,
      },
      {
        key: 'home.trust.item1.text',
        kind: 'text',
        label: 'Argument 1 — Beschreibung',
        default:
          'Keine Subunternehmen, keine wechselnden Gesichter. Alle Mitarbeitenden sind bei uns angestellt und unfallversichert.',
        maxLength: 300,
      },
      {
        key: 'home.trust.item2.title',
        kind: 'line',
        label: 'Argument 2 — Titel',
        default: 'Versichert bis CHF 5 Mio.',
        maxLength: 60,
      },
      {
        key: 'home.trust.item2.text',
        kind: 'text',
        label: 'Argument 2 — Beschreibung',
        default:
          'Betriebshaftpflicht für Sach- und Personenschäden. Schlüssel werden anonymisiert und protokolliert verwahrt.',
        maxLength: 300,
      },
      {
        key: 'home.trust.item3.title',
        kind: 'line',
        label: 'Argument 3 — Titel',
        default: 'Abgabegarantie',
        maxLength: 60,
      },
      {
        key: 'home.trust.item3.text',
        kind: 'text',
        label: 'Argument 3 — Beschreibung',
        default:
          'Beanstandet die Verwaltung etwas bei der Wohnungsübergabe, kommen wir innert 48 Stunden kostenlos zurück.',
        maxLength: 300,
      },
      {
        key: 'home.trust.item4.title',
        kind: 'line',
        label: 'Argument 4 — Titel',
        default: 'Pünktlich oder Rabatt',
        maxLength: 60,
      },
      {
        key: 'home.trust.item4.text',
        kind: 'text',
        label: 'Argument 4 — Beschreibung',
        default:
          'Sind wir mehr als 30 Minuten zu spät, ziehen wir 20 % vom Rechnungsbetrag ab — ohne Nachfragen.',
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
      {
        key: 'about.values.title',
        kind: 'line',
        label: 'Grundsätze — Überschrift',
        default: 'Wofür wir stehen',
        maxLength: 80,
      },
      {
        key: 'about.values.lead',
        kind: 'text',
        label: 'Grundsätze — Einleitung',
        default:
          'Vier Zusagen, die wir tatsächlich einhalten können — und an denen Sie uns messen dürfen.',
        maxLength: 300,
      },
      {
        key: 'about.team.title',
        kind: 'line',
        label: 'Team — Überschrift',
        default: 'Das Team',
        maxLength: 80,
      },
      {
        key: 'about.team.lead',
        kind: 'text',
        label: 'Team — Einleitung',
        default:
          'Die Personen, die tatsächlich zu Ihnen kommen. Wir stellen sie vor, weil Sie ihnen Ihren Schlüssel anvertrauen.',
        maxLength: 300,
      },
      {
        key: 'about.cta.title',
        kind: 'line',
        label: 'Abschluss-Aufruf, Überschrift',
        default: 'Lernen wir uns kennen',
        maxLength: 80,
      },
      {
        key: 'about.cta.text',
        kind: 'text',
        label: 'Abschluss-Aufruf, Text',
        default:
          'Buchen Sie einen ersten Einsatz — ohne Vertrag, ohne Mindestlaufzeit. Überzeugt es Sie, sprechen wir über einen Rhythmus.',
        maxLength: 300,
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'prices',
    label: 'Preise',
    description:
      'Die Texte der Preisseite. Die Beträge selbst stammen aus dem Leistungskatalog — was hier steht, erklärt sie.',
    items: [
      {
        key: 'prices.hero.title',
        kind: 'line',
        label: 'Überschrift',
        default: 'Preise ohne Kleingedrucktes',
        maxLength: 60,
      },
      {
        key: 'prices.hero.lead',
        kind: 'text',
        label: 'Einleitung',
        default:
          'Alle Ansätze stehen hier. Was Ihr Einsatz konkret kostet, rechnet der Konfigurator in einer Minute aus — und dieser Preis gilt dann auch.',
        maxLength: 400,
      },
      {
        key: 'prices.hero.buttonLabel',
        kind: 'line',
        label: 'Schaltfläche im Kopfbereich',
        default: 'Meinen Preis berechnen',
        maxLength: 40,
      },
      {
        key: 'prices.base.title',
        kind: 'line',
        label: 'Grundpreise — Überschrift',
        default: 'Grundpreise',
        maxLength: 80,
      },
      {
        key: 'prices.base.lead',
        kind: 'text',
        label: 'Grundpreise — Einleitung',
        help: 'Enthält den Mehrwertsteuersatz. Bitte mit den Angaben unter Stammdaten abgleichen.',
        default:
          'Alle Beträge in Schweizer Franken, exklusive 8.1 % Mehrwertsteuer. Material und Reinigungsmittel sind inbegriffen.',
        maxLength: 300,
      },
      {
        key: 'prices.extras.title',
        kind: 'line',
        label: 'Zusatzleistungen — Überschrift',
        default: 'Zusatzleistungen',
        maxLength: 80,
      },
      {
        key: 'prices.extras.lead',
        kind: 'text',
        label: 'Zusatzleistungen — Einleitung',
        default:
          'Einzeln buchbar, jederzeit kombinierbar. Im Buchungsassistenten sehen Sie den Effekt sofort im Total.',
        maxLength: 300,
      },
      {
        key: 'prices.factors.title',
        kind: 'line',
        label: 'Preisfaktoren — Überschrift',
        default: 'Was den Preis beeinflusst',
        maxLength: 80,
      },
      {
        key: 'prices.factors.lead',
        kind: 'text',
        label: 'Preisfaktoren — Einleitung',
        default: 'Damit Sie den berechneten Betrag nachvollziehen können, hier alle Faktoren.',
        maxLength: 300,
      },
      {
        key: 'prices.travel.title',
        kind: 'line',
        label: 'Anfahrt — Überschrift',
        default: 'Anfahrtspauschalen',
        maxLength: 80,
      },
      {
        key: 'prices.travel.lead',
        kind: 'text',
        label: 'Anfahrt — Einleitung',
        default: 'Einmal pro Einsatz, unabhängig von der Dauer. In der Stadt Bern entfällt sie.',
        maxLength: 300,
      },
      {
        key: 'prices.travel.linkLabel',
        kind: 'line',
        label: 'Anfahrt — Verweis',
        default: 'Vollständiges Einsatzgebiet',
        maxLength: 40,
      },
      {
        key: 'prices.payment.title',
        kind: 'line',
        label: 'Zahlung — Überschrift',
        default: 'Zahlung und Konditionen',
        maxLength: 80,
      },
      {
        key: 'prices.cta.title',
        kind: 'line',
        label: 'Abschluss-Aufruf, Überschrift',
        default: 'Ihren Preis in einer Minute',
        maxLength: 80,
      },
      {
        key: 'prices.cta.text',
        kind: 'text',
        label: 'Abschluss-Aufruf, Text',
        default:
          'Leistung wählen, Fläche eingeben, Termin aussuchen. Der Betrag steht sofort — verbindlich.',
        maxLength: 300,
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
    id: 'services',
    label: 'Leistungen',
    description:
      'Rahmentexte der Leistungsseiten. Die Leistungen selbst — Name, Beschreibung, Preis — stehen im Leistungskatalog.',
    items: [
      {
        key: 'services.cta.title',
        kind: 'line',
        label: 'Übersicht — Abschluss-Überschrift',
        default: 'Nicht sicher, was Sie brauchen?',
        maxLength: 80,
      },
      {
        key: 'services.cta.text',
        kind: 'text',
        label: 'Übersicht — Abschluss-Text',
        default:
          'Beschreiben Sie kurz Ihre Situation — wir melden uns innerhalb von 24 Stunden mit einem Vorschlag.',
        maxLength: 300,
      },
      {
        key: 'services.detail.extrasTitle',
        kind: 'line',
        label: 'Detailseite — Zusatzleistungen, Überschrift',
        default: 'Zusatzleistungen',
        maxLength: 80,
      },
      {
        key: 'services.detail.extrasLead',
        kind: 'text',
        label: 'Detailseite — Zusatzleistungen, Einleitung',
        default:
          'Alles optional und einzeln buchbar. Die Preise sehen Sie im Buchungsassistenten sofort.',
        maxLength: 300,
      },
      {
        key: 'services.detail.reviewsLead',
        kind: 'text',
        label: 'Detailseite — Bewertungen, Einleitung',
        default:
          'Rückmeldungen von Kundinnen und Kunden, die genau diese Leistung gebucht haben.',
        maxLength: 300,
      },
      {
        key: 'services.detail.ctaText',
        kind: 'text',
        label: 'Detailseite — Abschluss-Text',
        default: 'Preis in einer Minute berechnen, freies Zeitfenster wählen, fertig.',
        maxLength: 300,
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'area',
    label: 'Einsatzgebiet',
    description: 'Die Ortsliste kommt aus den Stammdaten; hier stehen die Texte darum herum.',
    items: [
      {
        key: 'area.list.title',
        kind: 'line',
        label: 'Ortsliste — Überschrift',
        default: 'Alle Orte im Überblick',
        maxLength: 80,
      },
      {
        key: 'area.list.lead',
        kind: 'text',
        label: 'Ortsliste — Einleitung',
        default:
          'Ihr Ort fehlt? Melden Sie sich trotzdem — bei grösseren Aufträgen fahren wir auch weiter.',
        maxLength: 300,
      },
      {
        key: 'area.cta.title',
        kind: 'line',
        label: 'Abschluss-Aufruf, Überschrift',
        default: 'Kommen wir zu Ihnen?',
        maxLength: 80,
      },
      {
        key: 'area.cta.text',
        kind: 'text',
        label: 'Abschluss-Aufruf, Text',
        default: 'Postleitzahl eingeben, Preis sehen, Termin buchen — alles in einem Durchgang.',
        maxLength: 300,
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'gallery',
    label: 'Galerie',
    description:
      'Die Bilder selbst pflegen Sie direkt in der Vorschau — anklicken genügt. Hier stehen die Texte der Seite.',
    items: [
      {
        key: 'gallery.cta.title',
        kind: 'line',
        label: 'Abschluss-Aufruf, Überschrift',
        default: 'Solche Ergebnisse — bei Ihnen',
        maxLength: 80,
      },
      {
        key: 'gallery.cta.text',
        kind: 'text',
        label: 'Abschluss-Aufruf, Text',
        default:
          'Berechnen Sie den Preis für Ihr Objekt und wählen Sie einen Termin. Nach dem Einsatz erhalten Sie Ihre eigenen Vorher-/Nachher-Fotos.',
        maxLength: 300,
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'reviews',
    label: 'Bewertungen',
    description: 'Die Bewertungen selbst werden unter Bewertungen freigegeben.',
    items: [
      {
        key: 'reviews.cta.title',
        kind: 'line',
        label: 'Abschluss-Aufruf, Überschrift',
        default: 'Überzeugen Sie sich selbst',
        maxLength: 80,
      },
      {
        key: 'reviews.cta.text',
        kind: 'text',
        label: 'Abschluss-Aufruf, Text',
        default:
          'Preis berechnen, Termin wählen, Ergebnis bewerten. Wir freuen uns auf Ihre Rückmeldung.',
        maxLength: 300,
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'careers',
    label: 'Karriere',
    description: 'Die Stellen selbst werden unter Stellen gepflegt.',
    items: [
      {
        key: 'careers.benefits.title',
        kind: 'line',
        label: 'Angebot — Überschrift',
        default: 'Was wir bieten',
        maxLength: 80,
      },
      {
        key: 'careers.openings.title',
        kind: 'line',
        label: 'Stellen — Überschrift',
        default: 'Offene Stellen',
        maxLength: 80,
      },
      {
        key: 'careers.openings.lead',
        kind: 'text',
        label: 'Stellen — Einleitung',
        default:
          'Nichts Passendes dabei? Senden Sie uns trotzdem eine Spontanbewerbung — wir suchen laufend.',
        maxLength: 300,
      },
      {
        key: 'careers.cta.title',
        kind: 'line',
        label: 'Abschluss-Aufruf, Überschrift',
        default: 'Fragen zur Stelle?',
        maxLength: 80,
      },
      {
        key: 'careers.cta.text',
        kind: 'text',
        label: 'Abschluss-Aufruf, Text',
        default:
          'Rufen Sie an und sprechen Sie direkt mit der Betriebsleitung — kein Bewerbungsportal, keine Standardantwort.',
        maxLength: 300,
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'blog',
    label: 'Ratgeber',
    description: 'Rahmentexte der Beitragsseiten. Die Beiträge selbst stehen unter Ratgeber.',
    items: [
      {
        key: 'blog.cta.title',
        kind: 'line',
        label: 'Beitrag — Abschluss-Überschrift',
        default: 'Lieber machen lassen?',
        maxLength: 80,
      },
      {
        key: 'blog.cta.text',
        kind: 'text',
        label: 'Beitrag — Abschluss-Text',
        default:
          'Wir übernehmen die Arbeit — mit festem Team, festem Preis und Abgabegarantie bei Umzügen.',
        maxLength: 300,
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
