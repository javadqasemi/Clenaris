import 'server-only';

/**
 * Dateiformate an ihren Bytes erkennen.
 *
 * **Warum das nötig wurde.** Bis Gate 2 prüfte die Anwendung ausschliesslich,
 * was der Client über seine Datei *behauptete*: `mimeType` und `sizeBytes`
 * kamen aus dem Formular, wurden gegen das Upload-Profil gehalten und danach
 * als Tatsache behandelt. Beides ist frei wählbar. Eine beliebige Datei als
 * `application/pdf` anzumelden kostete nichts, und niemand sah je nach.
 *
 * **Was hier bewusst nicht passiert.** Dies ist keine Formatprüfung, sondern
 * eine Signaturprüfung. `%PDF-` am Anfang beweist, dass die Datei als PDF
 * gemeint ist — nicht, dass sie unbeschädigt, geschweige denn ungefährlich
 * ist. Ein PDF kann JavaScript, eingebettete Dateien und fehlerhafte
 * Objektbäume enthalten, und nichts davon sieht man an den ersten acht Bytes.
 * Eine strukturelle Prüfung braucht einen echten Parser; sie gehört zum
 * Viewer und damit in einen späteren Schritt. Bis dahin gilt ausdrücklich:
 *
 *   `Signatur gültig` ≠ `Datei sicher`.
 *
 * **Warum kein Fremdpaket.** Die einschlägigen Bibliotheken erkennen über
 * hundert Formate. Erlaubt sind hier neun MIME-Typen. Jedes zusätzlich
 * erkannte Format ist eine zusätzliche Angriffsfläche für den Erkenner
 * selbst, und eine Abhängigkeit, die bei jedem Upload mitläuft, sollte nicht
 * mehr können als gebraucht wird.
 */

/** Ein erkanntes Format — bewusst gröber als MIME, siehe `OOXML`/`OLE2`. */
export type ErkanntesFormat =
  | 'pdf'
  | 'jpeg'
  | 'png'
  | 'webp'
  | 'gif'
  | 'avif'
  | 'heic'
  | 'zip'
  | 'ole2';

/**
 * Wie viele Bytes der Anfang für eine sichere Erkennung hergeben muss.
 * Der längste Test greift bis Byte 12 (ISO-BMFF-Marke).
 */
const KOPF_BYTES = 16;

function beginntMit(bytes: Buffer, muster: number[], ab = 0): boolean {
  if (bytes.length < ab + muster.length) return false;
  return muster.every((b, i) => bytes[ab + i] === b);
}

function zeichen(bytes: Buffer, ab: number, laenge: number): string {
  if (bytes.length < ab + laenge) return '';
  return bytes.subarray(ab, ab + laenge).toString('latin1');
}

/**
 * Die ISO-Basismediendatei — Container für AVIF und HEIC.
 *
 * Aufbau: vier Bytes Boxlänge, dann `ftyp`, dann die Marke. Die Marke
 * entscheidet, welches Format tatsächlich vorliegt; `mif1` benutzen beide,
 * kommt in freier Wildbahn aber fast nur von HEIC-Kameras.
 */
const AVIF_MARKEN = new Set(['avif', 'avis']);
const HEIC_MARKEN = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

/**
 * Das Format anhand der Bytes bestimmen — `null`, wenn keine bekannte
 * Signatur passt.
 *
 * `null` heisst nicht „harmlos", sondern „keines der neun Formate, die diese
 * Anwendung kennt". Für Textdateien ist genau das das erwartete Ergebnis;
 * sie haben keine Signatur (siehe `istSignaturlos`).
 */
export function erkenneFormat(bytes: Buffer): ErkanntesFormat | null {
  if (bytes.length < 4) return null;

  if (beginntMit(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // %PDF-
  if (beginntMit(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (beginntMit(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (zeichen(bytes, 0, 4) === 'RIFF' && zeichen(bytes, 8, 4) === 'WEBP') return 'webp';
  if (zeichen(bytes, 0, 6) === 'GIF87a' || zeichen(bytes, 0, 6) === 'GIF89a') return 'gif';

  if (zeichen(bytes, 4, 4) === 'ftyp') {
    const marke = zeichen(bytes, 8, 4);
    if (AVIF_MARKEN.has(marke)) return 'avif';
    if (HEIC_MARKEN.has(marke)) return 'heic';
  }

  // OOXML (docx, xlsx) ist ein ZIP-Archiv. `0304` ist ein normaler Eintrag,
  // `0506` ein leeres und `0708` ein geteiltes Archiv — die letzten beiden
  // sind als Dokument unbrauchbar, aber sie sind ZIP und sollen nicht als
  // „unbekannt" durchrutschen.
  if (
    beginntMit(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    beginntMit(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    beginntMit(bytes, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return 'zip';
  }

  // Die alten Office-Formate (.doc, .xls) im OLE2-Verbunddokument.
  if (beginntMit(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole2';

  return null;
}

/**
 * Welches Format ein angemeldeter MIME-Typ haben muss.
 *
 * `docx` und `xlsx` sind beide ZIP, `doc` und `xls` beide OLE2. Die beiden
 * auseinanderzuhalten hiesse, das Archivverzeichnis zu lesen und nach
 * `word/document.xml` bzw. `xl/workbook.xml` zu sehen — ein halber
 * ZIP-Parser für einen Gewinn, den niemand hat: Wer eine Tabelle als
 * Textdokument anmeldet, greift damit nichts an. Der Container wird geprüft,
 * der Inhaltstyp innerhalb des Containers nicht. Das ist die Grenze, und sie
 * steht hier, damit sie später niemand für eine Zusicherung hält.
 */
const MIME_ZU_FORMAT: Record<string, ErkanntesFormat> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'application/msword': 'ole2',
  'application/vnd.ms-excel': 'ole2',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'zip',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'zip',
};

/**
 * Typen ohne Signatur. Eine CSV-Datei beginnt mit dem ersten Feldnamen; es
 * gibt nichts zu prüfen.
 *
 * Für sie gilt die Umkehrung: Sie dürfen *keine* bekannte Binärsignatur
 * tragen. Wer ein PDF als `text/csv` anmeldet, kommt so nicht durch — und
 * mehr lässt sich an dieser Stelle ehrlicherweise nicht behaupten.
 */
const SIGNATURLOS = new Set(['text/plain', 'text/csv']);

export function istSignaturlos(mimeType: string): boolean {
  return SIGNATURLOS.has(mimeType);
}

export interface SignaturBefund {
  passt: boolean;
  erkannt: ErkanntesFormat | null;
  erwartet: ErkanntesFormat | null;
  /** Für Fehlermeldung und Protokoll — nie die Bytes selbst. */
  grund?: string;
}

/**
 * Stimmt der angemeldete Typ mit dem überein, was tatsächlich da ist?
 *
 * Es wird nur der Anfang gelesen; `bytes` darf die ganze Datei sein, muss es
 * aber nicht (siehe `KOPF_BYTES`).
 */
export function pruefeSignatur(mimeType: string, bytes: Buffer): SignaturBefund {
  const erkannt = erkenneFormat(bytes.subarray(0, KOPF_BYTES));

  if (istSignaturlos(mimeType)) {
    if (erkannt === null) return { passt: true, erkannt, erwartet: null };
    return {
      passt: false,
      erkannt,
      erwartet: null,
      grund: `Als Text angemeldet, tatsächlich ${erkannt.toUpperCase()}.`,
    };
  }

  const erwartet = MIME_ZU_FORMAT[mimeType] ?? null;

  // Ein Typ, der weder eine bekannte Signatur noch einen Eintrag in der
  // Signaturlos-Liste hat, gehört nicht in ein Upload-Profil. Dass er hier
  // ankommt, wäre ein Fehler in `profiles.ts` — und wird nicht durchgewunken.
  if (erwartet === null) {
    return {
      passt: false,
      erkannt,
      erwartet: null,
      grund: `Für „${mimeType}" ist keine Signaturprüfung hinterlegt.`,
    };
  }

  if (erkannt === erwartet) return { passt: true, erkannt, erwartet };

  return {
    passt: false,
    erkannt,
    erwartet,
    grund:
      erkannt === null
        ? `Angemeldet als ${erwartet.toUpperCase()}, die Datei trägt aber keine passende Signatur.`
        : `Angemeldet als ${erwartet.toUpperCase()}, tatsächlich ${erkannt.toUpperCase()}.`,
  };
}

/** Wie viele Bytes `pruefeSignatur` höchstens braucht. */
export const SIGNATUR_KOPF_BYTES = KOPF_BYTES;
