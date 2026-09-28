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
 *
 * Seit dem zweiten F-15-Durchgang (2026-09-27) auch:
 *
 *  • **E-Mail-Entwurf** — Empfänger und Absender als `{{EMPFAENGER}}` /
 *    `{{ABSENDER}}`, jetzt auch als Vor- oder Nachname allein; Zweck und
 *    Kontext mit Schutzplatzhaltern **und Rückweg**, weil der Entwurf einen
 *    Wert aus dem Kontext brauchen kann, ohne dass der Anbieter ihn sieht.
 *  • **Einsatzbericht** — Kunde und Team als Platzhalter mit Rückweg,
 *    Checkliste und Notizen geschwärzt **ohne** Rückweg: Der Bericht geht an
 *    die Kundschaft, ein Alarmcode oder ein Gesundheitssatz aus der internen
 *    Notiz gehört dort ebenso wenig hin wie beim Anbieter.
 *  • **Antwortentwurf zu einer Bewertung** — Sterne als Zahl, Zweck und Ton
 *    aus dem Code, Titel und Text geschwärzt ohne Rückweg (die Antwort ist
 *    öffentlich), Verfasser als `{{EMPFAENGER}}`, übrige bekannte Namen →
 *    `[NAME]`.
 *  • **Führungsassistent** (`biDaten`) — nur Bausteine aus einer festen
 *    Liste mit typisierten Feldern: Kennzahlen als Zahlen, Aufzählungswerte
 *    als Schlüssel, Titel mit ersetzten Namen, Freitext geschwärzt. Kein
 *    Baustein nimmt eine fertige Zeichenkette entgegen — sonst wäre er der
 *    Kanal, durch den die Detailzeile „Keller Treuhand AG — fällt sie weg …"
 *    wieder hinausginge.
 *
 * In allen Freitexten sucht zusätzlich `namenVermuten` Namen, die die Form
 * verrät („Frau Keller", Anrede, Grussformel) — auch dort, wo niemand sie
 * erfasst hat.
 */

import { formatKpiValue } from '../bi/labels';
import { freitextSchwaerzen, mitSchutzplatzhaltern, namenErsetzen, namenVermuten, platzhalterZurueck, summeErsetzungen, type Filterergebnis } from './governance';

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

export function zusammenfassungNutzlast(p: {
  text: string;
  focus?: string;
  maxSentences?: number;
  /** Namen aus der eigenen Datenbank, falls der Aufrufer welche kennt. */
  bekannteNamen?: Iterable<string | null | undefined>;
}): KiNutzlast {
  const roh = p.text.slice(0, 40_000);
  // Eingefügte E-Mails tragen Namen in Anrede und Grussformel; eine
  // Zusammenfassung braucht sie nicht (F-15). Vermutet im ganzen Text, damit
  // „Keller" auch im Fokus ersetzt wird, wenn es oben „Frau Keller" hiess.
  const namen = [...(p.bekannteNamen ?? []), ...namenVermuten(roh), ...(p.focus ? namenVermuten(p.focus) : [])];
  const text = freitextSchwaerzen(roh, { namen });
  // Der Fokus ist ebenfalls Freitext der Person — derselbe Weg.
  const fokus = p.focus ? freitextSchwaerzen(p.focus.slice(0, 200), { namen }).text : null;
  const saetze = Math.min(15, Math.max(2, Math.trunc(p.maxSentences ?? 6)));
  return {
    system: `${SWISS_CONTEXT}

Du fasst Geschäftsdokumente und Kundenkommunikation zusammen. Nenne nur, was im Text steht.
Struktur: Kernaussage in einem Satz, danach Stichpunkte mit den wichtigsten Fakten und offenen Punkten.
Angaben in eckigen Klammern wie [NAME], [ZUGANGSCODE] oder [GESUNDHEITSANGABE] sind entfernt worden; nenne sie höchstens als „entfernte Angabe".`,
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
  bekannteNamen?: Iterable<string | null | undefined>;
}): KiNutzlast & { zurueck: (uebersetzung: string) => string } {
  const roh = p.text.slice(0, 20_000);
  // Vermutete Namen mit Rückweg: „Frau Keller" geht als „Frau
  // {{GESCHUETZT_A}}" hinaus und kommt als „Madame Keller" zurück — die
  // Übersetzung bleibt vollständig, der Name war nie beim Anbieter.
  const geschuetzt = mitSchutzplatzhaltern(roh, { namen: [...(p.bekannteNamen ?? []), ...namenVermuten(roh)] });
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

// ---------------------------------------------------------------------------
//  Personen als Platzhalter — ganzer Name und Namensteile
// ---------------------------------------------------------------------------

const regexMaskieren = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Ganze Wörter, ohne Rücksicht auf Gross-/Kleinschreibung — aber nie innerhalb
 * eines Platzhalters: Eine Person namens „Team" träfe sonst das „TEAM" in
 * `{{TEAM_A}}`. Deshalb zählen `{`, `}` und `_` hier als Wortzeichen.
 *
 * Ebenso nie innerhalb einer E-Mail-Adresse: Diese Ersetzung läuft **vor**
 * der Schwärzung, und aus „anna.keller@example.ch" wurde sonst
 * „{{EMPFAENGER}}.{{EMPFAENGER}}@example.ch" — die Adresse erkannte danach
 * kein Muster mehr, die Domain ging hinaus, und der Rückweg setzte zweimal
 * den ganzen Namen ein. Ein Punkt oder `@` direkt davor, oder direkt danach
 * gefolgt von einem Buchstaben, heisst: Teil einer Adresse.
 */
const alsGanzesWort = (s: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}{_.@])${regexMaskieren(s)}(?![\\p{L}\\p{N}_}]|[.@][\\p{L}\\p{N}])`, 'giu');

/**
 * Personen, deren Namen das Ergebnis braucht (Anrede, Bericht), als
 * Platzhalter mit Rückweg.
 *
 * `mitPlatzhaltern` ersetzte nur die exakte Zeichenkette „Anna Keller"; im
 * Kontext stand aber meist „Frau Keller" oder „Anna", und das ging wörtlich
 * hinaus. Hier werden auch die Namensteile zum Platzhalter der Person — „Frau
 * Keller" wird „Frau {{EMPFAENGER}}" und kommt als „Frau Anna Keller" zurück.
 * Das ist im Ergebnis etwas förmlicher, aber richtig.
 *
 * Ein Teil, den **zwei** Personen tragen (Anna und Beat Keller im selben
 * Team), wird keinem Platzhalter zugeordnet — der Rückweg setzte sonst die
 * falsche Person ein. Er landet in `mehrdeutig` und wird vom Aufrufer als
 * gewöhnlicher Name geschwärzt oder geschützt.
 *
 * Die Schlüssel bestehen nur aus Grossbuchstaben und Unterstrich: Eine
 * Ziffer im Platzhalter (`{{TEAM_1}}`) läse die Code-Regel der Schwärzung
 * nach „Schlüssel bei" als Wert.
 */
function personenPlatzhalter(personen: Record<string, string | null | undefined>) {
  const voll = Object.entries(personen)
    .filter((e): e is [string, string] => /^[A-Z_]{2,30}$/.test(e[0]) && typeof e[1] === 'string' && e[1].trim().length >= 3)
    .map(([k, n]) => [k, n.trim()] as [string, string]);
  const teile = new Map<string, string | null>();
  for (const [k, name] of voll) {
    // Eine Firma wird nicht zerlegt: „Keller" aus „Keller Treuhand AG" ist
    // meist die Kontaktperson, und der Rückweg machte aus „Frau Keller"
    // „Frau Keller Treuhand AG". Solche Teile schwärzt der Aufrufer über
    // seine bekannten Namen.
    if (/(?<![\p{L}])(?:AG|GmbH|SA|Sàrl|Sagl|KG|KLG|Genossenschaft|Stiftung|Verein)(?![\p{L}])|&/u.test(name)) continue;
    for (const teil of name.split(/[\s,]+/)) {
      if (teil.replace(/[.'’-]/g, '').length < 3 || teil.toLowerCase() === name.toLowerCase()) continue;
      const schluessel = teil.toLowerCase();
      const bisher = teile.get(schluessel);
      teile.set(schluessel, bisher === undefined || bisher === k ? k : null);
    }
  }
  const vollSortiert = [...voll].sort((a, b) => b[1].length - a[1].length);
  const teileSortiert = [...teile].sort((a, b) => b[0].length - a[0].length);
  return {
    ersetzen(text: string): string {
      let t = text;
      for (const [k, name] of vollSortiert) t = t.replace(alsGanzesWort(name), `{{${k}}}`);
      for (const [teil, k] of teileSortiert) if (k) t = t.replace(alsGanzesWort(teil), `{{${k}}}`);
      return t;
    },
    mehrdeutig: teileSortiert.filter(([, k]) => k === null).map(([teil]) => teil),
    zurueck: (text: string) => platzhalterZurueck(text, Object.fromEntries(voll)),
  };
}

/** A, B, … — Buchstaben statt Ziffern, aus demselben Grund wie oben. */
const teamSchluessel = (i: number) => `TEAM_${String.fromCharCode(65 + (i % 26))}${i >= 26 ? String.fromCharCode(65 + Math.floor(i / 26) - 1) : ''}`;

/** Eine Bezeichnung aus dem eigenen Katalog: eine Zeile, begrenzt, ohne Steuerzeichen. */
const katalogtext = (wert: string | null | undefined, max = 120): string => (wert ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// ---------------------------------------------------------------------------
//  E-Mail-Entwurf
// ---------------------------------------------------------------------------

export type EmailTone = 'freundlich' | 'sachlich' | 'entschuldigend' | 'bestimmt' | 'werblich';
const TONALITAETEN: readonly EmailTone[] = ['freundlich', 'sachlich', 'entschuldigend', 'bestimmt', 'werblich'];

export function emailEntwurfNutzlast(p: {
  purpose: string;
  recipientName: string;
  context: string;
  tone: EmailTone;
  senderName: string;
  bekannteNamen?: Iterable<string | null | undefined>;
}): KiNutzlast & { zurueck: (entwurf: string) => string } {
  const personen = personenPlatzhalter({ EMPFAENGER: p.recipientName, ABSENDER: p.senderName });
  const zweckRoh = personen.ersetzen(p.purpose.slice(0, 200));
  const kontextRoh = personen.ersetzen(p.context.slice(0, 4000));
  const namen = [...personen.mehrdeutig, ...(p.bekannteNamen ?? []), ...namenVermuten(zweckRoh), ...namenVermuten(kontextRoh)];
  /*
    Mit Rückweg, nicht geschwärzt: Eine Mail an die Hauswartin, die den neuen
    Türcode nennen soll, braucht den Code im Entwurf — aber nicht beim
    Anbieter. Zwei Vorsilben, weil Zweck und Kontext getrennt geschützt
    werden und beide Zählungen bei A beginnen.
  */
  const zweck = mitSchutzplatzhaltern(zweckRoh, { namen, praefix: 'ZWECK' });
  const kontext = mitSchutzplatzhaltern(kontextRoh, { namen, praefix: 'KONTEXT' });
  const ton = TONALITAETEN.includes(p.tone) ? p.tone : 'sachlich';
  return {
    system: `${SWISS_CONTEXT}

Du formulierst E-Mails im Namen der Reinigungsfirma. Halte dich kurz: maximal 200 Wörter.
Struktur: Anrede, Kernaussage im ersten Absatz, Details, klarer nächster Schritt, Grussformel mit dem Namen der absendenden Person.
Erfinde keine Zahlen, Termine oder Zusagen, die nicht im Kontext stehen.
Namen sind durch Platzhalter ersetzt: Verwende {{EMPFAENGER}} für die angeschriebene Person und {{ABSENDER}} für die absendende Person, unverändert.
Weitere Platzhalter der Form {{ZWECK_A}} oder {{KONTEXT_B}} stehen für geschützte Angaben; übernimm sie unverändert, wenn du die Angabe brauchst.`,
    prompt: `Zweck: ${zweck.text}
Empfänger: {{EMPFAENGER}}
Tonalität: ${ton}
Absender: {{ABSENDER}}

Kontext:
"""
${kontext.text}
"""`,
    ersetzungen: summeErsetzungen(zweck.ersetzungen, kontext.ersetzungen),
    // Erst die geschützten Werte, dann die Personen: Ein geschützter Satz kann
    // selbst einen Personenplatzhalter enthalten.
    zurueck: (entwurf) => personen.zurueck(zweck.zurueck(kontext.zurueck(entwurf))),
  };
}

// ---------------------------------------------------------------------------
//  Antwortentwurf zu einer Bewertung
// ---------------------------------------------------------------------------

export function bewertungsantwortNutzlast(p: {
  rating: number;
  title: string | null;
  body: string;
  authorName: string;
  senderName: string;
  /** Konten und Kundschaft der Organisation — Mitarbeitende, die im Text gelobt oder kritisiert werden. */
  bekannteNamen?: Iterable<string | null | undefined>;
}): KiNutzlast & { zurueck: (entwurf: string) => string } {
  const sterne = Math.min(5, Math.max(1, Math.round(Number.isFinite(p.rating) ? p.rating : 3)));
  const personen = personenPlatzhalter({ EMPFAENGER: p.authorName, ABSENDER: p.senderName });
  const titelRoh = personen.ersetzen((p.title ?? '').slice(0, 200));
  const textRoh = personen.ersetzen(p.body.slice(0, 4000));
  const namen = [...personen.mehrdeutig, ...(p.bekannteNamen ?? []), ...namenVermuten(titelRoh), ...namenVermuten(textRoh)];
  // Ohne Rückweg: Die Antwort ist öffentlich. Eine Gesundheitsangabe oder der
  // Name einer Mitarbeiterin aus der Bewertung gehört weder zum Anbieter
  // noch in die öffentliche Antwort.
  const titel = freitextSchwaerzen(titelRoh, { namen });
  const text = freitextSchwaerzen(textRoh, { namen });
  const zweck =
    sterne >= 4
      ? 'Öffentliche Antwort auf eine positive Bewertung — kurz danken, ohne Werbefloskeln.'
      : 'Öffentliche Antwort auf eine kritische Bewertung: danken, Verantwortung übernehmen, konkrete Verbesserung nennen, persönliches Gespräch anbieten. Nicht rechtfertigen, nicht relativieren.';
  return {
    system: `${SWISS_CONTEXT}

Du formulierst öffentliche Antworten der Reinigungsfirma auf Kundenbewertungen. Maximal 120 Wörter, ohne Betreff.
Erfinde keine Zahlen, Termine oder Zusagen, die nicht in der Bewertung stehen.
Verwende {{EMPFAENGER}} für die verfassende Person und {{ABSENDER}} für die antwortende Person, unverändert.
Angaben in eckigen Klammern wie [NAME] oder [GESUNDHEITSANGABE] sind vor dem Versand entfernt worden; übernimm sie nicht in die Antwort.`,
    prompt: `Zweck: ${zweck}
Tonalität: ${sterne >= 4 ? 'freundlich' : 'entschuldigend'}
Verfasser: {{EMPFAENGER}}
Absender: {{ABSENDER}}

Bewertung mit ${sterne} von 5 Sternen.
Titel: ${titel.text.trim() || '—'}
Text:
"""
${text.text}
"""`,
    ersetzungen: summeErsetzungen(titel.ersetzungen, text.ersetzungen),
    zurueck: personen.zurueck,
  };
}

// ---------------------------------------------------------------------------
//  Einsatzbericht
// ---------------------------------------------------------------------------

export interface EinsatzberichtEingabe {
  jobNumber: string;
  customerName: string;
  serviceName: string;
  date: string;
  durationMinutes: number;
  crew: string[];
  checklist: { label: string; done: boolean; note?: string | null }[];
  materials: { name: string; quantity: number; unit: string }[];
  notes?: string | null;
  /**
   * Weitere Namen des Einsatzes, die im Ergebnis nichts zu suchen haben:
   * Vor- und Nachname der Kontaktperson einer Firmenkundschaft, Kontakte.
   * Sie werden zu `[NAME]`.
   */
  bekannteNamen?: Iterable<string | null | undefined>;
}

export function einsatzberichtNutzlast(p: EinsatzberichtEingabe): KiNutzlast & { zurueck: (bericht: string) => string } {
  const personenListe: Record<string, string> = { KUNDE: p.customerName };
  p.crew.forEach((name, i) => {
    personenListe[teamSchluessel(i)] = name;
  });
  const personen = personenPlatzhalter(personenListe);
  const weitere = [...personen.mehrdeutig, ...(p.bekannteNamen ?? [])];
  const summen: Record<string, number>[] = [];
  /*
    Checkliste und Notizen **ohne** Rückweg schwärzen. Die Notiz ist intern
    („Alarmcode 4711 funktionierte nicht", „Beat ging wegen Rückenschmerzen
    früher") — der Bericht geht an die Kundschaft. Mit Rückweg stünde der
    Gesundheitssatz der Mitarbeiterin im Kundenbericht.
  */
  const frei = (t: string, max: number) => {
    const roh = personen.ersetzen(t.slice(0, max));
    const f = freitextSchwaerzen(roh, { namen: [...weitere, ...namenVermuten(roh)] });
    summen.push(f.ersetzungen);
    return f.text;
  };
  const auftrag = /^[A-Z0-9][A-Z0-9-]{1,30}$/.test(p.jobNumber) ? p.jobNumber : '—';
  const datum = /^[\p{L}\d.,\s]{1,40}$/u.test(p.date) ? p.date : '—';
  const stunden = Number.isFinite(p.durationMinutes) && p.durationMinutes >= 0 ? Math.round((p.durationMinutes / 60) * 10) / 10 : null;
  const checkliste = p.checklist
    .slice(0, 80)
    .map((c) => `- [${c.done ? 'x' : ' '}] ${frei(c.label, 200)}${c.note ? ` — ${frei(c.note, 400)}` : ''}`)
    .join('\n');
  const material = p.materials
    .slice(0, 40)
    .map((m) => `- ${Number.isFinite(m.quantity) ? m.quantity : '?'} ${katalogtext(m.unit, 20)} ${katalogtext(m.name)}`)
    .join('\n');
  const notizen = p.notes ? frei(p.notes, 3000) : 'keine';

  return {
    system: `${SWISS_CONTEXT}

Du schreibst Einsatzberichte für Kundinnen und Kunden. Sachlich, vollständig, ohne Werbesprache.
Struktur: Einleitungssatz, ausgeführte Arbeiten als Liste, verwendete Materialien, Bemerkungen, Abschlusssatz.
Erwähne nicht erledigte Checklistenpunkte transparent mit Begründung, sofern eine vorliegt.
Namen sind durch Platzhalter wie {{KUNDE}} oder {{TEAM_A}} ersetzt — verwende sie unverändert.
Angaben in eckigen Klammern wie [NAME], [ZUGANGSCODE] oder [GESUNDHEITSANGABE] sind entfernt worden; übernimm sie nicht in den Bericht.`,
    prompt: `Erstelle den Einsatzbericht.

Auftrag: ${auftrag}
Kunde: {{KUNDE}}
Leistung: ${katalogtext(p.serviceName) || '—'}
Datum: ${datum}
Dauer: ${stunden ?? '—'} Stunden
Team: ${p.crew.map((_, i) => `{{${teamSchluessel(i)}}}`).join(', ') || '—'}

Checkliste:
${checkliste || '- keine'}

Material:
${material || '- keines'}

Interne Notizen: ${notizen}`,
    ersetzungen: summeErsetzungen(...summen),
    zurueck: personen.zurueck,
  };
}

// ---------------------------------------------------------------------------
//  Führungsassistent — Daten nur aus einer Erlaubnisliste
// ---------------------------------------------------------------------------
//
// Der Assistent bekam bisher fertige Zeichenketten aus `bi-assistant.service`,
// zusammengesetzt aus allem, was die Abfragen lieferten. Eine davon war die
// Detailzeile der regelbasierten Auffälligkeit „Klumpenrisiko": Sie nennt die
// grösste Kundschaft **beim Namen** („Keller Treuhand AG — fällt sie weg …"),
// und sie ging mit jeder Zeitraum-Zusammenfassung hinaus. Niemand hatte das
// beschlossen; es stand einfach in der Zeichenkette.
//
// Deshalb nimmt `biDaten` keine Zeichenketten mehr entgegen, sondern
// **Bausteine mit festen Feldern**: Zahlen als Zahlen (formatiert erst hier),
// Status und Kategorien als Schlüssel, Titel aus dem eigenen Katalog mit
// ersetzten Namen, Freitext geschwärzt. Ein Feld, das nicht in der Liste
// steht, gibt es im Typ nicht; ein Wert, der nicht zu seinem Feld passt, wird
// „—". Die Auffälligkeiten gehen mit Titel hinaus — die Detailzeile nur für
// die Regeln, deren Detail nachweislich nur Zahlen enthält.
//
// Aggregiert heisst hier: Kennzahlen, Summen und Anzahlen über die ganze
// Organisation. Zwei Fähigkeiten sind ihrem Wesen nach Freitext —
// Sitzungsprotokoll und Feedback-Auswertung. Sie bleiben, laufen aber durch
// dieselbe Schwärzung wie Zusammenfassen (`biFreitext`).

type Zahl = number | null | undefined;
const endlich = (w: Zahl): w is number => typeof w === 'number' && Number.isFinite(w);
const zahlText = (w: Zahl): string => (endlich(w) ? String(Math.round(w * 100) / 100) : '—');
/** Aufzählungswert aus dem Schema (`STRATEGY`, `IN_PROGRESS`, `PERSONNEL`) — sonst „—". */
const aufzaehlung = (w: string | null | undefined): string => (w && /^[A-Z][A-Z0-9_]{0,39}$/.test(w) ? w : '—');
const monat = (d: Date): string => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 7) : '—');
const tag = (d: Date): string => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : '—');

export interface BiKennzahl {
  gruppe: string;
  label: string;
  schluessel: string;
  einheit: string;
  mehrIstBesser: boolean;
  ziel: number | null;
  verlauf: { periodeStart: Date; wert: number; vorlaeufig: boolean }[];
}

export interface BiGesundheit {
  wert: number | null;
  status: string | null;
  groessterHebel: string | null;
  komponenten: { label: string; wert: number | null }[];
}

export interface BiHinweis {
  schluessel: string;
  schwere: string;
  titel: string;
  detail: string;
}

export interface BiZiel {
  horizont: string;
  ebene: string;
  titel: string;
  status: string;
  fortschritt: number;
  bereich: string | null;
  ergebnisse: { titel: string; start: number; stand: number; ziel: number; fortschritt: number; kommentar: string | null }[];
}

export interface BiRisiko {
  titel: string;
  kategorie: string;
  wahrscheinlichkeit: number;
  auswirkung: number;
  schwere: number;
  status: string;
}

export interface BiWettbewerber {
  name: string;
  region: string | null;
  leistungen: string[];
  preisVon: number | null;
  preisBis: number | null;
  staerken: string | null;
  schwaechen: string | null;
  position: string | null;
}

export interface BiBeobachtung {
  art: string;
  beobachtetAm: Date;
  titel: string;
  text: string;
  auswirkung: string | null;
}

export interface BiBudget {
  name: string;
  geschaeftsjahr: number;
  verstricheneMonate: number;
  monateTotal: number;
  zeilen: { label: string; kategorie: string; plan: number; planBisher: number; ist: number; abweichung: number; abweichungProzent: number | null; hochrechnung: number | null }[];
  total: { planBisher: number; ist: number; abweichung: number };
  ohneBudget: { kategorie: string; ist: number }[];
}

export interface BiBewertung {
  /** Kalendertag, bereits als Text (Zürich, `JJJJ-MM-TT`). */
  datum: string;
  sterne: number;
  leistung: string | null;
  titel: string | null;
  text: string;
  /** Verfasser — geht nie als Feld hinaus, wird nur im Text ersetzt. */
  verfasser: string;
}

/** Die einzigen Überschriften, die zwischen den Bausteinen stehen dürfen. */
export const BI_UEBERSCHRIFTEN = [
  'Kennzahlen:',
  'Auffälligkeiten (regelbasiert):',
  'Offene Risiken:',
  'Bereits erfasste Risiken (nicht wiederholen):',
  'Ziele und Schlüsselergebnisse:',
  'Kennzahlen im Quartal:',
  'Kennzahlen Finanzen:',
  'Leads nach Quelle und Status:',
  'Kennzahlen Vertrieb und Marketing:',
] as const;

export type BiTeil =
  | { art: 'ueberschrift'; text: (typeof BI_UEBERSCHRIFTEN)[number] }
  | { art: 'zeitraum'; von: Date; bis: Date }
  | { art: 'quartal'; label: string }
  | { art: 'gesundheit'; wert: BiGesundheit }
  | { art: 'kennzahlen'; liste: BiKennzahl[] }
  | { art: 'hinweise'; liste: BiHinweis[] }
  | { art: 'ziele'; liste: BiZiel[] }
  | { art: 'risiken'; liste: BiRisiko[] }
  | { art: 'markt'; wettbewerber: BiWettbewerber[]; beobachtungen: BiBeobachtung[] }
  | { art: 'budget'; wert: BiBudget }
  | { art: 'leads'; liste: { quelle: string; status: string; anzahl: number }[] }
  | { art: 'offeneMassnahmen'; anzahl: number }
  | { art: 'bewertungen'; liste: BiBewertung[] };

/**
 * Auffälligkeiten, deren Detailzeile nur Zahlen und Kennzahlnamen enthält
 * (`insight.service.ts`). Eine neue Regel geht nur mit ihrem Titel hinaus,
 * bis jemand ihr Detail geprüft und hier eingetragen hat — `concentration`
 * steht bewusst nicht in der Liste, ihr Detail nennt die Kundschaft.
 */
const HINWEIS_MIT_DETAIL = /^(?:trend-|target-)[a-z][A-Za-z0-9.]*$|^(?:season-revenue|liquidity-overdue|utilization-gap|reviews-due)$/;
const SCHWEREGRADE = new Set(['info', 'warning', 'critical']);

/**
 * Freitext einer BI-Fähigkeit (Frage, Sitzungsnotizen, Kommentar) — geschwärzt
 * ohne Rückweg, bekannte und vermutete Namen → `[NAME]`.
 */
export function biFreitext(text: string, namen: Iterable<string | null | undefined>, max = 20_000): Filterergebnis {
  const roh = text.slice(0, max);
  return freitextSchwaerzen(roh, { namen: [...namen, ...namenVermuten(roh)] });
}

export function biDaten(teile: readonly BiTeil[], optionen: { namen?: Iterable<string | null | undefined> } = {}): Filterergebnis {
  const namen = [...(optionen.namen ?? [])];
  const summen: Record<string, number>[] = [];
  /** Titel und Bezeichnungen aus dem eigenen Katalog: eine Zeile, Namen ersetzt, sonst unverändert. */
  const titel = (t: string | null | undefined, max = 160): string => {
    const r = namenErsetzen(katalogtext(t, max), namen);
    if (r.ersetzt) summen.push({ name: r.ersetzt });
    return r.text;
  };
  /** Freitext innerhalb eines Bausteins: geschwärzt wie in der Zusammenfassung. */
  const frei = (t: string | null | undefined, max: number): string => {
    if (!t) return '';
    const f = biFreitext(t, namen, max);
    summen.push(f.ersetzungen);
    return f.text.replace(/\s+/g, ' ').trim();
  };

  const bloecke = teile.map((teil): string => {
    switch (teil.art) {
      case 'ueberschrift':
        return (BI_UEBERSCHRIFTEN as readonly string[]).includes(teil.text) ? teil.text : '';
      case 'zeitraum':
        return `Zeitraum ${tag(teil.von)} bis ${tag(teil.bis)}`;
      case 'quartal':
        return /^Q[1-4] \d{4}$/.test(teil.label) ? `Quartal ${teil.label}` : 'Quartal —';
      case 'gesundheit': {
        const h = teil.wert;
        if (!endlich(h.wert)) return 'Gesundheitswert: noch nicht berechenbar (Zielwerte fehlen).';
        const hebel = h.groessterHebel ? `Grösster Hebel: ${titel(h.groessterHebel, 200)}. ` : '';
        return `Gesundheitswert ${zahlText(h.wert)}/100 (${aufzaehlung(h.status)}). ${hebel}Komponenten: ${h.komponenten.map((c) => `${titel(c.label, 60)} ${endlich(c.wert) ? zahlText(c.wert) : '—'}`).join(', ')}.`;
      }
      case 'kennzahlen':
        return teil.liste
          .filter((k) => k.verlauf.some((v) => endlich(v.wert)))
          .map((k) => {
            const schluessel = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+){0,4}$/.test(k.schluessel) ? k.schluessel : '—';
            const verlauf = k.verlauf
              .filter((v) => endlich(v.wert))
              .map((v) => `${monat(v.periodeStart)}: ${formatKpiValue(v.wert, k.einheit)}${v.vorlaeufig ? ' (vorläufig)' : ''}`)
              .join('; ');
            const ziel = endlich(k.ziel) ? ` Ziel ${formatKpiValue(k.ziel, k.einheit)}.` : '';
            return `[${titel(k.gruppe, 40)}] ${titel(k.label, 80)} (${schluessel}, ${k.mehrIstBesser ? 'mehr ist besser' : 'weniger ist besser'}).${ziel} Verlauf: ${verlauf}`;
          })
          .join('\n');
      case 'hinweise':
        return teil.liste.length
          ? teil.liste
              .map((h) => {
                const schwere = SCHWEREGRADE.has(h.schwere) ? h.schwere : 'info';
                const detail = HINWEIS_MIT_DETAIL.test(h.schluessel) ? ` ${titel(h.detail, 300)}` : '';
                return `- [${schwere}] ${titel(h.titel, 160)}.${detail}`;
              })
              .join('\n')
          : '- keine Auffälligkeiten aus den Regeln';
      case 'ziele':
        return teil.liste
          .slice(0, 30)
          .map((o) => {
            const ergebnisse = o.ergebnisse
              .map((kr) => {
                // Der Check-in-Kommentar ist Freitext von Mitarbeitenden — er
                // wird geschwärzt wie jeder andere Freitext.
                const kommentar = kr.kommentar ? frei(kr.kommentar, 300) : '';
                return `  · ${titel(kr.titel)}: ${zahlText(kr.start)} → ${zahlText(kr.stand)} (Ziel ${zahlText(kr.ziel)}), ${zahlText(kr.fortschritt)} %${kommentar ? ` — „${kommentar}"` : ''}`;
              })
              .join('\n');
            return `- ${aufzaehlung(o.horizont)} ${aufzaehlung(o.ebene)}: ${titel(o.titel)} [${aufzaehlung(o.status)}, ${zahlText(o.fortschritt)} %]${o.bereich ? ` Bereich ${titel(o.bereich, 60)}` : ''}${ergebnisse ? `\n${ergebnisse}` : ''}`;
          })
          .join('\n');
      case 'risiken':
        return teil.liste.length
          ? teil.liste
              .slice(0, 40)
              .map((r) => `- ${titel(r.titel)} [${aufzaehlung(r.kategorie)}, W${zahlText(r.wahrscheinlichkeit)}×A${zahlText(r.auswirkung)}=${zahlText(r.schwere)}, ${aufzaehlung(r.status)}]`)
              .join('\n')
          : '- Register leer';
      case 'markt': {
        const w = teil.wettbewerber
          .slice(0, 20)
          .map(
            (x) =>
              `- ${titel(x.name, 80)}${x.region ? ` (${titel(x.region, 60)})` : ''}: Leistungen ${x.leistungen.map((l) => titel(l, 60)).join(', ') || '—'}; Preise ${endlich(x.preisVon) ? zahlText(x.preisVon) : '?'}–${endlich(x.preisBis) ? zahlText(x.preisBis) : '?'} CHF; Stärken: ${frei(x.staerken, 300) || '—'}; Schwächen: ${frei(x.schwaechen, 300) || '—'}; Position: ${frei(x.position, 200) || '—'}`,
          )
          .join('\n');
        const b = teil.beobachtungen
          .slice(0, 20)
          .map((x) => `- [${aufzaehlung(x.art)}, ${tag(x.beobachtetAm)}] ${titel(x.titel)}: ${frei(x.text, 400)}${x.auswirkung ? ` Auswirkung: ${frei(x.auswirkung, 300)}` : ''}`)
          .join('\n');
        return `Wettbewerber:\n${w || '- keine erfasst'}\n\nMarktbeobachtungen:\n${b || '- keine erfasst'}`;
      }
      case 'budget': {
        const v = teil.wert;
        return [
          `Budget ${titel(v.name, 80)} ${zahlText(v.geschaeftsjahr)}, ${zahlText(v.verstricheneMonate)} von ${zahlText(v.monateTotal)} Monaten verstrichen.`,
          ...v.zeilen
            .slice(0, 60)
            .map(
              (l) =>
                `- ${titel(l.label, 80)} [${aufzaehlung(l.kategorie)}]: Plan ${zahlText(l.plan)}, anteilig ${zahlText(l.planBisher)}, Ist ${zahlText(l.ist)}, Abweichung ${zahlText(l.abweichung)} (${zahlText(l.abweichungProzent)} %), Hochrechnung ${zahlText(l.hochrechnung)}`,
            ),
          `Total: anteilig ${zahlText(v.total.planBisher)}, Ist ${zahlText(v.total.ist)}, Abweichung ${zahlText(v.total.abweichung)}`,
          v.ohneBudget.length ? `Ohne Budgetzeile: ${v.ohneBudget.map((u) => `${aufzaehlung(u.kategorie)} ${zahlText(u.ist)}`).join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('\n');
      }
      case 'leads':
        return teil.liste
          .map((l) => `- ${aufzaehlung(l.quelle)}/${aufzaehlung(l.status)}: ${zahlText(l.anzahl)}`)
          .join('\n');
      case 'offeneMassnahmen':
        return `Offene Massnahmen: ${zahlText(teil.anzahl)}`;
      case 'bewertungen':
        return teil.liste
          .slice(0, 200)
          .map((r, i) => {
            // Ohne Verfasser als Feld — und im Text ersetzt, was die Datenbank
            // als Namen kennt, samt dem Verfasser dieser Bewertung (der nicht
            // immer ein Konto oder eine Kundenakte hat).
            const eigene = [...namen, r.verfasser, ...r.verfasser.split(/\s+/)];
            const f = freitextSchwaerzen(`${r.titel ? `${r.titel} — ` : ''}${r.text.slice(0, 600)}`, { namen: [...eigene, ...namenVermuten(r.text)] });
            summen.push(f.ersetzungen);
            const datum = /^\d{4}-\d{2}-\d{2}$/.test(r.datum) ? r.datum : '—';
            const leistung = r.leistung ? ` ${aufzaehlung(r.leistung)}` : '';
            return `#${i + 1} ${datum} ${zahlText(Math.min(5, Math.max(1, Math.round(r.sterne))))}/5${leistung}: ${f.text.replace(/\s+/g, ' ').trim()}`;
          })
          .join('\n');
    }
  });

  return { text: bloecke.filter((b) => b !== '').join('\n\n'), ersetzungen: summeErsetzungen(...summen) };
}
