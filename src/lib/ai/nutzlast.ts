/**
 * Die Nutzlast der Freitext-Funktionen — erlaubte Felder, geschwärzter Text
 * (F-15, 2026-09-27).
 *
 * ---------------------------------------------------------------------------
 *  Warum ein eigenes Modul
 * ---------------------------------------------------------------------------
 *
 * Zusammenfassen, Übersetzen und der Offertentwurf bauten ihren Prompt inline
 * in `features.ts` und schickten beliebigen Freitext nur durch den
 * Ausgangsfilter des Clients. Was genau das Haus verliess, liess sich nicht
 * prüfen, ohne den Anbieter aufzurufen — `features.ts` und der Client tragen
 * `server-only` und brauchen den Schlüssel.
 *
 * Hier steht deshalb **nur der Bau** der Nutzlast, ohne Abhängigkeit auf den
 * Anbieter: Welche Felder hinausgehen (eine feste Liste, keine durchgereichte
 * Eingabe), und welcher Freitext wie geschwärzt wird. `features.ts` ruft
 * diese Funktionen und reicht das Ergebnis an den Client; die Prüfreihe
 * (`tests/api/ki-nutzlast.test.ts`) ruft dieselben Funktionen und schickt das
 * Ergebnis durch `anfrageFiltern` — genau den Weg, den der Client geht.
 *
 * ---------------------------------------------------------------------------
 *  Je Funktion
 * ---------------------------------------------------------------------------
 *
 *  • **Offertentwurf** — strukturierte Nutzlast aus erlaubten Feldern:
 *    Leistungs-, Objektart und Turnus nur als Katalogschlüssel, Masse als
 *    begrenzte Zahlen, Ort nur als Ortsname, der Stundenansatz aus dem
 *    eigenen Katalog. Der Anfragetext geht geschwärzt hinaus, bekannte Namen
 *    der Anfrage (Person, Firma) als `[NAME]`.
 *  • **Zusammenfassung** — der Text geschwärzt, ohne Rückweg: Eine
 *    Zusammenfassung braucht keinen Alarmcode und keinen Lohnbetrag.
 *  • **Übersetzung** — der Text mit Schutzplatzhaltern und Rückweg: Das
 *    Ergebnis soll vollständig sein, die geschützten Werte kommen im eigenen
 *    Prozess zurück.
 */

import { freitextSchwaerzen, mitSchutzplatzhaltern } from './governance';

export const SWISS_CONTEXT = `Du arbeitest für eine professionelle Reinigungsfirma im Kanton Bern, Schweiz.
Regeln für alle Ausgaben:
- Sprache: Schweizer Hochdeutsch. Niemals "ß" verwenden, immer "ss".
- Anrede: höfliche Sie-Form. Grussformel "Freundliche Grüsse".
- Währung: CHF mit zwei Nachkommastellen. Mehrwertsteuer: 8.1 % (Normalsatz).
- Datumsformat: TT.MM.JJJJ. Uhrzeit im 24-Stunden-Format.
- Ton: sachlich, freundlich, kompetent, ohne Superlative und ohne Emojis.
- Keine verbindlichen Zusagen: Preise und Termine sind Vorschläge, die intern geprüft werden.`;

/** Was an den Anbieter geht: Systemtext aus dem Code, Anfrage aus erlaubten Feldern. */
export interface KiNutzlast {
  system: string;
  prompt: string;
  /** Je Kategorie, wie oft geschwärzt wurde — für das Protokoll, ohne Inhalt. */
  ersetzungen: Record<string, number>;
}

// ---------------------------------------------------------------------------
//  Offertentwurf
// ---------------------------------------------------------------------------

export interface AiQuoteRequest {
  serviceKind: string;
  propertyKind: string;
  squareMeters?: number | null;
  rooms?: number | null;
  windows?: number | null;
  frequency: string;
  customerMessage: string;
  customerType: 'PRIVATE' | 'BUSINESS';
  hourlyRate: number;
  city?: string | null;
  /**
   * Namen, die zur Anfrage gehören (Person, Firma) — sie werden im
   * Anfragetext zu `[NAME]`. Für die Kalkulation braucht es keinen davon.
   */
  bekannteNamen?: (string | null | undefined)[];
}

/**
 * Ein Katalogschlüssel (`RESIDENTIAL_CLEANING`, `APARTMENT`, `WEEKLY`) oder
 * nichts. `propertyKind` und `frequency` sind im Schema freie Zeichenketten
 * bis 40 bzw. 20 Zeichen — als freies Feld wären sie ein zweiter
 * Freitextkanal an der Schwärzung vorbei.
 */
const schluessel = (wert: string | null | undefined): string | null => (wert && /^[A-Z][A-Z_]{1,39}$/.test(wert) ? wert : null);

/** Eine Zahl im Bereich, sonst nichts — keine Zeichenkette, die sich als Zahl ausgibt. */
const zahl = (wert: number | null | undefined, max: number): number | null =>
  typeof wert === 'number' && Number.isFinite(wert) && wert > 0 && wert <= max ? wert : null;

/** Ein Ortsname aus Buchstaben — keine Strasse, keine Hausnummer, kein Freitext. */
const ortsname = (wert: string | null | undefined): string | null => {
  const t = wert?.trim() ?? '';
  return /^[\p{L}][\p{L} .'’-]{0,59}$/u.test(t) ? t : null;
};

export function offertentwurfNutzlast(r: AiQuoteRequest): KiNutzlast {
  const anfrage = freitextSchwaerzen(r.customerMessage.slice(0, 3000), { namen: r.bekannteNamen ?? [] });
  const flaeche = zahl(r.squareMeters, 20_000);
  const zimmer = zahl(r.rooms, 200);
  const fenster = zahl(r.windows, 2000);
  const ort = ortsname(r.city);
  const ansatz = zahl(r.hourlyRate, 1000) ?? 62;
  const details = [
    `Leistungsart: ${schluessel(r.serviceKind) ?? 'unbekannt'}`,
    `Objektart: ${schluessel(r.propertyKind) ?? 'unbekannt'}`,
    flaeche ? `Fläche: ${flaeche} m²` : null,
    zimmer ? `Zimmer: ${zimmer}` : null,
    fenster ? `Fenster: ${fenster}` : null,
    `Turnus: ${schluessel(r.frequency) ?? 'unbekannt'}`,
    `Kundentyp: ${r.customerType === 'BUSINESS' ? 'Geschäftskunde' : 'Privatkunde'}`,
    ort ? `Ort: ${ort}` : null,
    `Interner Stundenansatz: CHF ${ansatz.toFixed(2)}`,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    system: `${SWISS_CONTEXT}

Du erstellst Offertentwürfe für Reinigungsdienstleistungen. Kalkuliere realistisch nach branchenüblichen Leistungswerten:
- Unterhaltsreinigung Wohnung: ca. 1.0–1.4 Minuten pro m²
- Umzugsreinigung mit Abnahmegarantie: ca. 2.0–3.0 Minuten pro m²
- Büroreinigung: ca. 0.8–1.2 Minuten pro m²
- Fensterreinigung: 6–10 Minuten pro Fenster inkl. Rahmen
- Baureinigung (Grobreinigung): ca. 2.5–4.0 Minuten pro m²

Preise sind Nettopreise ohne MWST. Runde Stundenansätze auf ganze Franken.
Halte die Positionen nachvollziehbar: eine Hauptposition, dazu Anfahrt und optionale Zusatzleistungen.
Liste unter "assumptions" jede Annahme auf, die vor dem Versand geprüft werden muss.
Angaben in eckigen Klammern wie [NAME] oder [ZUGANGSCODE] sind vor dem Versand entfernt worden; übernimm sie nicht in den Entwurf.`,
    prompt: `Erstelle einen Offertentwurf.

${details}

Kundenanfrage im Wortlaut (geschwärzt):
"""
${anfrage.text}
"""`,
    ersetzungen: anfrage.ersetzungen,
  };
}

// ---------------------------------------------------------------------------
//  Zusammenfassung
// ---------------------------------------------------------------------------

export function zusammenfassungNutzlast(p: { text: string; focus?: string; maxSentences?: number }): KiNutzlast {
  const text = freitextSchwaerzen(p.text.slice(0, 40_000));
  // Der Fokus ist ebenfalls Freitext der Person — derselbe Weg.
  const fokus = p.focus ? freitextSchwaerzen(p.focus.slice(0, 200)).text : null;
  const saetze = Math.min(15, Math.max(2, Math.trunc(p.maxSentences ?? 6)));
  return {
    system: `${SWISS_CONTEXT}

Du fasst Geschäftsdokumente und Kundenkommunikation zusammen. Nenne nur, was im Text steht.
Struktur: Kernaussage in einem Satz, danach Stichpunkte mit den wichtigsten Fakten und offenen Punkten.
Angaben in eckigen Klammern wie [ZUGANGSCODE] oder [GESUNDHEITSANGABE] sind entfernt worden; nenne sie höchstens als „entfernte Angabe".`,
    prompt: `Fasse den folgenden Text in maximal ${saetze} Sätzen zusammen.${fokus ? ` Fokus: ${fokus}.` : ''}

"""
${text.text}
"""`,
    ersetzungen: text.ersetzungen,
  };
}

// ---------------------------------------------------------------------------
//  Übersetzung
// ---------------------------------------------------------------------------

const LANGUAGE_NAMES: Record<'DE' | 'EN' | 'FR' | 'IT', string> = {
  DE: 'Deutsch (Schweiz)',
  EN: 'Englisch',
  FR: 'Französisch (Schweiz)',
  IT: 'Italienisch (Schweiz)',
};

export function uebersetzungNutzlast(p: {
  text: string;
  targetLocale: 'DE' | 'EN' | 'FR' | 'IT';
  preserveFormatting?: boolean;
}): KiNutzlast & { zurueck: (uebersetzung: string) => string } {
  const geschuetzt = mitSchutzplatzhaltern(p.text.slice(0, 20_000));
  return {
    system: `Du bist Fachübersetzer für die Reinigungsbranche in der Schweiz.
Übersetze präzise und idiomatisch. Behalte Fachbegriffe, Eigennamen, Zahlen, Beträge und Platzhalter der Form {{name}} unverändert bei.
${p.preserveFormatting ? 'Behalte Zeilenumbrüche, Aufzählungszeichen und Markdown-Auszeichnungen exakt bei.' : ''}
Gib ausschliesslich die Übersetzung zurück, ohne Vor- oder Nachbemerkung.`,
    prompt: `Zielsprache: ${LANGUAGE_NAMES[p.targetLocale]}

"""
${geschuetzt.text}
"""`,
    ersetzungen: geschuetzt.ersetzungen,
    zurueck: geschuetzt.zurueck,
  };
}
