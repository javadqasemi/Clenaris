/**
 * Suchmaschinenangaben der Rechtstexte.
 *
 * Diese vier Seiten sind bewusst **nicht** redaktionell pflegbar (sie stehen
 * nicht in `SEO_PAGES`): Ihr Titel ist ihr rechtlicher Name, und eine
 * „Datenschutzerklärung", die in den Suchergebnissen anders heisst, hilft
 * niemandem. Die Angaben standen bis 2026-09-28 als festes `metadata`-Objekt
 * in jeder Seite; hier stehen sie, damit die Seite und die Übersicht
 * „SEO-Status" in `/admin/seo` aus derselben Quelle lesen.
 */
export interface RechtstextSeo {
  pfad: string;
  bezeichnung: string;
  titel: string;
  beschreibung: string;
}

export const RECHTSTEXTE: readonly RechtstextSeo[] = [
  {
    pfad: '/legal/impressum',
    bezeichnung: 'Impressum',
    titel: 'Impressum',
    beschreibung: 'Angaben zur Clenaris Reinigungen GmbH gemäss Schweizer Recht.',
  },
  {
    pfad: '/legal/datenschutz',
    bezeichnung: 'Datenschutz',
    titel: 'Datenschutzerklärung',
    beschreibung:
      'Wie wir Personendaten bearbeiten — nach dem revidierten Schweizer Datenschutzgesetz (DSG) und der DSGVO.',
  },
  {
    pfad: '/legal/agb',
    bezeichnung: 'AGB',
    titel: 'Allgemeine Geschäftsbedingungen',
    beschreibung:
      'AGB der Clenaris Reinigungen GmbH: Vertragsschluss, Preise, Stornierung, Abgabegarantie, Haftung und Gerichtsstand.',
  },
  {
    pfad: '/legal/cookies',
    bezeichnung: 'Cookies',
    titel: 'Cookie-Erklärung',
    beschreibung: 'Welche Cookies wir setzen, wozu, und wie Sie Ihre Einwilligung jederzeit ändern können.',
  },
];

export function rechtstextSeo(pfad: string): { pfad: string; titel: string; beschreibung: string } {
  const eintrag = RECHTSTEXTE.find((seite) => seite.pfad === pfad);
  if (!eintrag) throw new Error(`Kein Rechtstext unter ${pfad} registriert.`);
  return eintrag;
}
