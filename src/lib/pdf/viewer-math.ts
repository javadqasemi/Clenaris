/**
 * Die Rechnung hinter dem PDF-Viewer — ohne DOM, ohne PDF.js.
 *
 * **Warum getrennt von der Komponente.** Zoomgrenzen, „an Breite anpassen"
 * und „ganze Seite" sind die Stellen, an denen ein Viewer leise falsch wird:
 * eine hartcodierte `1.2`, ein Fit, das den Rand vergisst, eine Zoomstufe,
 * die am Telefon unbedienbar ist. Das lässt sich als reine Rechnung prüfen,
 * und eine Prüfung, die einen Browser braucht, wird irgendwann nicht mehr
 * ausgeführt. Die Komponente ruft diese Funktionen und fügt nichts hinzu.
 *
 * Masse sind PDF-Punkte bei Massstab 1 (`originalWidth`/`originalHeight`
 * einer Seite) bzw. CSS-Pixel des sichtbaren Bereichs.
 */

/**
 * Zoomgrenzen. Unter 50 % ist Text auf A4 nicht mehr lesbar, über 400 %
 * wird eine Seite breiter als jedes Telefon hoch ist — und PDF.js rendert
 * Canvas in Gerätepixeln, ein 400-%-Blatt auf einem 3×-Bildschirm ist
 * schon ein grosses Bild.
 */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 4;
/** Schrittweite der Schaltflächen — Viertel, damit 100 % immer erreichbar ist. */
export const ZOOM_STEP = 0.25;

/** Innenabstand des Anzeigebereichs, der beim Anpassen frei bleibt. */
export const FIT_GUTTER_PX = 16;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/**
 * Auf die nächste Stufe über bzw. unter dem aktuellen Wert.
 *
 * Nicht `zoom + STEP`: Nach einem „an Breite anpassen" steht der Wert auf
 * etwas wie 1.37, und ein Schritt soll dann auf 1.5 gehen, nicht auf 1.62 —
 * sonst wandert die Anzeige durch krumme Prozentzahlen, die niemand meint.
 */
export function zoomIn(zoom: number): number {
  const naechste = Math.floor(zoom / ZOOM_STEP + 1e-9) * ZOOM_STEP + ZOOM_STEP;
  return clampZoom(Number(naechste.toFixed(4)));
}

export function zoomOut(zoom: number): number {
  const vorherige = Math.ceil(zoom / ZOOM_STEP - 1e-9) * ZOOM_STEP - ZOOM_STEP;
  return clampZoom(Number(vorherige.toFixed(4)));
}

export interface FitMasse {
  /** Sichtbare Breite des Anzeigebereichs in CSS-Pixeln. */
  containerWidth: number;
  /** Sichtbare Höhe — nur für „ganze Seite" nötig. */
  containerHeight?: number;
  /** Seitenbreite in PDF-Punkten bei Massstab 1. */
  pageWidth: number;
  /** Seitenhöhe in PDF-Punkten bei Massstab 1. */
  pageHeight?: number;
  /** Freier Rand je Seite; Vorgabe `FIT_GUTTER_PX`. */
  gutter?: number;
}

/**
 * Massstab, bei dem die Seite die verfügbare Breite füllt.
 *
 * `null`, wenn die Masse noch nicht bekannt sind — etwa vor dem ersten
 * Rendern oder bei einem zusammengeklappten Container. Der Aufrufer behält
 * dann den bisherigen Wert, statt auf 0 zu springen und PDF.js mit einer
 * Nullbreite rendern zu lassen.
 */
export function fitWidthScale(m: FitMasse): number | null {
  const gutter = m.gutter ?? FIT_GUTTER_PX;
  const nutzbar = m.containerWidth - 2 * gutter;
  if (!(nutzbar > 0) || !(m.pageWidth > 0)) return null;
  return clampZoom(nutzbar / m.pageWidth);
}

/**
 * Massstab, bei dem die ganze Seite sichtbar ist — Breite *und* Höhe.
 *
 * Bei Querformat entscheidet die Breite, bei Hochformat meist die Höhe;
 * die Rechnung nimmt einfach das Minimum und braucht die Unterscheidung
 * nicht zu kennen.
 */
export function fitPageScale(m: FitMasse): number | null {
  const gutter = m.gutter ?? FIT_GUTTER_PX;
  const breite = m.containerWidth - 2 * gutter;
  const hoehe = (m.containerHeight ?? 0) - 2 * gutter;
  if (!(breite > 0) || !(hoehe > 0) || !(m.pageWidth > 0) || !((m.pageHeight ?? 0) > 0)) {
    return null;
  }
  return clampZoom(Math.min(breite / m.pageWidth, hoehe / (m.pageHeight as number)));
}

/** Seitenzahl in den gültigen Bereich holen; ungültige Eingaben bleiben, wo sie sind. */
export function clampPage(page: number, total: number, fallback = 1): number {
  if (!Number.isInteger(page) || total < 1) return fallback;
  return Math.min(total, Math.max(1, page));
}

/** Prozentwert für die Anzeige — gerundet, damit 1.37 nicht als 137.000001 erscheint. */
export function zoomPercent(zoom: number): number {
  return Math.round(zoom * 100);
}
