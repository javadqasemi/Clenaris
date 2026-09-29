/**
 * Visitenkarte (vCard) der Firma — für den QR-Code auf `/kontakt` und den
 * Download „Kontakt speichern" (Teil I, 2026-09-28).
 *
 * ---------------------------------------------------------------------------
 *  Warum vCard 3.0 und nicht 4.0
 * ---------------------------------------------------------------------------
 *
 * vCard 4.0 (RFC 6350) ist neuer, aber die eingebauten Kamera-Scanner lesen
 * ihn uneinheitlich: iOS öffnet 3.0 und 4.0, mehrere Android-Kameras und
 * Google Lens erkennen nur 3.0 zuverlässig als Kontakt und zeigen 4.0 als
 * Rohtext. 3.0 (RFC 2426) ist das kleinste gemeinsame Vielfache — und
 * braucht nichts, was 4.0 besser könnte.
 *
 * ---------------------------------------------------------------------------
 *  Was hineinkommt — und was bewusst nicht
 * ---------------------------------------------------------------------------
 *
 * Nur, was die Website ohnehin öffentlich zeigt (Fusszeile, Kontaktseite):
 * Firmenname, Telefon, E-Mail, Website, Postadresse. **Nicht** hinein:
 * IBAN, MWST-Nummer (öffentlich auf Rechnungen, aber auf einer Visitenkarte
 * ohne Zweck, und was ohne Zweck weitergegeben wird, ist Datensparsamkeit
 * zuwider), Namen von Mitarbeitenden, interne Notizen. Die Eingabe dieser
 * Funktion kennt diese Felder gar nicht — sie lassen sich nicht aus
 * Versehen durchreichen, auch wenn der Aufrufer das ganze
 * `PublicCompanyInfo` in der Hand hält.
 *
 * ---------------------------------------------------------------------------
 *  Format
 * ---------------------------------------------------------------------------
 *
 *  • Zeilenende CRLF (RFC 2426 §2.4.2 über RFC 2425); iOS nimmt auch LF an,
 *    mehrere Android-Leser nicht.
 *  • Textwerte maskiert: `\` → `\\`, `,` → `\,`, `;` → `\;`, Zeilenumbruch
 *    → `\n`. Sonst wird aus „Musterstrasse 1; 2. Stock" in `ADR` ein
 *    zusätzliches Adressfeld.
 *  • Zeilen über 75 **Oktette** werden gefaltet (CRLF + Leerzeichen), ohne
 *    ein UTF-8-Zeichen zu zerschneiden — „Zürich" hat 7 Zeichen, aber 8
 *    Oktette.
 *  • `CHARSET=UTF-8` nur an Zeilen mit Nicht-ASCII-Zeichen. In 3.0 ist der
 *    Parameter eigentlich Sache des MIME-Rahmens; ein QR-Code hat keinen,
 *    und ältere Android-Leser dekodieren ohne ihn als Latin-1 („ZÃ¼rich").
 *    An reinen ASCII-Zeilen ist er Rauschen und wird weggelassen.
 */

export interface VcardFirma {
  name: string;
  legalName?: string | null;
  phone?: string | null;
  email?: string | null;
  /** Adresse der Website — nur `http(s)`, sonst entfällt die Zeile. */
  url?: string | null;
  address?: {
    street?: string | null;
    postalCode?: string | null;
    city?: string | null;
    canton?: string | null;
    country?: string | null;
  } | null;
}

const CRLF = '\r\n';
const MAX_OKTETTE = 75;

/** Textwert nach RFC 2426 §4 maskieren. */
export function vcardText(wert: string): string {
  return wert
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

const encoder = new TextEncoder();

function oktette(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Eine logische Zeile in physische Zeilen zu höchstens 75 Oktetten falten.
 * Die Folgezeilen beginnen mit einem Leerzeichen, das zu ihren 75 Oktetten
 * zählt. Geschnitten wird nur zwischen ganzen Zeichen (Codepunkten).
 */
export function zeileFalten(zeile: string): string {
  if (oktette(zeile) <= MAX_OKTETTE) return zeile;
  const teile: string[] = [];
  let aktuell = '';
  let groesse = 0;
  for (const zeichen of zeile) {
    const laenge = oktette(zeichen);
    // Die erste physische Zeile hat 75 Oktette, jede weitere 74 plus Leerzeichen.
    const grenze = teile.length === 0 ? MAX_OKTETTE : MAX_OKTETTE - 1;
    if (groesse + laenge > grenze) {
      teile.push(aktuell);
      aktuell = '';
      groesse = 0;
    }
    aktuell += zeichen;
    groesse += laenge;
  }
  teile.push(aktuell);
  return teile.join(`${CRLF} `);
}

function istAscii(text: string): boolean {
  // eslint-disable-next-line no-control-regex -- geprüft wird genau der ASCII-Bereich
  return /^[\x00-\x7F]*$/.test(text);
}

/** `NAME;PARAM:WERT` — mit `CHARSET=UTF-8`, wo der Wert es braucht. */
function eigenschaft(name: string, parameter: string[], wert: string): string {
  const alle = istAscii(wert) ? parameter : [...parameter, 'CHARSET=UTF-8'];
  return zeileFalten(`${[name, ...alle].join(';')}:${wert}`);
}

function sauber(wert: string | null | undefined): string {
  return (wert ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Telefonnummer international schreiben: Schweizer Inlandsformat
 * („031 123 45 67") wird zu „+41311234567". Ein Scanner im Ausland kann mit
 * der führenden Null nichts anfangen, und `tel:` braucht keine Leerzeichen.
 * Was keine Ziffernfolge ist, fällt weg.
 */
export function telefonInternational(nummer: string | null | undefined): string | null {
  const roh = sauber(nummer);
  if (!roh) return null;
  // „+41 (0)31 …": Die eingeklammerte Null gilt nur bei Inlandswahl und fällt weg.
  let ziffern = roh.replace(/\(0\)/g, '').replace(/[^\d+]/g, '');
  if (ziffern.startsWith('00')) ziffern = `+${ziffern.slice(2)}`;
  else if (ziffern.startsWith('0')) ziffern = `+41${ziffern.slice(1)}`;
  if (!/^\+?\d{6,15}$/.test(ziffern)) return null;
  return ziffern;
}

function emailAdresse(wert: string | null | undefined): string | null {
  const email = sauber(wert);
  return /^[^\s@;,:<>"\\]+@[^\s@;,:<>"\\]+\.[^\s@;,:<>"\\]+$/.test(email) ? email : null;
}

function webAdresse(wert: string | null | undefined): string | null {
  const roh = sauber(wert);
  if (!roh) return null;
  try {
    const url = new URL(roh);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

const LAENDER: Record<string, string> = { CH: 'Schweiz', LI: 'Liechtenstein', DE: 'Deutschland', AT: 'Österreich' };

/**
 * Die vCard als Zeichenkette, CRLF-getrennt, mit abschliessendem CRLF.
 * Dieselbe Zeichenkette geht in den QR-Code und in die `.vcf`-Datei.
 */
export function vcardErzeugen(firma: VcardFirma): string {
  const name = sauber(firma.name);
  const organisation = sauber(firma.legalName) || name;
  const zeilen: string[] = ['BEGIN:VCARD', 'VERSION:3.0'];

  // `N` ist in 3.0 Pflicht. Für eine Firma bleibt der Personenname leer;
  // `X-ABShowAs:COMPANY` sagt iOS, die Karte als Firma statt als leere
  // Person anzuzeigen. Andere Leser ignorieren den Zusatz.
  zeilen.push('N:;;;;');
  zeilen.push(eigenschaft('FN', [], vcardText(name)));
  zeilen.push(eigenschaft('ORG', [], vcardText(organisation)));
  zeilen.push('X-ABShowAs:COMPANY');

  const telefon = telefonInternational(firma.phone);
  if (telefon) zeilen.push(eigenschaft('TEL', ['TYPE=WORK,VOICE'], telefon));

  const email = emailAdresse(firma.email);
  if (email) zeilen.push(eigenschaft('EMAIL', ['TYPE=INTERNET,WORK'], email));

  const url = webAdresse(firma.url);
  if (url) zeilen.push(eigenschaft('URL', [], url));

  const adresse = firma.address;
  if (adresse && (sauber(adresse.street) || sauber(adresse.city))) {
    const land = sauber(adresse.country);
    // ADR: Postfach;Adresszusatz;Strasse;Ort;Region;PLZ;Land
    const felder = [
      '',
      '',
      sauber(adresse.street),
      sauber(adresse.city),
      sauber(adresse.canton),
      sauber(adresse.postalCode),
      LAENDER[land] ?? land,
    ].map(vcardText);
    zeilen.push(eigenschaft('ADR', ['TYPE=WORK'], felder.join(';')));
  }

  zeilen.push('END:VCARD');
  return zeilen.join(CRLF) + CRLF;
}

/**
 * Dateiname für den Download: ASCII, ohne Anführungszeichen und Pfadzeichen,
 * damit er im `Content-Disposition`-Kopf nichts einschleusen kann.
 * „Clenaris Reinigungen GmbH" → „Clenaris-Reinigungen-GmbH.vcf".
 */
export function vcardDateiname(name: string): string {
  const basis = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${basis || 'kontakt'}.vcf`;
}
