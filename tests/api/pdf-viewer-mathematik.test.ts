import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FIT_GUTTER_PX,
  ZOOM_MAX,
  ZOOM_MIN,
  clampPage,
  clampZoom,
  fitPageScale,
  fitWidthScale,
  zoomIn,
  zoomOut,
  zoomPercent,
} from '../../src/lib/pdf/viewer-math';

/**
 * Die Rechnung hinter dem PDF-Viewer — geprüft ohne Browser.
 *
 * Fünfte Datei, die Anwendungscode direkt importiert, aus demselben Grund
 * wie `bi-rechenkerne`: Es ist reine Rechnung. Was der Viewer daraus macht,
 * lässt sich über HTTP nicht beobachten — die Seiten liefern nur die
 * Einbettung, der Viewer entsteht im Browser. Die Stellen, an denen ein
 * Viewer leise falsch wird, sind aber genau diese: ein Fit, das den Rand
 * vergisst, ein Zoom, der am Telefon unbedienbar ist, eine Seitenzahl
 * ausserhalb des Dokuments.
 *
 * A4 hat 595 × 842 Punkte, Querformat entsprechend 842 × 595.
 */

const A4 = { pageWidth: 595, pageHeight: 842 };
const A4_QUER = { pageWidth: 842, pageHeight: 595 };

describe('Zoomgrenzen', () => {
  it('bleiben zwischen Minimum und Maximum', () => {
    assert.equal(clampZoom(0.01), ZOOM_MIN);
    assert.equal(clampZoom(99), ZOOM_MAX);
    assert.equal(clampZoom(1.5), 1.5);
  });

  it('ersetzen Unsinn durch 100 %', () => {
    assert.equal(clampZoom(Number.NaN), 1);
    assert.equal(clampZoom(Number.POSITIVE_INFINITY), 1);
  });

  it('gehen auf die nächste Stufe, nicht um einen Schritt weiter', () => {
    // Nach „an Breite anpassen" steht ein krummer Wert; der nächste Schritt
    // soll auf eine runde Stufe gehen, nicht auf 1.62.
    assert.equal(zoomIn(1.37), 1.5);
    assert.equal(zoomOut(1.37), 1.25);
    assert.equal(zoomIn(1), 1.25);
    assert.equal(zoomOut(1), 0.75);
  });

  it('halten an den Grenzen an', () => {
    assert.equal(zoomIn(ZOOM_MAX), ZOOM_MAX);
    assert.equal(zoomOut(ZOOM_MIN), ZOOM_MIN);
  });

  it('runden für die Anzeige', () => {
    assert.equal(zoomPercent(1.37), 137);
    assert.equal(zoomPercent(0.5), 50);
  });
});

describe('An Breite anpassen', () => {
  it('füllt die verfügbare Breite abzüglich Rand', () => {
    const scale = fitWidthScale({ containerWidth: 595 + 2 * FIT_GUTTER_PX, ...A4 });
    assert.equal(scale, 1);
  });

  it('ist bei schmalem Telefon kleiner als 100 %', () => {
    const scale = fitWidthScale({ containerWidth: 360, ...A4 });
    assert.ok(scale !== null && scale < 1, `Massstab ${scale}`);
    assert.ok(scale !== null && scale >= ZOOM_MIN, 'nicht unter das Minimum');
  });

  it('kennt Querformat', () => {
    const hoch = fitWidthScale({ containerWidth: 1000, ...A4 })!;
    const quer = fitWidthScale({ containerWidth: 1000, ...A4_QUER })!;
    assert.ok(quer < hoch, 'die breitere Seite braucht den kleineren Massstab');
  });

  it('antwortet mit null, solange Masse fehlen', () => {
    assert.equal(fitWidthScale({ containerWidth: 0, ...A4 }), null);
    assert.equal(fitWidthScale({ containerWidth: 800, pageWidth: 0 }), null);
    // Ein Container, der schmaler ist als der doppelte Rand.
    assert.equal(fitWidthScale({ containerWidth: FIT_GUTTER_PX, ...A4 }), null);
  });
});

describe('Ganze Seite', () => {
  it('nimmt bei Hochformat die Höhe als Grenze', () => {
    const scale = fitPageScale({ containerWidth: 1200, containerHeight: 842 + 2 * FIT_GUTTER_PX, ...A4 });
    assert.equal(scale, 1);
  });

  it('nimmt bei Querformat die Breite als Grenze', () => {
    const scale = fitPageScale({ containerWidth: 842 + 2 * FIT_GUTTER_PX, containerHeight: 2000, ...A4_QUER });
    assert.equal(scale, 1);
  });

  it('ist nie grösser als „an Breite"', () => {
    const masse = { containerWidth: 900, containerHeight: 600, ...A4 };
    const seite = fitPageScale(masse)!;
    const breite = fitWidthScale(masse)!;
    assert.ok(seite <= breite, `Seite ${seite} > Breite ${breite}`);
  });

  it('antwortet mit null ohne Höhe', () => {
    assert.equal(fitPageScale({ containerWidth: 900, ...A4 }), null);
    assert.equal(fitPageScale({ containerWidth: 900, containerHeight: 0, ...A4 }), null);
  });
});

describe('Seitenzahl', () => {
  it('bleibt im Dokument', () => {
    assert.equal(clampPage(0, 8), 1);
    assert.equal(clampPage(9, 8), 8);
    assert.equal(clampPage(3, 8), 3);
  });

  it('lässt Unsinn beim Rückfallwert', () => {
    assert.equal(clampPage(Number.NaN, 8, 4), 4);
    assert.equal(clampPage(2.5, 8, 4), 4);
    assert.equal(clampPage(1, 0, 1), 1);
  });
});
