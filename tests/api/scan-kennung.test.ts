import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  gs1PruefzifferGueltig,
  gtinNormalisieren,
  qrReferenzGueltig,
  scanAnzeige,
  scanEinordnen,
  SCAN_MAX_LAENGE,
} from '../../src/lib/scan/kennung';

/**
 * Die Einordnung eines Scans mit festen Beispielen (Scanplattform,
 * 2026-09-26).
 *
 * Direkt importiert wie die anderen Rechenkerne: Ob „4006381333931" eine
 * gültige EAN-13 ist, ist Rechnung, keine Frage an einen Server. Diese Datei
 * ist zugleich die Liste dessen, was als „unterstützt" gelten darf — ein
 * Format, das hier nicht steht, wird nirgends zugesagt (`docs/SCANNER.md`).
 * Die HTTP-Seite — Mandant, Rechte, Schnellaktionen — steht in `scan.test.ts`.
 */

/** Eine QR-Rechnung nach SIX 2.3 mit 31 Zeilen; Referenz und Mitteilung frei wählbar. */
function qrRechnung(referenzArt: string, referenz: string, mitteilung: string, trenner = '\n'): string {
  const zeilen = [
    'SPC', '0200', '1', 'CH4431999123000889012',
    'S', 'Clenaris AG', 'Bahnhofplatz', '1', '3011', 'Bern', 'CH',
    '', '', '', '', '', '', '',
    '1234.50', 'CHF',
    'S', 'Kunde AG', 'Weg', '2', '3000', 'Bern', 'CH',
    referenzArt, referenz, mitteilung, 'EPD',
  ];
  return zeilen.join(trenner);
}

describe('Prüfziffern', () => {
  it('GS1: bekannte gültige und ungültige Nummern', () => {
    assert.equal(gs1PruefzifferGueltig('4006381333931'), true); // EAN-13
    assert.equal(gs1PruefzifferGueltig('4006381333932'), false);
    assert.equal(gs1PruefzifferGueltig('96385074'), true); // EAN-8
    assert.equal(gs1PruefzifferGueltig('036000291452'), true); // UPC-A
    assert.equal(gs1PruefzifferGueltig('abc'), false);
  });

  it('QR-Referenz: Modulo 10 rekursiv', () => {
    assert.equal(qrReferenzGueltig('210000000003139471430009017'), true);
    assert.equal(qrReferenzGueltig('210000000003139471430009018'), false);
    assert.equal(qrReferenzGueltig('21000000000313947143000901'), false);
  });
});

describe('Strichcodes', () => {
  it('EAN-13, EAN-8, UPC-A und GTIN-14 werden erkannt und vereinheitlicht', () => {
    assert.deepEqual(gtinNormalisieren('4006381333931'), { gtin: '4006381333931', format: 'EAN_13' });
    assert.deepEqual(gtinNormalisieren('96385074'), { gtin: '96385074', format: 'EAN_8' });
    // UPC-A und die EAN-13 mit führender Null sind derselbe Artikel.
    assert.deepEqual(gtinNormalisieren('036000291452'), { gtin: '0036000291452', format: 'UPC_A' });
    assert.deepEqual(gtinNormalisieren('00036000291452'), { gtin: '0036000291452', format: 'GTIN_14' });
    assert.deepEqual(gtinNormalisieren('10036000291459'), { gtin: '10036000291459', format: 'GTIN_14' });
  });

  it('falsche Prüfziffer oder Länge ist kein Strichcode', () => {
    assert.equal(gtinNormalisieren('4006381333932'), null);
    assert.equal(gtinNormalisieren('123456789'), null);
    assert.equal(scanEinordnen('4006381333932').art, 'TEXT');
  });

  it('scanEinordnen liefert GTIN mit Format', () => {
    assert.deepEqual(scanEinordnen(' 4006381333931\r\n'), { art: 'GTIN', gtin: '4006381333931', format: 'EAN_13' });
  });
});

describe('Eigener Etikettcode', () => {
  it('CLX1: mit 20 Zeichen Crockford-Base32', () => {
    assert.deepEqual(scanEinordnen('CLX1:0123456789ABCDEFGHJK'), { art: 'INTERN', code: '0123456789ABCDEFGHJK' });
    // Kleinbuchstaben vom Abtippen gelten als dieselben Zeichen.
    assert.deepEqual(scanEinordnen('clx1:0123456789abcdefghjk'), { art: 'INTERN', code: '0123456789ABCDEFGHJK' });
  });

  it('beschädigt, zu kurz, fremdes Alphabet oder andere Version: ungültig, nie eine Adresse', () => {
    for (const roh of ['CLX1:0123', 'CLX1:0123456789ABCDEFGHJI', 'CLX1:0123456789ABCDEFGHJKX', 'CLX2:0123456789ABCDEFGHJK']) {
      assert.equal(scanEinordnen(roh).art, 'UNGUELTIG', roh);
    }
  });
});

describe('Schweizer QR-Rechnung', () => {
  it('liest QR-Referenz und Rechnungsnummer aus der Mitteilung', () => {
    assert.deepEqual(scanEinordnen(qrRechnung('QRR', '21 00000 00003 13947 14300 09017', '')), {
      art: 'QR_RECHNUNG',
      referenz: '210000000003139471430009017',
      rechnungsnummer: null,
    });
    assert.deepEqual(scanEinordnen(qrRechnung('NON', '', 'Rechnung RE-2026-00042', '\r\n')), {
      art: 'QR_RECHNUNG',
      referenz: null,
      rechnungsnummer: 'RE-2026-00042',
    });
  });

  it('eine QR-Referenz mit falscher Prüfziffer wird nicht verwendet', () => {
    const e = scanEinordnen(qrRechnung('QRR', '210000000003139471430009018', ''));
    assert.equal(e.art === 'QR_RECHNUNG' && e.referenz, null);
  });

  it('andere Version: ungültig', () => {
    assert.equal(scanEinordnen(qrRechnung('NON', '', '').replace('0200', '0100')).art, 'UNGUELTIG');
  });

  it('die nackte QR-Referenz (27 Ziffern) wird als solche erkannt', () => {
    assert.deepEqual(scanEinordnen('210000000003139471430009017'), { art: 'QR_REFERENZ', referenz: '210000000003139471430009017' });
  });
});

describe('Fremde und feindliche Inhalte', () => {
  it('jede Adresse ist eine Adresse — auch https und javascript', () => {
    assert.deepEqual(scanEinordnen('https://clenaris.example/login'), { art: 'ADRESSE', schema: 'https' });
    assert.deepEqual(scanEinordnen('javascript:alert(1)'), { art: 'ADRESSE', schema: 'javascript' });
    assert.deepEqual(scanEinordnen('JaVaScRiPt:alert(1)'), { art: 'ADRESSE', schema: 'javascript' });
    assert.deepEqual(scanEinordnen('data:text/html,<script>alert(1)</script>'), { art: 'ADRESSE', schema: 'data' });
    assert.deepEqual(scanEinordnen('www.example.com'), { art: 'ADRESSE', schema: 'www' });
  });

  it('Markup bleibt Text — eingeordnet, nicht interpretiert', () => {
    assert.deepEqual(scanEinordnen('<script>alert(1)</script>'), { art: 'TEXT', text: '<script>alert(1)</script>' });
    assert.deepEqual(scanEinordnen("' OR 1=1 --"), { art: 'TEXT', text: "' OR 1=1 --" });
  });

  it('Steuer- und Richtungszeichen: ungültig', () => {
    assert.equal(scanEinordnen('ABC\u0000DEF').art, 'UNGUELTIG');
    assert.equal(scanEinordnen('ABC\u001dDEF').art, 'UNGUELTIG'); // GS1-Trenner
    assert.equal(scanEinordnen('RE-2026‮-0001').art, 'UNGUELTIG'); // Rechts-nach-links-Umschaltung
  });

  it('zu lang: ungültig; mehrzeilig ohne SPC: ungültig; leer: ungültig', () => {
    assert.equal(scanEinordnen('A'.repeat(SCAN_MAX_LAENGE + 1)).art, 'UNGUELTIG');
    assert.equal(scanEinordnen('A'.repeat(121)).art, 'UNGUELTIG');
    assert.equal(scanEinordnen('Zeile 1\nZeile 2').art, 'UNGUELTIG');
    assert.equal(scanEinordnen('   ').art, 'UNGUELTIG');
  });

  it('eine Nummer bleibt eine Nummer', () => {
    assert.deepEqual(scanEinordnen('RE-2026-00001'), { art: 'TEXT', text: 'RE-2026-00001' });
    assert.deepEqual(scanEinordnen('GR-0003'), { art: 'TEXT', text: 'GR-0003' });
  });

  it('die Anzeige ist einzeilig und gekürzt', () => {
    assert.equal(scanAnzeige('a\nb\tc'), 'a b c');
    assert.equal(scanAnzeige('x'.repeat(200)).length, 80);
  });
});
