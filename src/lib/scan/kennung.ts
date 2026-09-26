/**
 * Was ein Scan geliefert hat — reine Zerlegung, ohne Datenbank (Scanplattform,
 * 2026-09-26).
 *
 * ---------------------------------------------------------------------------
 *  Die Grundhaltung: Ein Scan ist eine fremde Eingabe
 * ---------------------------------------------------------------------------
 *
 * Was eine Kamera oder ein Handscanner liefert, hat niemand in der Firma
 * geschrieben. Ein QR-Code auf einem Paket, ein Aufkleber, den jemand über
 * das eigene Etikett geklebt hat, ein Code auf einem Bildschirm — er kann
 * `javascript:…`, eine Phishing-Adresse, 4000 Zeichen oder Steuerzeichen
 * enthalten. Deshalb tut diese Datei genau eines: Sie **ordnet ein**. Sie
 * öffnet nichts, folgt keiner Adresse, führt nichts aus, und sie gibt keine
 * Datenbank-ID zurück. Was daraus wird, entscheidet der Server in
 * `scan.service.ts` mit Anmeldung, Mandant und Leserecht — und was danach
 * geschieht, entscheidet ein Mensch mit einem Klick, den der Server noch
 * einmal prüft.
 *
 * Die Reihenfolge der Prüfungen ist Absicht: erst die eigenen Formate mit
 * fester Gestalt (Etikettcode, QR-Rechnung, Strichcode mit Prüfziffer), dann
 * Adressen, zuletzt freier Text. Ein Etikettcode sieht mit `CLX1:` wie ein
 * Schema aus; stünde die Adressprüfung vorne, würde er als fremde Adresse
 * abgewiesen.
 *
 * ---------------------------------------------------------------------------
 *  Welche Formate — und was „unterstützt" heisst
 * ---------------------------------------------------------------------------
 *
 * Unterstützt heisst hier: `tests/api/scan-kennung.test.ts` beweist die
 * Zerlegung mit festen Beispielen. Das sind der eigene Etikettcode, EAN-13,
 * EAN-8, UPC-A, GTIN-14 (je mit Prüfziffer), die Schweizer QR-Rechnung
 * (SPC 0200) und freier Text für Nummern (Artikel-, Inventar-, Einsatz-,
 * Rechnungs-, Kundennummer). **Nicht** unterstützt sind GS1-Elementstrings mit
 * Anwendungskennzeichen (`(01)…(17)…`), vCards, WLAN-Codes und alles andere —
 * sie fallen in „Text" oder „Adresse" und führen zu keinem Datensatz, ausser
 * ihr ganzer Text ist zufällig exakt eine Nummer. Welche Formate die Kamera
 * *erkennt*, ist eine Frage des Browsers (`BarcodeDetector`), nicht dieser
 * Datei.
 */

/** Längster Text, der überhaupt angenommen wird. Eine QR-Rechnung hat höchstens 997 Zeichen. */
export const SCAN_MAX_LAENGE = 1000;

/** Vorsatz des eigenen Etikettcodes; die Ziffer ist die Version des Formats. */
export const INTERN_PRAEFIX = 'CLX1:';

/**
 * Crockford-Base32 ohne I, L, O, U — keine Verwechslung von 1/I/L und 0/O
 * beim Abtippen eines beschädigten Etiketts.
 */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 20 Zeichen × 5 Bit = 100 Bit Zufall — nicht zu erraten, auch nicht in Serie. */
export const CODE_LAENGE = 20;

export type GtinFormat = 'EAN_13' | 'EAN_8' | 'UPC_A' | 'GTIN_14';

export type ScanEingabe =
  | { art: 'INTERN'; code: string }
  | { art: 'GTIN'; gtin: string; format: GtinFormat }
  | { art: 'QR_RECHNUNG'; referenz: string | null; rechnungsnummer: string | null }
  | { art: 'QR_REFERENZ'; referenz: string }
  | { art: 'ADRESSE'; schema: string }
  | { art: 'TEXT'; text: string }
  | { art: 'UNGUELTIG'; grund: string };

const INTERN_MUSTER = new RegExp(`^CLX1:([${CODE_ALPHABET}]{${CODE_LAENGE}})$`);
// Steuerzeichen ausser Tab, Zeilenvorschub, Wagenrücklauf. Die drei kommen
// von Handscannern (Abschlusstaste) und aus der QR-Rechnung (Zeilen).
// eslint-disable-next-line no-control-regex
const STEUERZEICHEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/;

/** Prüfziffer nach GS1 (Modulo 10, Gewichte 3/1 von rechts). */
export function gs1PruefzifferGueltig(ziffern: string): boolean {
  if (!/^\d+$/.test(ziffern) || ziffern.length < 2) return false;
  const koerper = ziffern.slice(0, -1);
  let summe = 0;
  for (let i = 0; i < koerper.length; i += 1) {
    const ziffer = Number(koerper[koerper.length - 1 - i]);
    summe += ziffer * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (summe % 10)) % 10 === Number(ziffern[ziffern.length - 1]);
}

/**
 * Prüfziffer der 27-stelligen QR-Referenz (Modulo 10 rekursiv, wie die
 * ESR-Referenz). Nur damit wird eine lange Ziffernfolge als Referenz gelesen
 * und nicht als irgendeine Zahl.
 */
export function qrReferenzGueltig(ref: string): boolean {
  if (!/^\d{27}$/.test(ref)) return false;
  const tabelle = [0, 9, 4, 6, 8, 2, 7, 1, 3, 5];
  let uebertrag = 0;
  for (const z of ref.slice(0, 26)) uebertrag = tabelle[(uebertrag + Number(z)) % 10]!;
  return (10 - uebertrag) % 10 === Number(ref[26]);
}

/**
 * Einheitliche Form eines Herstellerstrichcodes: UPC-A (12) wird mit
 * führender Null zu EAN-13, ein GTIN-14 mit führender Null ebenso. So findet
 * derselbe Artikel sich, gleich ob die Kamera ihn als UPC-A oder EAN-13
 * gelesen hat. Liefert `null`, wenn es kein gültiger Strichcode ist.
 */
export function gtinNormalisieren(roh: string): { gtin: string; format: GtinFormat } | null {
  const z = roh.trim();
  if (!/^\d+$/.test(z) || !gs1PruefzifferGueltig(z)) return null;
  switch (z.length) {
    case 8:
      return { gtin: z, format: 'EAN_8' };
    case 12:
      return { gtin: `0${z}`, format: 'UPC_A' };
    case 13:
      return { gtin: z, format: 'EAN_13' };
    case 14:
      return z.startsWith('0') ? { gtin: z.slice(1), format: 'GTIN_14' } : { gtin: z, format: 'GTIN_14' };
    default:
      return null;
  }
}

function qrRechnungLesen(zeilen: string[]): ScanEingabe {
  // SIX Implementation Guidelines QR-Rechnung 2.3, Abschnitt 4.2: Die
  // Referenzart steht an Position 28, die Referenz an 29, die unstrukturierte
  // Mitteilung an 30 (hier nullbasiert 27, 28, 29). Unsere eigenen Rechnungen
  // tragen mit QR-IBAN die QR-Referenz, sonst „Rechnung <Nummer>" als
  // Mitteilung (`src/lib/pdf/render.ts`).
  if (zeilen[1] !== '0200') return { art: 'UNGUELTIG', grund: 'QR-Rechnung in einer nicht unterstützten Version.' };
  const referenzArt = zeilen[27] ?? '';
  const referenz = (zeilen[28] ?? '').replace(/\s/g, '');
  const mitteilung = zeilen[29] ?? '';
  const nummer = /^Rechnung (\S{1,40})$/.exec(mitteilung.trim())?.[1] ?? null;
  return {
    art: 'QR_RECHNUNG',
    referenz: referenzArt === 'QRR' && qrReferenzGueltig(referenz) ? referenz : null,
    rechnungsnummer: nummer,
  };
}

/** Den gescannten oder eingefügten Text einordnen — ohne irgendetwas nachzuschlagen. */
export function scanEinordnen(roh: string): ScanEingabe {
  if (typeof roh !== 'string') return { art: 'UNGUELTIG', grund: 'Keine Zeichenfolge.' };
  if (roh.length > SCAN_MAX_LAENGE) return { art: 'UNGUELTIG', grund: `Länger als ${SCAN_MAX_LAENGE} Zeichen.` };
  if (STEUERZEICHEN.test(roh)) return { art: 'UNGUELTIG', grund: 'Enthält Steuer- oder Richtungszeichen.' };

  // Die QR-Rechnung ist mehrzeilig; alles andere ist eine Zeile, und die
  // Abschlusstaste eines Handscanners (\r, \n) gehört nicht zum Inhalt.
  const zeilen = roh.replace(/\r\n?/g, '\n').split('\n');
  if (zeilen[0]?.trim() === 'SPC') return qrRechnungLesen(zeilen.map((z) => z.trim()));

  const text = roh.trim();
  if (!text) return { art: 'UNGUELTIG', grund: 'Leer.' };
  if (/[\n\t]/.test(text)) return { art: 'UNGUELTIG', grund: 'Mehrzeiliger Inhalt, der keine QR-Rechnung ist.' };

  const intern = INTERN_MUSTER.exec(text.toUpperCase());
  if (intern) return { art: 'INTERN', code: intern[1]! };
  if (/^CLX\d*:/i.test(text)) return { art: 'UNGUELTIG', grund: 'Beschädigter oder unbekannter Clenaris-Code.' };

  const gtin = gtinNormalisieren(text);
  if (gtin) return { art: 'GTIN', ...gtin };
  const ohneLeer = text.replace(/\s/g, '');
  if (qrReferenzGueltig(ohneLeer)) return { art: 'QR_REFERENZ', referenz: ohneLeer };

  // Jede Form „schema:…" und „www.…" ist eine Adresse. Sie wird weder
  // geöffnet noch als Link dargestellt — auch `https:` nicht: Ein Etikett, das
  // auf eine fremde Anmeldeseite zeigt, ist der naheliegendste Angriff auf
  // eine Scanfunktion.
  const schema = /^([a-z][a-z0-9+.-]{0,31}):/i.exec(text)?.[1];
  if (schema) return { art: 'ADRESSE', schema: schema.toLowerCase() };
  if (/^www\./i.test(text)) return { art: 'ADRESSE', schema: 'www' };

  if (text.length > 120) return { art: 'UNGUELTIG', grund: 'Zu lang für eine Nummer und kein bekanntes Format.' };
  return { art: 'TEXT', text };
}

/** Der Inhalt eines eigenen Etiketts — nie mehr als Vorsatz und Code. */
export function internerInhalt(code: string): string {
  return `${INTERN_PRAEFIX}${code}`;
}

/**
 * Kurze, sichere Anzeige dessen, was gescannt wurde: gekürzt, eine Zeile.
 * Dargestellt wird sie von React als Text — maskiert, nie als HTML.
 */
export function scanAnzeige(roh: string): string {
  const eineZeile = roh.replace(/\s+/g, ' ').trim();
  return eineZeile.length > 80 ? `${eineZeile.slice(0, 79)}…` : eineZeile;
}
