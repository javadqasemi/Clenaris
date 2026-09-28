import QRCode from 'qrcode';

/**
 * QR-Code als SVG-Pfad — serverseitig, ohne fremden Dienst.
 *
 * **Warum ein eigener Pfad statt `QRCode.toString({ type: 'svg' })`.** Die
 * Bibliothek liefert ein fertiges SVG als Zeichenkette; auf die Seite käme
 * es nur über `dangerouslySetInnerHTML`. Der Inhalt wäre zwar harmlos (nur
 * Pfade, kein Text aus der vCard), aber jede solche Stelle muss man einzeln
 * prüfen und später wieder — die Website hat davon genau eine, für JSON-LD.
 * Hier liefert `QRCode.create()` die Modulmatrix, und das SVG entsteht als
 * gewöhnliches JSX mit einem `d`-Attribut, das React maskiert.
 *
 * **Fehlerkorrektur M** (etwa 15 % der Codewörter wiederherstellbar): L wäre
 * kleiner, verzeiht aber einen Knick im Ausdruck oder eine Spiegelung auf
 * dem Bildschirm schlecht; Q und H machen die Visitenkarte bei rund 250
 * Zeichen zu einem dichten Raster, das ein Telefon aus Armlänge nicht mehr
 * sauber auflöst.
 *
 * **Ruhezone 4 Module** — die Norm (ISO/IEC 18004) verlangt vier. Sie gehört
 * ins SVG selbst und ist weiss gefüllt: Auf dunklem Grund (Dunkelmodus) gibt
 * es sonst keinen Kontrast zwischen Rand und Code, und viele Scanner finden
 * die Suchmuster nicht.
 */
export const QR_FEHLERKORREKTUR = 'M' as const;
export const QR_RUHEZONE = 4;

export interface QrSvg {
  /** Kantenlänge des Codes in Modulen, ohne Ruhezone. */
  module: number;
  /** Kantenlänge der `viewBox`, mit Ruhezone auf allen Seiten. */
  kante: number;
  /** `d`-Attribut: ein Rechteck je waagrechter Folge dunkler Module. */
  pfad: string;
  version: number;
}

/**
 * Pfad der dunklen Module. Waagrechte Folgen werden zu einem Rechteck
 * zusammengefasst — das halbiert die Pfadlänge etwa und vermeidet die
 * Haarlinien, die manche Renderer zwischen einzeln gezeichneten, aneinander
 * stossenden Quadraten zeigen.
 */
export function qrSvg(text: string): QrSvg {
  const code = QRCode.create(text, { errorCorrectionLevel: QR_FEHLERKORREKTUR });
  const { size } = code.modules;
  const teile: string[] = [];

  for (let zeile = 0; zeile < size; zeile += 1) {
    let spalte = 0;
    while (spalte < size) {
      if (!code.modules.get(zeile, spalte)) {
        spalte += 1;
        continue;
      }
      const anfang = spalte;
      while (spalte < size && code.modules.get(zeile, spalte)) spalte += 1;
      const x = anfang + QR_RUHEZONE;
      const y = zeile + QR_RUHEZONE;
      teile.push(`M${x} ${y}h${spalte - anfang}v1h-${spalte - anfang}z`);
    }
  }

  return { module: size, kante: size + QR_RUHEZONE * 2, pfad: teile.join(''), version: code.version };
}
