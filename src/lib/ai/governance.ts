/**
 * KI-Governance: Datensparsamkeit vor dem Versand (Wave 15, 2026-09-23).
 *
 * ---------------------------------------------------------------------------
 *  Warum ein zentraler Ausgangsfilter
 * ---------------------------------------------------------------------------
 *
 * Die KI-Funktionen schicken Text an einen Auftragsverarbeiter im Ausland.
 * Einzelne Funktionen waren bereits sparsam (die Personaldisposition
 * pseudonymisiert Personen und Einsätze), andere nicht: Zusammenfassen und
 * Übersetzen reichten beliebigen Text durch, der E-Mail-Entwurf den Klarnamen
 * der Empfängerin, der Einsatzbericht Kunden- und Teamnamen, die
 * Routenplanung Datenbankkennungen.
 *
 * Eine Regel je Funktion wäre die Regel, die bei der nächsten Funktion
 * fehlt. Deshalb zwei Stufen:
 *
 *  1. **Ausgangsfilter** (`ausgangsfilter`) im KI-Client selbst — jede
 *     Anfrage läuft hindurch, ohne dass der Aufrufer daran denken muss. Er
 *     ersetzt, was sich sicher erkennen lässt und für keine der Aufgaben
 *     nötig ist: E-Mail-Adressen, Telefonnummern, IBAN, AHV-Nummern,
 *     Datenbankkennungen.
 *  2. **Platzhalter** (`mitPlatzhaltern` / `platzhalterZurueck`) dort, wo ein
 *     Name im Ergebnis stehen muss (Anrede im E-Mail-Entwurf, Kunde im
 *     Einsatzbericht): Das Modell sieht `{{EMPFAENGER}}`, das Ergebnis bekommt
 *     den Namen erst danach, im eigenen Prozess.
 *  3. **Schwärzung nach Zusammenhang** (`freitextSchwaerzen`,
 *     `mitSchutzplatzhaltern`, 2026-09-27) für Funktionen, die beliebigen
 *     Freitext senden: Zugangs- und Alarmcodes, Passwörter, Lohnbeträge und
 *     ganze Sätze mit Gesundheitsangaben. Aufgerufen beim Bau der Nutzlast
 *     (`nutzlast.ts`), zusätzlich zu Stufe 1.
 *
 * **Was das nicht ist:** Anonymisierung. Namen im Freitext, Adressen für die
 * Routenplanung und fachliche Merkmale bleiben erkennbar. Die Übermittlung
 * wird sparsam, nicht anonym — so steht es auch in `docs/KI_GOVERNANCE.md`.
 *
 * Ohne `server-only` und ohne Abhängigkeiten, damit die Prüfreihe die Regeln
 * direkt prüfen kann (`tests/api/ki-governance.test.ts`).
 */

export interface Filterergebnis {
  text: string;
  /** Je Kategorie, wie oft ersetzt wurde — für das Protokoll, ohne Inhalt. */
  ersetzungen: Record<string, number>;
}

const MUSTER: ReadonlyArray<{ art: string; muster: RegExp; ersatz: string }> = [
  // Reihenfolge ist wichtig: AHV und IBAN vor den Telefonnummern (Ziffernfolgen).
  { art: 'ahv', muster: /\b756[.\s]?\d{4}[.\s]?\d{4}[.\s]?\d{2}\b/g, ersatz: '[AHV-NUMMER]' },
  { art: 'iban', muster: /\b[A-Z]{2}\d{2}(?:[\s]?[0-9A-Z]{4}){3,7}(?:[\s]?[0-9A-Z]{1,4})?\b/g, ersatz: '[IBAN]' },
  { art: 'email', muster: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, ersatz: '[E-MAIL]' },
  // Schweizer Nummern: +41 / 0041 / 0xx, mit Leerzeichen, Punkten oder Bindestrichen.
  { art: 'telefon', muster: /(?:\+41|0041|\b0)[\s.-]?\d{2}[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}\b/g, ersatz: '[TELEFON]' },
  // Datenbankkennungen (cuid): bedeutungslos für das Modell, aber ein Schlüssel in unsere Daten.
  { art: 'kennung', muster: /\bc[a-z0-9]{24}\b/g, ersatz: '[KENNUNG]' },
];

/** Erkennbare Kontakt-, Bank-, Sozialversicherungs- und Datenbankkennungen ersetzen. */
export function ausgangsfilter(text: string): Filterergebnis {
  let ergebnis = text;
  const ersetzungen: Record<string, number> = {};
  for (const { art, muster, ersatz } of MUSTER) {
    ergebnis = ergebnis.replace(muster, () => {
      ersetzungen[art] = (ersetzungen[art] ?? 0) + 1;
      return ersatz;
    });
  }
  return { text: ergebnis, ersetzungen };
}

export function summeErsetzungen(...ergebnisse: Record<string, number>[]): Record<string, number> {
  const summe: Record<string, number> = {};
  for (const e of ergebnisse) for (const [k, v] of Object.entries(e)) summe[k] = (summe[k] ?? 0) + v;
  return summe;
}

/**
 * Namen durch Platzhalter ersetzen, bevor ein Text das Haus verlässt.
 * Längere Namen zuerst, damit „Anna Keller" nicht als „Anna" plus Rest
 * ersetzt wird.
 */
export function mitPlatzhaltern(text: string, namen: Record<string, string | null | undefined>): string {
  const eintraege = Object.entries(namen)
    .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].trim().length >= 2)
    .sort((a, b) => b[1].length - a[1].length);
  let ergebnis = text;
  for (const [platzhalter, name] of eintraege) {
    ergebnis = ergebnis.split(name).join(`{{${platzhalter}}}`);
  }
  return ergebnis;
}

/**
 * Bekannte Personennamen in Freitext ersetzen — ohne Rückweg (2026-09-27).
 *
 * Für Texte, in denen ein Name im *Ergebnis* nichts zu suchen hat:
 * Bewertungstexte, Check-in-Kommentare, Sitzungsnotizen. „Frau Keller war
 * super" wird zu „Frau [NAME] war super" — für eine Stimmungsauswertung
 * genügt das, und der Name verlässt das Haus nicht.
 *
 * **Bekannt heisst: aus der eigenen Datenbank** — Vor- und Nachnamen der
 * Konten, der Mitarbeitenden und der Kundschaft, die der Aufrufer mitgibt.
 * Ein Name, den niemand erfasst hat („der Hauswart, Herr Brunner"), bleibt
 * stehen; einen beliebigen Namen im Freitext sicher zu erkennen, gelingt
 * keinem Muster. Deshalb heisst die Übermittlung sparsam, nicht anonym.
 *
 * Ganze Wörter, ohne Rücksicht auf Gross-/Kleinschreibung, längere Namen
 * zuerst. Namen unter drei Zeichen werden übergangen — „Li" oder „Al" träfen
 * sonst Wortteile in jedem zweiten Satz.
 */
export function namenErsetzen(text: string, namen: Iterable<string | null | undefined>): { text: string; ersetzt: number } {
  const liste = [...new Set([...namen].map((n) => n?.trim() ?? '').filter((n) => n.length >= 3))].sort((a, b) => b.length - a.length);
  let ergebnis = text;
  let ersetzt = 0;
  for (const name of liste) {
    const maskiert = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // `\b` kennt keine Umlaute; die Grenze wird deshalb über Nicht-Buchstaben
    // beschrieben, damit „Müller" auch vor einem Komma endet.
    const muster = new RegExp(`(?<![\\p{L}\\p{N}])${maskiert}(?![\\p{L}\\p{N}])`, 'giu');
    ergebnis = ergebnis.replace(muster, () => {
      ersetzt += 1;
      return '[NAME]';
    });
  }
  return { text: ergebnis, ersetzt };
}

// ---------------------------------------------------------------------------
//  Stärkere Schwärzung für Freitext (F-15, 2026-09-27)
// ---------------------------------------------------------------------------
//
// Der Ausgangsfilter oben ersetzt, was sich **an seiner Form** erkennen lässt.
// Zusammenfassen, Übersetzen und der Offertentwurf schicken aber beliebigen
// Freitext — eingefügte E-Mails, Notizen, Kundenanfragen —, und darin stand
// ungehindert, was keine Form hat: „Alarmcode 4711#", „Schlüsselsafe 2580",
// „Monatslohn CHF 5'200", „ist seit Montag krankgeschrieben". Nichts davon
// braucht eine Zusammenfassung oder eine Übersetzung, um ihre Aufgabe zu
// erfüllen, und Gesundheitsangaben sind nach Art. 5 lit. c DSG besonders
// schützenswert.
//
// Diese Regeln erkennen solche Angaben **an ihrem Zusammenhang**: ein
// Schlüsselwort (Alarm, Code, PIN, Safe, Passwort, Lohn, krank …) und der
// Wert, der ihm folgt. Das ist grober als ein Muster und schwärzt im Zweifel
// mehr — ein zu Unrecht geschwärzter Satz kostet eine Nachbesserung im
// Entwurf, ein zu Unrecht übermittelter Alarmcode einen Vorfall. Anonym wird
// der Text dadurch trotzdem nicht; das bleibt in `docs/KI_GOVERNANCE.md`
// so benannt.
//
// Die Regeln laufen **zusätzlich** zum Ausgangsfilter des Clients, nicht an
// seiner Stelle: Die Funktionen, die Freitext schicken, rufen sie beim Bau
// ihrer Nutzlast (`nutzlast.ts`), und der Client filtert danach wie bisher.

/**
 * Schlüsselwörter, nach denen ein Zugangswert folgt: Codes und PINs jeder Art
 * (`Alarmcode`, `Türcode`, `Tor-PIN`), Alarm, Schlüssel(-safe, -box),
 * Tresor, Kombination.
 */
const ZUGANGS_WORT = String.raw`\p{L}*(?:code|pin)s?|alarm\p{L}*|schl(?:ü|ue)ssel\p{L}*|safe|tresor|kombination|zahlenschloss`;

/**
 * Wort, dann bis zu 30 Zeichen ohne Ziffer und ohne Satzende, dann ein Wert
 * mit mindestens einer Ziffer und drei Zeichen (`4711`, `4711#`, `A-2580`,
 * `1-2-3-4`). Die Ziffer ist die Bedingung, die „Code ist bekannt" oder
 * „Schlüssel beim Hauswart" stehen lässt; drei Zeichen lassen „2. Stock" und
 * „07:30" stehen.
 */
const ZUGANGSCODE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(${ZUGANGS_WORT})(?![\p{L}])([^\n\d.!?;]{0,30}?)(?<![A-Za-z])([#*]?[A-Za-z]{0,4}\d[\dA-Za-z#*\-]{2,15})`,
  'giu',
);

/**
 * Passwörter haben keine Form — nach dem Wort wird das nächste Wort
 * geschwärzt, gleich wie es aussieht („WLAN-Passwort: Sommer2026!").
 */
const PASSWORT = /(?<![\p{L}])(\p{L}*(?:passwort|passwörter|passwoerter|kennwort|password))(?![\p{L}])([^\S\n]*(?:[:=]|ist|lautet)?[^\S\n]*)([^\s]{3,64})/giu;

/** Lohnwörter — ohne „gehalten", „belohnen": Die Wortgrenzen sind Absicht. */
const LOHN_WORT = String.raw`\p{L}*lohn(?:s|es|e)?|lohn\p{L}+|l(?:ö|oe)hne|\p{L}*gehalt(?:s|es)?|sal(?:ä|ae|a)r\p{L}*|verdien\p{L}*|gratifikation|bonus`;
const BETRAG = String.raw`(?:(?:CHF|SFr\.|Fr\.)[^\S\n]?)?\d[\d'’]*(?:[.,]\d{1,2}|\.[–-])?`;

/** „Monatslohn CHF 5'200.–", „verdient 4800" — das Wort vor dem Betrag. */
const LOHN_NACH_WORT = new RegExp(String.raw`(?<![\p{L}])(${LOHN_WORT})(?![\p{L}])([^\n\d.!?;]{0,30}?)(${BETRAG})`, 'giu');
/** „CHF 5'200 Bruttolohn" — der Betrag vor dem Wort, nur mit Währung. */
const LOHN_VOR_WORT = new RegExp(String.raw`(?:CHF|SFr\.|Fr\.)[^\S\n]?\d[\d'’]*(?:[.,]\d{1,2}|\.[–-])?(?=[^\n\d.!?;]{0,20}?(?<![\p{L}])(?:${LOHN_WORT})(?![\p{L}]))`, 'giu');

/**
 * Gesundheit und Abwesenheitsgründe. Geschwärzt wird der **ganze Satz**, nicht
 * das Wort: „Frau X ist seit Montag [GESUNDHEIT] wegen Rücken" verriete fast
 * alles. Wortanfänge, damit „krankgeschrieben", „Krankheit", „erkrankt"
 * greifen. Bewusst **nicht** in der Liste: Orte wie Spital, Klinik, Arztpraxis
 * — Arztpraxen sind Kundschaft einer Reinigungsfirma, und ihr Offertentwurf
 * braucht den Satz „Praxisreinigung, 200 m²".
 */
const GESUNDHEIT =
  /(?<![\p{L}])(?:krank|erkrank|arztzeugnis|arztbesuch|arzttermin|ärztlich|aerztlich|diagnos|schwanger|mutterschaft|wochenbett|depressi|burn-?out|psychisch|psychiatr|psychotherap|medikament|operiert|behinder|invalid|unfall|verunfall|verletz|allergi|asthma|chemo|krebs|diabet|arbeitsunfähig|arbeitsunfaehig|gesundheitlich)/iu;

const KENNZEICHEN: Record<string, string> = {
  ahv: '[AHV-NUMMER]',
  iban: '[IBAN]',
  email: '[E-MAIL]',
  telefon: '[TELEFON]',
  kennung: '[KENNUNG]',
  gesundheit: '[GESUNDHEITSANGABE]',
  zugangscode: '[ZUGANGSCODE]',
  lohn: '[LOHNBETRAG]',
  name: '[NAME]',
};

type Ersetzer = (art: string, original: string) => string;

/**
 * Die Regeln, einmal — für die Schwärzung ohne Rückweg und die Platzhalter
 * mit Rückweg gleich. Zwei Kopien derselben Liste liefen auseinander.
 *
 * Reihenfolge: zuerst die Formmuster (eine IBAN enthält Ziffern, die sonst als
 * „Code" gälten), dann ganze Gesundheitssätze, dann Werte nach Schlüsselwort,
 * zuletzt bekannte Namen.
 */
function regelnAnwenden(text: string, ersetze: Ersetzer, namen: Iterable<string | null | undefined> = []): string {
  let t = text;
  for (const { art, muster } of MUSTER) t = t.replace(muster, (m) => ersetze(art, m));
  t = t
    .split(/(?<=[.!?])(?=\s)|(?=\n)/)
    .map((teil) => {
      if (!GESUNDHEIT.test(teil)) return teil;
      const [, vor, kern, nach] = /^(\s*)([\s\S]*?)(\s*)$/.exec(teil)!;
      return `${vor}${ersetze('gesundheit', kern!)}${nach}`;
    })
    .join('');
  t = t.replace(PASSWORT, (_m, wort: string, luecke: string, wert: string) => `${wort}${luecke}${ersetze('zugangscode', wert)}`);
  t = t.replace(ZUGANGSCODE, (_m, wort: string, luecke: string, wert: string) => `${wort}${luecke}${ersetze('zugangscode', wert)}`);
  t = t.replace(LOHN_NACH_WORT, (_m, wort: string, luecke: string, betrag: string) => `${wort}${luecke}${ersetze('lohn', betrag)}`);
  t = t.replace(LOHN_VOR_WORT, (m) => ersetze('lohn', m));
  const liste = [...new Set([...namen].map((n) => n?.trim() ?? '').filter((n) => n.length >= 3))].sort((a, b) => b.length - a.length);
  for (const name of liste) {
    const maskiert = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`(?<![\\p{L}\\p{N}])${maskiert}(?![\\p{L}\\p{N}])`, 'giu'), (m) => ersetze('name', m));
  }
  return t;
}

/**
 * Freitext für eine Funktion schwärzen, deren Ergebnis die Werte nicht
 * braucht (Zusammenfassung, Offertentwurf) — ohne Rückweg.
 */
export function freitextSchwaerzen(text: string, optionen: { namen?: Iterable<string | null | undefined> } = {}): Filterergebnis {
  const ersetzungen: Record<string, number> = {};
  const ergebnis = regelnAnwenden(
    text,
    (art) => {
      ersetzungen[art] = (ersetzungen[art] ?? 0) + 1;
      return KENNZEICHEN[art] ?? '[ENTFERNT]';
    },
    optionen.namen,
  );
  return { text: ergebnis, ersetzungen };
}

/** A, B, … Z, AA, AB … — ohne Ziffern, damit keine Regel einen Platzhalter selbst als „Code" oder „Betrag" liest. */
function buchstabenIndex(n: number): string {
  let s = '';
  let i = n;
  do {
    s = String.fromCharCode(65 + (i % 26)) + s;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return s;
}

/**
 * Freitext mit **Rückweg** schützen — für die Übersetzung (F-15).
 *
 * Eine Übersetzung muss den Text als Ganzes zurückgeben; eine Schwärzung ohne
 * Rückweg hätte den Alarmcode im übersetzten Kundenbrief durch „[ZUGANGSCODE]"
 * ersetzt, und die Person hätte ihn von Hand wieder eintragen müssen. Deshalb
 * geht jeder erkannte Wert als `{{GESCHUETZT_A}}` hinaus — die Übersetzung
 * lässt Platzhalter dieser Form unverändert, so steht es in ihrem Systemtext —
 * und kommt erst im eigenen Prozess zurück. Ein geschützter Gesundheitssatz
 * bleibt damit **unübersetzt** im Ergebnis stehen; das ist der Preis, und er
 * ist kleiner als der Satz beim Anbieter.
 */
export function mitSchutzplatzhaltern(
  text: string,
  optionen: { namen?: Iterable<string | null | undefined> } = {},
): Filterergebnis & { zurueck: (ergebnis: string) => string } {
  const originale: string[] = [];
  const ersetzungen: Record<string, number> = {};
  const ergebnis = regelnAnwenden(
    text,
    (art, original) => {
      ersetzungen[art] = (ersetzungen[art] ?? 0) + 1;
      originale.push(original);
      return `{{GESCHUETZT_${buchstabenIndex(originale.length - 1)}}}`;
    },
    optionen.namen,
  );
  return {
    text: ergebnis,
    ersetzungen,
    // Rückwärts: Eine spätere Regel kann einen früheren Platzhalter
    // eingeschlossen haben („Passwort {{GESCHUETZT_A}}" → B). Erst B
    // auflösen, dann das darin wieder auftauchende A.
    zurueck: (antwort) => originale.reduceRight((t, original, i) => t.split(`{{GESCHUETZT_${buchstabenIndex(i)}}}`).join(original), antwort),
  };
}

/**
 * Was der Client tatsächlich hinausschickt — Anfrage und Verlauf durch den
 * Ausgangsfilter (vorher inline in `client.ts:gefiltert`).
 *
 * Hier und nicht im Client, damit die Prüfreihe dieselbe Funktion aufruft,
 * die der Client aufruft (`tests/api/ki-nutzlast.test.ts`) — ohne Anbieter,
 * ohne `server-only`.
 *
 * **Blockinhalt im Verlauf** (F-15, 2026-09-27): Bisher wurde nur ein
 * Verlaufseintrag mit Text als Zeichenkette gefiltert; ein Eintrag mit
 * Blöcken ging unverändert hinaus. Jetzt werden Textblöcke gefiltert, und
 * ein Block, dessen Inhalt sich nicht filtern lässt (Bild, Dokument), geht
 * gar nicht hinaus — was nicht geprüft werden kann, verlässt das Haus nicht.
 */
export function anfrageFiltern<M extends { content: unknown }>(
  prompt: string,
  verlauf: readonly M[] = [],
): { prompt: string; verlauf: M[]; ersetzungen: Record<string, number> } {
  const p = ausgangsfilter(prompt);
  const summen: Record<string, number>[] = [p.ersetzungen];
  const gefiltert = verlauf.map((m) => {
    if (typeof m.content === 'string') {
      const f = ausgangsfilter(m.content);
      summen.push(f.ersetzungen);
      return { ...m, content: f.text };
    }
    if (!Array.isArray(m.content)) return m;
    const bloecke = (m.content as unknown[]).flatMap((block) => {
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') {
        const f = ausgangsfilter(b.text);
        summen.push(f.ersetzungen);
        return [{ ...b, text: f.text }];
      }
      summen.push({ block_entfernt: 1 });
      return [];
    });
    return { ...m, content: bloecke };
  });
  return { prompt: p.text, verlauf: gefiltert, ersetzungen: summeErsetzungen(...summen) };
}

/** Platzhalter im Ergebnis wieder durch die Namen ersetzen — im eigenen Prozess. */
export function platzhalterZurueck(text: string, namen: Record<string, string | null | undefined>): string {
  let ergebnis = text;
  for (const [platzhalter, name] of Object.entries(namen)) {
    ergebnis = ergebnis.split(`{{${platzhalter}}}`).join(name ?? '');
  }
  return ergebnis;
}

/**
 * Kürzel für Datensätze einer einzelnen Anfrage (A1, A2 …) — dasselbe
 * Verfahren wie in der Personaldisposition. Das Kürzel ist ausserhalb dieser
 * Anfrage bedeutungslos; ein Kürzel, das das Modell erfindet, lässt sich
 * nicht zurückübersetzen und wird verworfen.
 */
export function kuerzel<T extends string>(ids: readonly T[], praefix: string) {
  const hin = new Map<T, string>();
  const zurueck = new Map<string, T>();
  ids.forEach((id, i) => {
    const k = `${praefix}${i + 1}`;
    hin.set(id, k);
    zurueck.set(k, id);
  });
  return {
    hin: (id: T) => hin.get(id) ?? `${praefix}?`,
    zurueck: (k: string) => zurueck.get(k.trim()),
  };
}
